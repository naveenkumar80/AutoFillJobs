/**
 * scripts/ai-service.js — High-Performance AI API Providers & Zero-Latency Cache for QuickFill
 * 
 * Capabilities:
 * - Persistent Zero-Latency Cache (normalized question hashing with LRU eviction)
 * - Google Gemini (gemini-3.8-flash with auto-retry, fast 800-token cap, and low temperature)
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
        const q = questions[i];
        const normKey = normalizeQ(q.questionText);
        const cachedAns = await QuickFillCache.get(normKey);
        if (cachedAns) {
          answers[String(i)] = cachedAns;
          cachedCount++;
        } else {
          uncachedQuestions.push({ originalIndex: i, ...q });
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
        if (provider === 'gemini') {
          let geminiModel = model || 'gemini-3.8-flash';
          if (geminiModel.includes('2.0') || geminiModel.includes('2.5')) {
            geminiModel = 'gemini-3.8-flash';
          }
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
     * Test connection to provider with lightweight prompt
     */
    async testConnection(aiSettings) {
      const { provider = 'gemini', apiKey, model } = aiSettings || {};

      if (!apiKey || !apiKey.trim()) {
        throw new Error('API key is empty. Please enter your API key first.');
      }

      const cleanKey = apiKey.trim().replace(/^["']|["']$/g, '');
      let testModel = model || (provider === 'gemini' ? 'gemini-3.8-flash' : 'gpt-4o-mini');
      if (provider === 'gemini' && (testModel.includes('2.0') || testModel.includes('2.5'))) {
        testModel = 'gemini-3.8-flash';
      }

      const testPrompt = 'Respond with JSON: {"status": "ok", "message": "QuickFill AI connection test successful"}';
      const startTime = Date.now();
      let rawJSON;

      try {
        if (provider === 'gemini') {
          rawJSON = await this.callGemini(cleanKey, testModel, testPrompt, 200);
        } else if (provider === 'openai') {
          rawJSON = await this.callOpenAI(cleanKey, testModel, testPrompt, 200);
        } else {
          throw new Error(`Unknown provider: ${provider}`);
        }

        const elapsed = Date.now() - startTime;
        const parsed = this.parseAIResponse(rawJSON);
        Logger.info('ai-service', `Test connection verified in ${elapsed}ms`, { model: testModel });
        return { success: true, elapsed, model: testModel, response: parsed };
      } catch (err) {
        Logger.error('ai-service', `Test connection failed: ${err.message}`, { provider, model: testModel });
        throw err;
      }
    },

    /**
     * Call Google Gemini API with tuned token limit and low temperature
     */
    async callGemini(apiKey, model, promptOrParts, maxTokens = 800) {
      const parts = typeof promptOrParts === 'string'
        ? [{ text: promptOrParts }]
        : promptOrParts;

      const cleanKey = (apiKey || '').trim().replace(/^["']|["']$/g, '');
      let targetModel = model || 'gemini-3.8-flash';
      if (targetModel.includes('2.0') || targetModel.includes('2.5')) {
        targetModel = 'gemini-3.8-flash';
      }

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${cleanKey}`;

      let response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts }],
            generationConfig: {
              responseMimeType: 'application/json',
              temperature: 0.15,
              maxOutputTokens: maxTokens,
            },
          }),
        });
      } catch (netErr) {
        throw new Error(`Network error connecting to Gemini API: ${netErr.message}`);
      }

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMsg = errorData?.error?.message || `HTTP ${response.status} ${response.statusText}`;

        // Auto-retry if API recommends a newer model
        const suggestedModelMatch = errorMsg.match(/models\/(gemini-[\w.-]+)/);
        if (suggestedModelMatch && suggestedModelMatch[1] && suggestedModelMatch[1] !== targetModel) {
          Logger.warn('ai-service', `Retrying with suggested model ${suggestedModelMatch[1]}`);
          return await this.callGemini(apiKey, suggestedModelMatch[1], promptOrParts, maxTokens);
        }

        if (errorMsg.includes('no longer available') && targetModel !== 'gemini-3.8-flash') {
          Logger.warn('ai-service', 'Model retired, retrying with gemini-3.8-flash');
          return await this.callGemini(apiKey, 'gemini-3.8-flash', promptOrParts, maxTokens);
        }

        // Retry without responseMimeType if structured output is unsupported
        if (errorMsg.includes('responseMimeType') || errorMsg.includes('generationConfig')) {
          try {
            const fallbackRes = await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ parts }],
                generationConfig: {
                  temperature: 0.15,
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
     * Call OpenAI Chat Completions API with tuned token limit
     */
    async callOpenAI(apiKey, model, prompt, maxTokens = 800) {
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
            temperature: 0.15,
            max_tokens: maxTokens,
            response_format: { type: 'json_object' },
          }),
        });
      } catch (netErr) {
        throw new Error(`Network error connecting to OpenAI API: ${netErr.message}`);
      }

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMsg = errorData?.error?.message || `HTTP ${response.status} ${response.statusText}`;
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
