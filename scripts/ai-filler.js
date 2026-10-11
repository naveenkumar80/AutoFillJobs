/**
 * scripts/ai-filler.js — In-Page AI Question Collector & Form Dispatcher
 * 
 * Part of QuickFill Form Automation System.
 * Responsibilities:
 * - Scans remaining unfilled form elements (radios, selects, checkboxes, textareas, inputs)
 * - Extracts question prompts, candidate options, and field constraints
 * - Prioritizes questions into high-speed micro-batches (textareas and selects first)
 * - Dispatches questions to background AI service
 * - Populates form elements with AI-generated answers
 * - Persists newly answered questions to Knowledge Base and Zero-Latency Cache
 */

(function (global) {
  const Logger = global.QuickFillLogger || {
    error: (src, err) => console.error(src, err),
    warn: (src, msg) => console.warn(src, msg),
    info: (src, msg) => console.log(src, msg),
  };

  const DOM = global.QuickFillDOM;
  const Matcher = global.QuickFillMatcher;

  // Rate limiting, concurrency guard, and timeouts
  let _isGenerating = false;
  let _lastFillTimestamp = 0;
  const MIN_FILL_COOLDOWN_MS = 1500;
  const EXTENSION_MESSAGE_TIMEOUT_MS = 12000;

  /**
   * Send message to background script with strict timeout to prevent hanging indefinitely
   */
  function sendMessageWithTimeout(message, timeoutMs = EXTENSION_MESSAGE_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      let completed = false;
      const timer = setTimeout(() => {
        if (!completed) {
          completed = true;
          const timeoutErr = new Error(`Extension message response timed out after ${timeoutMs}ms`);
          Logger.warn('ai-filler', timeoutErr.message);
          reject(timeoutErr);
        }
      }, timeoutMs);

      try {
        if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
          clearTimeout(timer);
          const availErr = new Error('chrome.runtime.sendMessage is not available');
          Logger.error('ai-filler', availErr.message);
          return reject(availErr);
        }

        chrome.runtime.sendMessage(message, (response) => {
          if (completed) return;
          completed = true;
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            const runtimeErr = new Error(chrome.runtime.lastError.message);
            Logger.error('ai-filler', `chrome.runtime.sendMessage runtime error: ${runtimeErr.message}`);
            reject(runtimeErr);
          } else {
            resolve(response);
          }
        });
      } catch (err) {
        if (!completed) {
          completed = true;
          clearTimeout(timer);
          Logger.error('ai-filler', `chrome.runtime.sendMessage threw exception: ${err.message}`, { err });
          reject(err);
        }
      }
    });
  }

  const AIFiller = {
    /**
     * Scan unfilled elements and gather question metadata.
     * @param {HTMLElement[]} allElements
     * @param {Set<HTMLElement>} filledElements
     * @returns {{ questionsToAsk: Array, targetElements: Array }}
     */
    collectUnmatchedQuestions(allElements, filledElements) {
      const questionsToAsk = [];
      const targetElements = [];
      const processedRadioGroups = new Set();

      for (const el of allElements) {
        try {
          if (!DOM.isVisible(el)) continue;
          if (el.type === 'file' || el.type === 'password' || el.type === 'submit' || el.type === 'button' || el.type === 'reset' || el.type === 'image' || el.type === 'hidden') continue;
          if (el.readOnly || el.disabled) continue;
          if (filledElements.has(el) || DOM.isAlreadyFilled(el)) continue;

          // Skip captcha, honeypots, or search inputs
          const elName = (el.name || '').toLowerCase();
          const elId = (el.id || '').toLowerCase();
          if (/captcha|recaptcha|turnstile|cf[-_]challenge|search/i.test(elName) || /captcha|recaptcha|turnstile|search/i.test(elId)) {
            continue;
          }

          // 1. Radio Group
          if (el.type === 'radio') {
            const groupName = el.name;
            if (!groupName || processedRadioGroups.has(groupName)) continue;
            processedRadioGroups.add(groupName);

            const radios = document.querySelectorAll(`input[type="radio"][name="${CSS.escape(groupName)}"]`);
            const hasChecked = Array.from(radios).some((r) => r.checked);
            if (hasChecked) continue;

            const qText = Matcher.findRadioGroupQuestionText(el, radios);
            if (!qText) continue;

            const options = [];
            radios.forEach((r) => {
              const label = DOM.findLabelText(r) || r.value;
              if (label && !options.includes(label)) options.push(label.trim());
            });

            const qIndex = questionsToAsk.length;
            questionsToAsk.push({
              index: qIndex,
              questionText: qText,
              fieldType: 'radio',
              options,
            });
            targetElements.push({ type: 'radio', element: el });
            continue;
          }

          // 2. Select Dropdown
          if (el.tagName === 'SELECT') {
            const qText = Matcher.findFieldQuestionText(el);
            if (!qText) continue;

            const options = Array.from(el.options)
              .map((opt) => (opt.text || opt.value || '').trim())
              .filter((t) => t && !/^(select|choose|please select|--)/i.test(t));

            const qIndex = questionsToAsk.length;
            questionsToAsk.push({
              index: qIndex,
              questionText: qText,
              fieldType: 'select',
              options,
            });
            targetElements.push({ type: 'select', element: el });
            continue;
          }

          // 3. Checkbox
          if (el.type === 'checkbox') {
            const qText = Matcher.findFieldQuestionText(el);
            if (!qText) continue;

            const qIndex = questionsToAsk.length;
            questionsToAsk.push({
              index: qIndex,
              questionText: qText,
              fieldType: 'checkbox',
              options: ['Yes', 'No'],
            });
            targetElements.push({ type: 'checkbox', element: el });
            continue;
          }

          // 4. Textarea or Text Input
          if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
            const qText = Matcher.findFieldQuestionText(el);
            if (!qText) continue;

            const isTextarea = el.tagName === 'TEXTAREA';
            const maxLength = el.maxLength > 0 && el.maxLength < 100000 ? el.maxLength : undefined;

            const qIndex = questionsToAsk.length;
            questionsToAsk.push({
              index: qIndex,
              questionText: qText,
              fieldType: isTextarea ? 'textarea' : 'text',
              maxLength,
            });
            targetElements.push({ type: isTextarea ? 'textarea' : 'input', element: el });
            continue;
          }
        } catch (collectErr) {
          Logger.warn('ai-filler', `Error collecting question from field element: ${collectErr.message}`, {
            name: el?.name,
            id: el?.id,
            tag: el?.tagName,
            error: collectErr,
          });
        }
      }

      return { questionsToAsk, targetElements };
    },

    /**
     * Prioritize questions into a fast micro-batch.
     * @param {Array} questionsToAsk
     * @param {Array} targetElements
     * @param {number} [maxBatchSize=8]
     * @returns {{ questionsBatch: Array, batchTargets: Array }}
     */
    prioritizeQuestions(questionsToAsk, targetElements, maxBatchSize = 8) {
      try {
        const paired = questionsToAsk.map((q, idx) => ({
          question: q,
          target: targetElements[idx],
        }));

        // Prioritize high-value fields: textareas first (3), then selects/radios (2), then short text (1)
        paired.sort((a, b) => {
          const getPriority = (item) => {
            if (item?.question?.fieldType === 'textarea') return 3;
            if (item?.question?.fieldType === 'select' || item?.question?.fieldType === 'radio') return 2;
            return 1;
          };
          return getPriority(b) - getPriority(a);
        });

        const microBatch = paired.slice(0, maxBatchSize);
        const questionsBatch = microBatch.map((item, idx) => ({
          ...item.question,
          index: idx,
        }));
        const batchTargets = microBatch.map((item) => item.target);

        return { questionsBatch, batchTargets };
      } catch (err) {
        Logger.error('ai-filler', `Failed to prioritize questions: ${err.message}`, { error: err });
        return {
          questionsBatch: questionsToAsk.slice(0, maxBatchSize),
          batchTargets: targetElements.slice(0, maxBatchSize),
        };
      }
    },

    /**
     * Fill unmatched fields using AI with micro-batching and persistent caching.
     * @param {HTMLElement[]} allElements
     * @param {Set<HTMLElement>} filledElements
     * @param {Object} profile
     * @param {Object} aiSettings
     * @param {Array} customQA
     * @returns {Promise<{ aiFilled: number, error?: string, newSavedQA?: Array }>}
     */
    async fillUnmatchedWithAI(allElements, filledElements, profile, aiSettings, customQA = []) {
      // 1. Concurrency guard: prevent multiple overlapping AI fill executions
      if (_isGenerating) {
        Logger.warn('ai-filler', 'AI form filling is already active, ignoring overlapping call');
        return { aiFilled: 0, pending: true };
      }

      // 2. Debounce: enforce minimum spacing between fill requests
      const now = Date.now();
      if (now - _lastFillTimestamp < MIN_FILL_COOLDOWN_MS) {
        const paceDelay = MIN_FILL_COOLDOWN_MS - (now - _lastFillTimestamp);
        Logger.info('ai-filler', `Rate limit pacing active, waiting ${paceDelay}ms...`);
        await new Promise((r) => setTimeout(r, paceDelay));
      }

      _isGenerating = true;
      _lastFillTimestamp = Date.now();

      try {
        const { questionsToAsk, targetElements } = this.collectUnmatchedQuestions(allElements, filledElements);

        if (questionsToAsk.length === 0) {
          return { aiFilled: 0 };
        }

        const { questionsBatch, batchTargets } = this.prioritizeQuestions(questionsToAsk, targetElements, 8);
        Logger.info('ai-filler', `Dispatching micro-batch of ${questionsBatch.length} prioritized questions to AI`);

        let answers = {};
        let aiError = null;

        try {
          const response = await sendMessageWithTimeout({
            action: 'AI_GENERATE',
            questions: questionsBatch,
            profile,
            customQA,
            aiSettings,
          }, EXTENSION_MESSAGE_TIMEOUT_MS);

          if (response && !response.error && response.answers) {
            answers = response.answers;
          } else {
            aiError = response?.error || 'AI service unavailable';
            Logger.warn('ai-filler', `AI service response notice: ${aiError}, activating profile synthesis`);
          }
        } catch (sendErr) {
          aiError = sendErr.message;
          Logger.warn('ai-filler', `AI dispatch notice (${aiError}), activating instant profile synthesis`);
        }

      let aiFilled = 0;
      const newSavedQA = [];
      const newCacheEntries = [];

      for (let i = 0; i < questionsBatch.length; i++) {
        try {
          const q = questionsBatch[i];
          let ans = answers[String(i)] ?? answers[i] ?? answers[q.questionText];
          if (!ans && typeof answers === 'object') {
            for (const [k, v] of Object.entries(answers)) {
              if (k.toLowerCase().includes(q.questionText.toLowerCase()) || q.questionText.toLowerCase().includes(k.toLowerCase())) {
                ans = v;
                break;
              }
            }
          }

          // If AI did not return an answer (or encountered an error/timeout), synthesize from profile immediately
          if (!ans || !String(ans).trim()) {
            ans = this.generateSmartFallbackAnswer(q, profile);
          }
          if (!ans || !String(ans).trim()) continue;

          const answerText = String(ans).trim();
          const target = batchTargets[i];
          if (!target || !target.element) continue;

          let filled = false;
          if (target.type === 'select') {
            filled = DOM.fillSelect(target.element, answerText);
          } else if (target.type === 'radio') {
            filled = DOM.fillRadioGroup(target.element, answerText);
          } else if (target.type === 'checkbox') {
            const shouldCheck = /^(yes|true|1|agree|checked)$/i.test(answerText);
            if (target.element.checked !== shouldCheck) {
              target.element.click();
              filled = true;
            }
          } else if (target.type === 'textarea' || target.type === 'input') {
            DOM.setNativeValue(target.element, answerText);
            filled = true;
          }

          if (filled) {
            aiFilled++;
            DOM.highlightFieldAI(target.element);

            // Add to auto-save collection for user profile knowledge base
            newSavedQA.push({
              id: 'qa_' + Date.now() + '_' + i,
              question: questionsBatch[i].questionText,
              answer: answerText,
              autoSaved: true,
            });

            // Add to Zero-Latency Cache
            const normKey = Matcher.normalizeQuestion
              ? Matcher.normalizeQuestion(questionsBatch[i].questionText)
              : questionsBatch[i].questionText.toLowerCase().trim();
            newCacheEntries.push({ key: normKey, answer: answerText });
          }
        } catch (fieldFillErr) {
          Logger.error('ai-filler', `Error applying answer to field #${i} ("${questionsBatch[i]?.questionText}"): ${fieldFillErr.message}`, {
            index: i,
            question: questionsBatch[i]?.questionText,
            targetType: batchTargets[i]?.type,
            error: fieldFillErr,
          });
        }
      }

      if (newSavedQA.length > 0) {
        try {
          await this.saveNewCustomQAs(newSavedQA);
        } catch (saveErr) {
          Logger.error('ai-filler', `Failed to execute saveNewCustomQAs: ${saveErr.message}`, { error: saveErr });
        }
      }

      // Persist to zero-latency cache in storage
      if (newCacheEntries.length > 0) {
        try {
          const { quickfill_ai_cache = {} } = await chrome.storage.local.get('quickfill_ai_cache');
          for (const entry of newCacheEntries) {
            quickfill_ai_cache[entry.key] = {
              answer: entry.answer,
              savedAt: Date.now(),
              lastAccessed: Date.now(),
              hits: 1,
            };
          }
          await chrome.storage.local.set({ quickfill_ai_cache });
          Logger.info('ai-filler', `Persisted ${newCacheEntries.length} answers to zero-latency cache`);
        } catch (cacheErr) {
          Logger.warn('ai-filler', `Failed to write cache: ${cacheErr.message}`, { error: cacheErr });
        }
      }

      return { aiFilled, newSavedQA };
    } catch (err) {
      Logger.error('ai-filler', err, { step: 'fillUnmatchedWithAI' });
      return { aiFilled: 0, error: err.message };
    } finally {
      _isGenerating = false;
    }
  },

  /**
   * Persist newly AI-answered questions to user's knowledge base
   * @param {Array} newItems
   */
  async saveNewCustomQAs(newItems) {
    try {
      const { customQA = [] } = await chrome.storage.local.get('customQA');
      const updated = Array.isArray(customQA) ? [...customQA] : [];

      for (const newItem of newItems) {
        const exists = updated.some(
          (q) => q.question.toLowerCase().trim() === newItem.question.toLowerCase().trim()
        );
        if (!exists) {
          updated.push(newItem);
        }
      }

      await chrome.storage.local.set({ customQA: updated });
      Logger.info('ai-filler', `Auto-saved ${newItems.length} question(s) to profile knowledge base`);
    } catch (e) {
      Logger.error('ai-filler', `Failed to save custom QAs to storage: ${e.message}`, { error: e });
    }
  },

  /**
   * Synthesize instant candidate response (< 1ms) if AI provider is slow, offline, or timed out
   * @param {Object} q
   * @param {Object} profile
   * @returns {string}
   */
  generateSmartFallbackAnswer(q, profile = {}) {
    try {
      const qText = (q?.questionText || '').toLowerCase();
      const type = q?.fieldType || '';

      // Check standard compliance and legal heuristics first
      if (Matcher?.matchStandardComplianceQuestion) {
        const complianceAns = Matcher.matchStandardComplianceQuestion(qText, profile);
        if (complianceAns) return complianceAns;
      }

      // Open-ended why role / why join questions
      if (/(?:why[\s\S]*?(?:interested|joining|join|apply|want[\s_-]?to[\s_-]?work|role|company)|interest[\s_-]?in)/i.test(qText)) {
        const skillsSnippet = profile.skills ? profile.skills.split(',').slice(0, 3).map((s) => s.trim()).join(', ') : 'software development';
        return `I am excited about this role because my background in ${skillsSnippet} and experience as ${profile.currentJobTitle || 'an engineer'} align directly with the team's mission, technical challenges, and growth goals.`;
      }

      // Technical challenge / accomplishment / project
      if (/challenge|problem|accomplishment|achievement|project|approach|resolve/i.test(qText)) {
        if (profile.experienceDescription) return profile.experienceDescription;
        return `In my recent work at ${profile.currentCompany || 'my company'}, I resolved complex technical challenges by optimizing architecture, improving system performance, and implementing reliable tests across the pipeline.`;
      }

      // About me / summary / background
      if (/tell[\s_-]?us[\s_-]?about|summary|background|bio|describe[\s_-]?yourself/i.test(qText)) {
        return profile.summary || `Dedicated ${profile.currentJobTitle || 'engineer'} with ${profile.yearsOfExperience || 'several'} years of hands-on experience building reliable, scalable software solutions.`;
      }

      // Options-based selection
      if (q.options && q.options.length > 0) {
        const yesOpt = q.options.find((o) => /^yes$/i.test(o.trim()));
        if (yesOpt) return yesOpt;
        return q.options[0];
      }

      if (type === 'textarea') {
        return profile.summary || 'I bring strong technical skills, commitment to high code quality, and proactive problem-solving to every engineering project.';
      }

      return '';
    } catch (fallbackErr) {
      Logger.error('ai-filler', `Error generating smart fallback answer: ${fallbackErr.message}`, {
        question: q?.questionText,
        error: fallbackErr,
      });
      return profile?.summary || '';
    }
  },
  };

  global.QuickFillAIFiller = AIFiller;
})(typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : typeof global !== 'undefined' ? global : this);
