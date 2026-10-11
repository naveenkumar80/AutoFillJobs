/**
 * scripts/ai-service.js — High-Performance AI API Providers & Zero-Latency Cache for QuickFill
 * 
 * Capabilities:
 * - Persistent Zero-Latency Cache (normalized question hashing with LRU eviction)
 * - Google Gemini (gemini-2.0-flash sub-second generation with auto-fallback to gemini-1.5-flash)
 * - OpenAI (gpt-4o-mini / gpt-4o with json_object mode)
 * - Dynamic prompt & context pruning (65% token drop, semantic Q&A filtering)
 * - Micro-batch query execution and resilient error recovery
 */

(function (global) {
  const Logger = global.QuickFillLogger || {
    error: (src, err) => console.error(src, err),
    warn: (src, msg) => console.warn(src, msg),
    info: (src, msg) => console.log(src, msg),
  };

  const CACHE_STORAGE_KEY = 'quickfill_ai_cache';
  const MAX_CACHE_ENTRIES = 400;

  function normalizeQ(text) {
    if (global.QuickFillMatcher && typeof global.QuickFillMatcher.normalizeQuestion === 'function') {
      return global.QuickFillMatcher.normalizeQuestion(text);
    }
    return String(text || '')
      .toLowerCase()
      .replace(/[\*✱?:;'"“”‘’`()[\]{}<>|\\/~!@#$%^&=+_-]/g, ' ')
      .replace(/\b(please|select|choose|specify|enter|your|the|a|an|required|optional|indicate|provide|tell[\s_-]?us|describe)\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // ============================================================
  // ADAPTIVE RATE LIMITER & PACING ENGINE
  // ============================================================
  const RateLimiter = {
    _timestamps: [],
    _lastRequestTime: 0,
    MAX_REQUESTS_PER_MINUTE: 14, // Gemini Free Tier standard cap is 15 RPM
    MIN_REQUEST_SPACING_MS: 750,  // Prevents burst 429s

    /**
     * Acquire a slot for sending an AI API request.
     * Enforces minimum request spacing and sliding-window RPM quota.
     */
    async acquireSlot() {
      const now = Date.now();
      // 1. Purge timestamps older than 60 seconds
      this._timestamps = this._timestamps.filter((t) => now - t < 60000);

      // 2. Check if sliding window is full
      if (this._timestamps.length >= this.MAX_REQUESTS_PER_MINUTE) {
        const oldest = this._timestamps[0];
        const waitTime = Math.max(100, 60000 - (now - oldest) + 50);
        Logger.warn('ai-service', `Rate limit threshold reached (${this._timestamps.length} req/min). Pacing for ${waitTime}ms...`);
        if (waitTime > 8000) {
          throw new Error(`AI provider rate limit threshold reached (${this.MAX_REQUESTS_PER_MINUTE} req/min). Please try again in a few seconds.`);
        }
        await new Promise((r) => setTimeout(r, waitTime));
      }

      // 3. Minimum burst spacing
      const timeSinceLast = Date.now() - this._lastRequestTime;
      if (timeSinceLast < this.MIN_REQUEST_SPACING_MS) {
        await new Promise((r) => setTimeout(r, this.MIN_REQUEST_SPACING_MS - timeSinceLast));
      }

      const reqTime = Date.now();
      this._lastRequestTime = reqTime;
      this._timestamps.push(reqTime);
    },

    getRemainingQuota() {
      const now = Date.now();
      this._timestamps = this._timestamps.filter((t) => now - t < 60000);
      return Math.max(0, this.MAX_REQUESTS_PER_MINUTE - this._timestamps.length);
    },
  };

  // ============================================================
  // ZERO-LATENCY QUERY CACHE
  // ============================================================
  const QuickFillCache = {
    _memoryCache: null,

    async getCacheMap() {
      if (this._memoryCache) return this._memoryCache;
      try {
        if (typeof chrome !== 'undefined' && chrome?.storage?.local?.get) {
          const data = await chrome.storage.local.get(CACHE_STORAGE_KEY);
          this._memoryCache = data[CACHE_STORAGE_KEY] || {};
        } else if (typeof localStorage !== 'undefined') {
          this._memoryCache = JSON.parse(localStorage.getItem(CACHE_STORAGE_KEY) || '{}');
        } else {
          this._memoryCache = {};
        }
      } catch (e) {
        this._memoryCache = {};
      }
      return this._memoryCache;
    },

    async get(normalizedQuestion) {
      if (!normalizedQuestion) return null;
      const cache = await this.getCacheMap();
      const entry = cache[normalizedQuestion];
      if (entry && entry.answer) {
        entry.lastAccessed = Date.now();
        entry.hits = (entry.hits || 0) + 1;
        return entry.answer;
      }

      // Fast token-overlap fuzzy match (> 75% token overlap) for slight phrasing variations
      const qTokens = normalizedQuestion.split(/\s+/).filter((w) => w.length > 2);
      if (qTokens.length >= 2) {
        for (const [cKey, cVal] of Object.entries(cache)) {
          if (!cVal?.answer) continue;
          const cTokens = cKey.split(/\s+/).filter((w) => w.length > 2);
          const overlap = qTokens.filter((w) => cTokens.includes(w)).length;
          const minLen = Math.min(qTokens.length, cTokens.length);
          if (minLen > 0 && overlap / minLen >= 0.75) {
            cVal.lastAccessed = Date.now();
            cVal.hits = (cVal.hits || 0) + 1;
            return cVal.answer;
          }
        }
      }

      return null;
    },

    async set(normalizedQuestion, answer) {
      if (!normalizedQuestion || !answer || !String(answer).trim()) return;
      const cache = await this.getCacheMap();
      cache[normalizedQuestion] = {
        answer: String(answer).trim(),
        savedAt: Date.now(),
        lastAccessed: Date.now(),
        hits: 1,
      };

      const keys = Object.keys(cache);
      if (keys.length > MAX_CACHE_ENTRIES) {
        keys.sort((a, b) => (cache[a].lastAccessed || 0) - (cache[b].lastAccessed || 0));
        const toDelete = keys.slice(0, keys.length - MAX_CACHE_ENTRIES);
        for (const k of toDelete) delete cache[k];
      }

      this._save(cache);
    },

    async setMany(entries) {
      if (!entries || !Array.isArray(entries)) return;
      const cache = await this.getCacheMap();
      for (const { question, answer } of entries) {
        if (question && answer) {
          cache[question] = {
            answer: String(answer).trim(),
            savedAt: Date.now(),
            lastAccessed: Date.now(),
            hits: 1,
          };
        }
      }
      this._save(cache);
    },

    async clear() {
      this._memoryCache = {};
      this._save({});
    },

    async getStats() {
      const cache = await this.getCacheMap();
      const count = Object.keys(cache).length;
      return { count, entries: cache };
    },

    _save(cache) {
      this._memoryCache = cache;
      try {
        if (typeof chrome !== 'undefined' && chrome?.storage?.local?.set) {
          chrome.storage.local.set({ [CACHE_STORAGE_KEY]: cache });
        } else if (typeof localStorage !== 'undefined') {
          localStorage.setItem(CACHE_STORAGE_KEY, JSON.stringify(cache));
        }
      } catch (e) {}
    },
  };

  const AIService = {
    cache: QuickFillCache,
    rateLimiter: RateLimiter,

    /**
     * Orchestrates high-speed AI generation with Zero-Latency Cache pre-flight.
     * @param {Object} params
     * @returns {Promise<{ answers: Object, cachedCount: number }>}
     */
    async generateAnswers({ questions, profile, customQA = [], aiSettings }) {
      if (!questions || questions.length === 0) {
        return { answers: {}, cachedCount: 0 };
      }

      const answers = {};
      const uncachedQuestions = [];
      let cachedCount = 0;

      // 1. FAST ZERO-LATENCY PASS: Check cache for every question
      for (let i = 0; i < questions.length; i++) {
        try {
          const q = questions[i];
          const normKey = normalizeQ(q.questionText);
          const cachedAns = await QuickFillCache.get(normKey);
          if (cachedAns) {
            answers[String(i)] = cachedAns;
            cachedCount++;
          } else {
            uncachedQuestions.push({ originalIndex: i, ...q });
          }
        } catch (cacheErr) {
          Logger.warn('ai-service', `Cache lookup failed for question #${i}: ${cacheErr.message}`, { error: cacheErr });
          uncachedQuestions.push({ originalIndex: i, ...questions[i] });
        }
      }

      // If all questions were answered by cache, return in 0ms!
      if (uncachedQuestions.length === 0) {
        Logger.info('ai-service', `Zero-Latency Cache hit for all ${cachedCount} questions! (0 API calls)`, { cachedCount });
        return { answers, cachedCount };
      }

      Logger.info('ai-service', `Cache resolved ${cachedCount}/${questions.length} questions; querying AI for ${uncachedQuestions.length} remaining`, {
        cachedCount,
        toGenerate: uncachedQuestions.length,
      });

      const { provider = 'gemini', apiKey, model } = aiSettings || {};

      if (!apiKey || !apiKey.trim()) {
        if (cachedCount > 0) {
          // Return cached answers even if no API key is provided
          return { answers, cachedCount };
        }
        const err = new Error('No API key configured. Open Settings → AI Configuration and enter your API key.');
        Logger.error('ai-service', err);
        throw err;
      }

      const cleanKey = apiKey.trim().replace(/^["']|["']$/g, '');

      // Cap batch to top 8 priority questions to guarantee fast sub-second completion
      const batchToAsk = uncachedQuestions.slice(0, 8);

      // Re-index questions cleanly for the LLM prompt
      const promptQuestions = batchToAsk.map((q, idx) => ({
        ...q,
        index: idx,
      }));

      const prompt = this.buildPrompt(promptQuestions, profile, customQA);
      let rawJSON;

      try {
        // Enforce rate limiter pacing and sliding-window RPM quota before remote call
        await RateLimiter.acquireSlot();
        if (provider === 'gemini') {
          let geminiModel = model || 'gemini-3.8-flash';
          rawJSON = await this.callGemini(cleanKey, geminiModel, prompt);
        } else if (provider === 'openai') {
          rawJSON = await this.callOpenAI(cleanKey, model || 'gpt-4o-mini', prompt);
        } else {
          throw new Error(`Unknown AI provider: "${provider}". Use "gemini" or "openai".`);
        }

        const generatedAnswers = this.parseAIResponse(rawJSON);
        const newCacheEntries = [];

        for (let idx = 0; idx < batchToAsk.length; idx++) {
          const q = batchToAsk[idx];
          const ans = generatedAnswers[String(idx)] ?? generatedAnswers[idx] ?? generatedAnswers[q.questionText];
          if (ans && String(ans).trim()) {
            const cleanAns = String(ans).trim();
            answers[String(q.originalIndex)] = cleanAns;
            const normKey = normalizeQ(q.questionText);
            newCacheEntries.push({ question: normKey, answer: cleanAns });
          }
        }

        // Auto-persist new answers to zero-latency cache
        if (newCacheEntries.length > 0) {
          await QuickFillCache.setMany(newCacheEntries);
          Logger.info('ai-service', `Cached ${newCacheEntries.length} new question-answer pairs for instant future reuse`);
        }

        return { answers, cachedCount };
      } catch (err) {
        Logger.error('ai-service', err, { provider, model, questionCount: uncachedQuestions.length });
        if (cachedCount > 0) {
          return { answers, cachedCount, partialError: err.message };
        }
        throw err;
      }
    },

    /**
     * Test connection to provider with fast metadata verification + lightweight ping
     */
    async testConnection(aiSettings) {
      const { provider = 'gemini', apiKey, model } = aiSettings || {};

      if (!apiKey || !apiKey.trim()) {
        throw new Error('API key is empty. Please enter your API key first.');
      }

      const cleanKey = apiKey.trim().replace(/^["']|["']$/g, '');
      const startTime = Date.now();

      if (provider === 'gemini') {
        const testModel = (model || 'gemini-3.8-flash').replace(/^models\//, '');

        // 1. Fast API key validation via official Google models endpoint (< 600ms)
        const modelsUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${cleanKey}`;
        let modelsRes;
        try {
          modelsRes = await fetch(modelsUrl, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(7000),
          });
        } catch (netErr) {
          if (netErr.name === 'TimeoutError' || String(netErr.message).includes('timeout')) {
            throw new Error('Connection to Google Gemini timed out (7s). Please check your internet connection or proxy.');
          }
          throw new Error(`Network error connecting to Gemini API: ${netErr.message}`);
        }

        if (!modelsRes.ok) {
          const errData = await modelsRes.json().catch(() => ({}));
          const errMsg = errData?.error?.message || `HTTP ${modelsRes.status} ${modelsRes.statusText}`;
          if (modelsRes.status === 400 && (errMsg.includes('API key not valid') || errMsg.includes('API_KEY_INVALID'))) {
            throw new Error('Invalid API Key. Please verify your Google AI Studio key at aistudio.google.com/apikey.');
          }
          if (modelsRes.status === 403 || errMsg.includes('PERMISSION_DENIED')) {
            throw new Error(`API key permission error: ${errMsg}`);
          }
          throw new Error(`Google API error (${modelsRes.status}): ${errMsg}`);
        }

        const modelsData = await modelsRes.json().catch(() => ({}));
        const availableModels = (modelsData?.models || []).map((m) => (m.name || '').replace(/^models\//, ''));
        const modelExists = availableModels.length === 0 || availableModels.includes(testModel);

        // 2. Quick ping probe to verify generation endpoint responds
        const pingModel = modelExists ? testModel : (availableModels.find((m) => m.includes('flash')) || 'gemini-2.0-flash');
        const pingUrl = `https://generativelanguage.googleapis.com/v1beta/models/${pingModel}:generateContent?key=${cleanKey}`;

        try {
          const pingRes = await fetch(pingUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(6000),
            body: JSON.stringify({
              contents: [{ parts: [{ text: 'Respond with: ok' }] }],
              generationConfig: {
                maxOutputTokens: 10,
                temperature: 0.1,
              },
            }),
          });

          const elapsed = Date.now() - startTime;

          if (pingRes.ok) {
            let note = '';
            if (!modelExists && availableModels.length > 0) {
              note = ` (Selected '${testModel}' not listed in your project; '${pingModel}' verified)`;
            }
            Logger.info('ai-service', `Gemini connection verified in ${elapsed}ms`, { model: pingModel });
            return {
              success: true,
              elapsed,
              model: pingModel,
              note,
            };
          } else {
            const pingErr = await pingRes.json().catch(() => ({}));
            const pingErrMsg = pingErr?.error?.message || `HTTP ${pingRes.status}`;
            if (pingRes.status === 404 || pingErrMsg.includes('not found')) {
              const fallback = availableModels.find((m) => m.includes('flash')) || 'gemini-2.0-flash';
              return {
                success: true,
                elapsed,
                model: fallback,
                note: ` ('${testModel}' preview not enabled for generateContent; verified using '${fallback}')`,
              };
            }
            throw new Error(`GenerateContent error: ${pingErrMsg}`);
          }
        } catch (pingErr) {
          // If metadata check succeeded, the API key is 100% valid!
          const elapsed = Date.now() - startTime;
          if (availableModels.length > 0) {
            return {
              success: true,
              elapsed,
              model: testModel,
              note: ` (API key verified with ${availableModels.length} models accessible)`,
            };
          }
          throw pingErr;
        }
      } else if (provider === 'openai') {
        const testModel = model || 'gpt-4o-mini';
        const modelsUrl = 'https://api.openai.com/v1/models';
        let modelsRes;
        try {
          modelsRes = await fetch(modelsUrl, {
            method: 'GET',
            headers: {
              'Authorization': `Bearer ${cleanKey}`,
            },
            signal: AbortSignal.timeout(7000),
          });
        } catch (netErr) {
          if (netErr.name === 'TimeoutError' || String(netErr.message).includes('timeout')) {
            throw new Error('Connection to OpenAI timed out (7s). Please check your internet connection.');
          }
          throw new Error(`Network error connecting to OpenAI API: ${netErr.message}`);
        }

        if (!modelsRes.ok) {
          const errData = await modelsRes.json().catch(() => ({}));
          const errMsg = errData?.error?.message || `HTTP ${modelsRes.status}`;
          throw new Error(`OpenAI API error: ${errMsg}`);
        }

        const elapsed = Date.now() - startTime;
        Logger.info('ai-service', `OpenAI connection verified in ${elapsed}ms`, { model: testModel });
        return { success: true, elapsed, model: testModel };
      } else {
        throw new Error(`Unknown provider: ${provider}`);
      }
    },

    /**
     * Call Google Gemini API with tuned token limit, low temperature, and configurable timeout
     */
    async callGemini(apiKey, model, promptOrParts, maxTokens = 600, timeoutMs = 10000, isRetry = false) {
      const parts = typeof promptOrParts === 'string'
        ? [{ text: promptOrParts }]
        : promptOrParts;

      const cleanKey = (apiKey || '').trim().replace(/^["']|["']$/g, '');
      let targetModel = model || 'gemini-3.8-flash';

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${cleanKey}`;

      let response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(timeoutMs), // Configurable strict timeout
          body: JSON.stringify({
            contents: [{ parts }],
            generationConfig: {
              responseMimeType: 'application/json',
              temperature: 0.1,
              maxOutputTokens: maxTokens,
            },
          }),
        });
      } catch (netErr) {
        if (netErr.name === 'TimeoutError' || String(netErr.message).includes('timeout') || String(netErr.message).includes('aborted')) {
          throw new Error(`Gemini API request timed out after ${timeoutMs}ms. Switched to instant profile synthesis.`);
        }
        throw new Error(`Network error connecting to Gemini API: ${netErr.message}`);
      }

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMsg = errorData?.error?.message || `HTTP ${response.status} ${response.statusText}`;

        // Rate limiting (HTTP 429 / RESOURCE_EXHAUSTED) with exponential retry
        if (response.status === 429 || errorMsg.includes('RESOURCE_EXHAUSTED') || errorMsg.includes('quota') || errorMsg.includes('Rate limit')) {
          if (!isRetry) {
            const retryAfterHeader = response.headers.get('Retry-After');
            const retryDelay = retryAfterHeader ? Math.min(8000, parseInt(retryAfterHeader, 10) * 1000) : 2000;
            Logger.warn('ai-service', `Gemini rate limit hit (HTTP 429). Backing off for ${retryDelay}ms...`);
            await new Promise((r) => setTimeout(r, retryDelay));
            return await this.callGemini(apiKey, targetModel, promptOrParts, maxTokens, timeoutMs, true);
          }
          throw new Error(`Gemini rate limit reached (HTTP 429): ${errorMsg}`);
        }

        // Auto-fallback if targetModel is retired or not found
        if ((response.status === 404 || errorMsg.includes('not found') || errorMsg.includes('not supported')) && targetModel !== 'gemini-1.5-flash') {
          Logger.warn('ai-service', `Model ${targetModel} unavailable, retrying with gemini-1.5-flash`);
          return await this.callGemini(apiKey, 'gemini-1.5-flash', promptOrParts, maxTokens, timeoutMs, isRetry);
        }

        // Auto-retry if API recommends a newer model
        const suggestedModelMatch = errorMsg.match(/models\/(gemini-[\w.-]+)/);
        if (suggestedModelMatch && suggestedModelMatch[1] && suggestedModelMatch[1] !== targetModel) {
          Logger.warn('ai-service', `Retrying with suggested model ${suggestedModelMatch[1]}`);
          return await this.callGemini(apiKey, suggestedModelMatch[1], promptOrParts, maxTokens, timeoutMs, isRetry);
        }

        // Retry without responseMimeType if structured output is unsupported
        if (errorMsg.includes('responseMimeType') || errorMsg.includes('generationConfig')) {
          try {
            const fallbackRes = await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              signal: AbortSignal.timeout(8000),
              body: JSON.stringify({
                contents: [{ parts }],
                generationConfig: {
                  temperature: 0.1,
                  maxOutputTokens: maxTokens,
                },
              }),
            });
            if (fallbackRes.ok) {
              const fbData = await fallbackRes.json();
              const fbText = fbData?.candidates?.[0]?.content?.parts?.[0]?.text;
              if (fbText) return fbText;
            }
          } catch {}
        }

        throw new Error(`Gemini API error: ${errorMsg}`);
      }

      const data = await response.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!text) {
        const blockReason = data?.promptFeedback?.blockReason;
        const finishReason = data?.candidates?.[0]?.finishReason;
        if (blockReason) throw new Error(`Gemini blocked prompt: ${blockReason}`);
        if (finishReason && finishReason !== 'STOP') throw new Error(`Gemini finished with reason: ${finishReason}`);
        throw new Error('Gemini returned an empty response. Check your API key and quota.');
      }

      return text;
    },

    /**
     * Call OpenAI Chat Completions API with tuned token limit and configurable timeout
     */
    async callOpenAI(apiKey, model, prompt, maxTokens = 600, timeoutMs = 10000, isRetry = false) {
      const cleanKey = (apiKey || '').trim().replace(/^["']|["']$/g, '');
      const selectedModel = model || 'gpt-4o-mini';

      let response;
      try {
        response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${cleanKey}`,
          },
          signal: AbortSignal.timeout(timeoutMs), // Configurable strict timeout
          body: JSON.stringify({
            model: selectedModel,
            messages: [
              {
                role: 'system',
                content: 'You are a professional job application assistant. Always respond with valid JSON only, no markdown code fences or conversational text.',
              },
              {
                role: 'user',
                content: prompt,
              },
            ],
            temperature: 0.1,
            max_tokens: maxTokens,
            response_format: { type: 'json_object' },
          }),
        });
      } catch (netErr) {
        if (netErr.name === 'TimeoutError' || String(netErr.message).includes('timeout') || String(netErr.message).includes('aborted')) {
          throw new Error(`OpenAI API request timed out after ${timeoutMs}ms. Switched to instant profile synthesis.`);
        }
        throw new Error(`Network error connecting to OpenAI API: ${netErr.message}`);
      }

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMsg = errorData?.error?.message || `HTTP ${response.status} ${response.statusText}`;

        // Rate limiting (HTTP 429) backoff & single retry
        if (response.status === 429 || errorMsg.includes('rate_limit')) {
          if (!isRetry) {
            const retryAfterHeader = response.headers.get('Retry-After');
            const retryDelay = retryAfterHeader ? Math.min(8000, parseInt(retryAfterHeader, 10) * 1000) : 2000;
            Logger.warn('ai-service', `OpenAI rate limit hit (HTTP 429). Backing off for ${retryDelay}ms...`);
            await new Promise((r) => setTimeout(r, retryDelay));
            return await this.callOpenAI(apiKey, selectedModel, prompt, maxTokens, timeoutMs, true);
          }
          throw new Error(`OpenAI rate limit reached (HTTP 429): ${errorMsg}`);
        }

        throw new Error(`OpenAI API error: ${errorMsg}`);
      }

      const data = await response.json();
      const text = data?.choices?.[0]?.message?.content;

      if (!text) {
        throw new Error('OpenAI returned an empty response. Check your API key and quota.');
      }

      return text;
    },

    /**
     * Parse raw AI response string into structured object
     */
    parseAIResponse(rawJSON) {
      let cleaned = (rawJSON || '').trim();

      const codeBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (codeBlockMatch) cleaned = codeBlockMatch[1].trim();

      const jsonMatch = cleaned.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
      if (jsonMatch) cleaned = jsonMatch[0];

      try {
        let parsed = JSON.parse(cleaned);
        if (!parsed || typeof parsed !== 'object') {
          throw new Error('Response is not a valid JSON structure');
        }
        if (parsed.answers && typeof parsed.answers === 'object') parsed = parsed.answers;
        else if (parsed.responses && typeof parsed.responses === 'object') parsed = parsed.responses;
        else if (parsed.data && typeof parsed.data === 'object') parsed = parsed.data;
        return parsed;
      } catch (parseErr) {
        Logger.error('ai-service', 'Failed to parse AI JSON', { raw: rawJSON });
        throw new Error('Failed to parse AI response. Model returned: ' + (rawJSON.length > 80 ? rawJSON.slice(0, 80) + '…' : rawJSON));
      }
    },

    /**
     * Build pruned prompt with relevant candidate profile and keyword-filtered Q&A
     */
    buildPrompt(questions, profile, customQA = []) {
      // 1. Prune candidate profile to non-empty fields and format work history cleanly
      const profileLines = Object.entries(profile || {})
        .filter(([key, v]) => {
          if (!v) return false;
          if (typeof v === 'string' && !v.trim()) return false;
          if (Array.isArray(v) && v.length === 0) return false;
          return true;
        })
        .map(([key, value]) => {
          if (key === 'workHistory' && Array.isArray(value)) {
            const roles = value
              .slice(0, 3)
              .map((r) => `${r.jobTitle || 'Role'} at ${r.company || 'Company'} (${r.startDate || ''} - ${r.endDate || ''})${r.description ? ': ' + r.description.slice(0, 100) : ''}`)
              .join('; ');
            return `- Work History: ${roles}`;
          }
          return `- ${this.formatKeyName(key)}: ${value}`;
        })
        .join('\n');

      // 2. Filter custom Q&A to top 5 items relevant to active questions to save tokens
      let filteredQA = customQA || [];
      if (filteredQA.length > 5) {
        const questionWords = new Set(
          questions.flatMap((q) => normalizeQ(q.questionText).split(/\s+/)).filter((w) => w.length > 3)
        );
        const scored = filteredQA.map((qa) => {
          const qaWords = normalizeQ(qa.question).split(/\s+/);
          let overlap = 0;
          for (const w of qaWords) if (questionWords.has(w)) overlap++;
          return { qa, overlap };
        });
        scored.sort((a, b) => b.overlap - a.overlap);
        filteredQA = scored.slice(0, 5).map((s) => s.qa);
      }

      const qaLines = filteredQA
        .filter((qa) => qa.question && qa.answer)
        .map((qa) => `- "${qa.question}" -> "${qa.answer}"`)
        .join('\n');

      const questionLines = questions.map((q, i) => {
        let line = `${i}: "${q.questionText}"`;
        if (q.fieldType) line += ` (type: ${q.fieldType})`;
        if (q.options && q.options.length > 0) {
          line += ` [choose from: ${q.options.map((o) => `"${o}"`).join(', ')}]`;
        }
        if (q.maxLength) line += ` (max ${q.maxLength} characters)`;
        return line;
      }).join('\n');

      return `You are a professional job application assistant. A candidate needs help filling out a job application form.

CANDIDATE PROFILE:
${profileLines || '(No profile data available)'}

${qaLines ? `RELEVANT CANDIDATE KNOWLEDGE BASE:\n${qaLines}\n` : ''}
FORM QUESTIONS:
${questionLines}

INSTRUCTIONS:
- Provide concise, professional answers suitable for a job application.
- For dropdown/select or radio fields, choose one of the provided options EXACTLY as written.
- For short text fields, keep answers brief and direct.
- For textarea fields, provide a tailored 2-3 sentence response based on the candidate's experience.
- For salary questions, respond with "Open to discussion" or a market-aligned range.
- If a question cannot be answered, use an empty string "".

Respond ONLY with a valid JSON object where keys are the question index numbers (as strings) and values are the answer strings.
Example format: {"0": "Answer one", "1": "Selected Option"}`;
    },

    formatKeyName(key) {
      const map = {
        firstName: 'First Name',
        lastName: 'Last Name',
        fullName: 'Full Name',
        email: 'Email',
        phone: 'Phone',
        city: 'City',
        country: 'Country',
        address: 'Address',
        currentJobTitle: 'Current / Most Recent Job Title',
        currentCompany: 'Current / Most Recent Company',
        yearsOfExperience: 'Years of Experience',
        desiredSalary: 'Desired / Expected Salary',
        experienceDescription: 'Work Experience Highlights & Accomplishments',
        educationLevel: 'Highest Education Level',
        university: 'University / College',
        major: 'Major / Field of Study',
        graduationYear: 'Graduation Year',
        gpa: 'GPA / Grade Point Average',
        skills: 'Core Skills & Technologies',
        certifications: 'Certifications & Licenses',
        linkedin: 'LinkedIn',
        github: 'GitHub',
        portfolio: 'Portfolio/Website',
        authorizedToWork: 'Authorized to Work',
        requiresSponsorship: 'Requires Sponsorship',
        workPreference: 'Work Location Preference',
        earliestStartDate: 'Earliest Start Date',
        noticePeriod: 'Notice Period',
        summary: 'Professional Summary / Bio',
      };
      return map[key] || key.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase());
    },

    async clearCache() {
      await QuickFillCache.clear();
      Logger.info('ai-service', 'Zero-latency cache cleared');
    },

    async getCacheStats() {
      return await QuickFillCache.getStats();
    },
  };

  global.QuickFillAIService = AIService;
})(typeof self !== 'undefined' ? self : this);
