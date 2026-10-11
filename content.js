/**
 * content.js — Form Filling Orchestrator for QuickFill
 * 
 * Injected into all web pages and iframes.
 * Leverages modular scripts:
 * - scripts/logger.js (Error & event logging)
 * - scripts/dom-filler.js (Framework-safe value setters & highlights)
 * - scripts/field-matcher.js (Regex matching & Custom Q&A search)
 */

(function () {
  if (window.__QUICKFILL_INITIALIZED__) {
    return;
  }
  window.__QUICKFILL_INITIALIZED__ = true;

  const Logger = window.QuickFillLogger || {
    error: (src, err) => console.error(src, err),
    warn: (src, msg) => console.warn(src, msg),
    info: (src, msg) => console.log(src, msg),
  };

  const DOM = window.QuickFillDOM;
  const Matcher = window.QuickFillMatcher;

  // ============================================================
  // 1. AI QUESTION COLLECTOR & DISPATCHER
  // ============================================================

  /**
   * Identify all remaining unfilled fields and generate answers using AI.
   * 
   * @param {HTMLElement[]} allElements - All scanned form elements
   * @param {Set<HTMLElement>} filledElements - Elements already filled
   * @param {Object} profile - User's profile
   * @param {Object} aiSettings - { provider, apiKey, model }
   * @param {Array} customQA - User's saved custom Q&A library
   * @returns {Promise<{ aiFilled: number, error?: string, newSavedQA?: Array }>}
   */
  async function fillUnmatchedWithAI(allElements, filledElements, profile, aiSettings, customQA = []) {
    const questionsToAsk = [];
    const targetElements = [];
    const processedRadioGroups = new Set();

    for (const el of allElements) {
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

      // Handle Radio group
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

      // Handle Select
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

      // Handle Checkbox
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

      // Handle Textarea or Text Input
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
    }

    if (questionsToAsk.length === 0) {
      return { aiFilled: 0 };
    }

    // Pair questions with their corresponding target elements
    const paired = questionsToAsk.map((q, idx) => ({
      question: q,
      target: targetElements[idx],
    }));

    // Prioritize high-value fields: textareas first, then selects/radios, then short text
    paired.sort((a, b) => {
      const getPriority = (item) => {
        if (item.question.fieldType === 'textarea') return 3;
        if (item.question.fieldType === 'select' || item.question.fieldType === 'radio') return 2;
        return 1;
      };
      return getPriority(b) - getPriority(a);
    });

    // High-speed micro-batch: limit to top 8 priority questions for sub-second LLM latency
    const microBatch = paired.slice(0, 8);
    const questionsBatch = microBatch.map((item, idx) => ({
      ...item.question,
      index: idx,
    }));
    const batchTargets = microBatch.map((item) => item.target);

    Logger.info('content', `Dispatching micro-batch of ${questionsBatch.length} prioritized questions to AI`);

    try {
      const response = await chrome.runtime.sendMessage({
        action: 'AI_GENERATE',
        questions: questionsBatch,
        profile,
        customQA,
        aiSettings,
      });

      if (!response || response.error) {
        Logger.error('content', `AI generation error: ${response?.error || 'Empty response'}`);
        return { aiFilled: 0, error: response?.error || 'Empty AI response' };
      }

      const answers = response.answers || {};
      let aiFilled = 0;
      const newSavedQA = [];
      const newCacheEntries = [];

      for (let i = 0; i < questionsBatch.length; i++) {
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
      }

      if (newSavedQA.length > 0) {
        await saveNewCustomQAs(newSavedQA);
      }

      // Persist to zero-latency cache directly
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
          Logger.info('content', `Persisted ${newCacheEntries.length} answers to zero-latency cache`);
        } catch (cacheErr) {
          Logger.warn('content', `Failed to write cache in content script: ${cacheErr.message}`);
        }
      }

      return { aiFilled, newSavedQA };
    } catch (err) {
      Logger.error('content', err, { step: 'fillUnmatchedWithAI' });
      return { aiFilled: 0, error: err.message };
    }
  }

  /**
   * Persist newly AI-answered questions to user's knowledge base
   * @param {Array} newItems
   */
  async function saveNewCustomQAs(newItems) {
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
      Logger.info('content', `Auto-saved ${newItems.length} question(s) to profile knowledge base`);
    } catch (e) {
      Logger.warn('content', `Failed to save custom QAs: ${e.message}`);
    }
  }

  // ============================================================
  // 2. MAIN FILL ORCHESTRATOR
  // ============================================================

  /**
   * Execute complete fill workflow across 3 passes:
   *   Pass 1: Deterministic profile matching
   *   Pass 1.5: Saved Knowledge Base (customQA) matching
   *   Pass 2: AI generation for remaining questions
   */
  async function fillFormFields(profile, useAI = false, aiSettings = null, customQA = [], savedResume = null) {
    const elements = DOM.getAllFillableElements();
    let fieldsFound = 0;
    let profileFilled = 0;
    let aiFilled = 0;
    let resumeAttached = false;
    let attachedResumeName = null;

    const usedKeys = new Set();
    const filledElements = new Set();

    Logger.info('content', `Starting form fill: ${elements.length} elements scanned`, {
      useAI,
      hasSavedResume: !!savedResume?.base64,
    });

    // === PASS 0: Resume / CV File Auto-Upload ===
    if (savedResume && savedResume.base64) {
      const allFileInputs = Array.from(document.querySelectorAll('input[type="file"]'));
      for (const fileInput of allFileInputs) {
        if (fileInput.disabled) continue;
        if (Matcher.isResumeFileInput(fileInput, allFileInputs.length)) {
          const success = DOM.attachFile(fileInput, savedResume);
          if (success) {
            resumeAttached = true;
            attachedResumeName = savedResume.name;
            filledElements.add(fileInput);
            DOM.highlightField(fileInput);

            // Also highlight visual container, drop area, or upload wrapper if styled
            const uploadContainer = fileInput.closest('.awsm-job-form-group, .form-group, .dropzone, .drop-zone, .file-upload, [class*="upload"]') || fileInput.parentElement;
            if (uploadContainer) {
              DOM.highlightField(uploadContainer);
            }

            Logger.info('content', `Successfully attached resume (${savedResume.name}) to file input`, {
              id: fileInput.id,
              name: fileInput.name,
            });
            break; // Standard forms have 1 primary resume upload
          }
        }
      }
    }

    // === PASS 1: Profile-Based Matching ===
    for (const el of elements) {
      if (!DOM.isVisible(el)) continue;
      if (el.type === 'file' || el.type === 'password' || el.type === 'submit' || el.type === 'button') continue;
      if (el.readOnly) continue;

      fieldsFound++;

      // Auto-check terms, privacy policy, or data processing consent checkboxes
      if (el.type === 'checkbox') {
        const labelText = (DOM.findLabelText(el) || '').toLowerCase();
        const nameOrId = ((el.name || '') + ' ' + (el.id || '')).toLowerCase();
        if (
          /privacy|terms|policy|data[\s_-]?(?:handling|storage|processing)|agree|consent/i.test(labelText) ||
          /privacy|terms|policy|consent/i.test(nameOrId)
        ) {
          if (!el.checked) {
            el.click();
            el.dispatchEvent(new Event('change', { bubbles: true }));
            profileFilled++;
            DOM.highlightField(el);
          }
          filledElements.add(el);
          continue;
        }
      }

      if (DOM.isAlreadyFilled(el)) {
        filledElements.add(el);
        continue;
      }

      const profileKey = Matcher.matchFieldToProfile(el);
      if (!profileKey) continue;

      const pattern = Matcher.FIELD_PATTERNS[profileKey];
      let profileValue = profile[profileKey];
      // Fallback to pattern default if profile does not specify (e.g. standard compliance yes/no)
      if ((!profileValue || !String(profileValue).trim()) && pattern?.defaultValue) {
        profileValue = pattern.defaultValue;
      }
      if (!profileValue || !String(profileValue).trim()) continue;

      const isYesNoField = pattern?.isYesNo;
      if (usedKeys.has(profileKey) && !isYesNoField) continue;

      let filled = false;

      if (el.tagName === 'SELECT') {
        filled = DOM.fillSelect(el, profileValue);
      } else if (el.type === 'radio') {
        filled = DOM.fillRadioGroup(el, profileValue);
      } else if (el.type === 'checkbox' && isYesNoField) {
        const shouldCheck = String(profileValue).toLowerCase() === 'yes';
        if (el.checked !== shouldCheck) {
          el.click();
          filled = true;
        }
      } else if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        DOM.setNativeValue(el, profileValue);
        filled = true;
      } else if (el.getAttribute('contenteditable') === 'true') {
        el.textContent = profileValue;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        filled = true;
      }

      if (filled) {
        profileFilled++;
        usedKeys.add(profileKey);
        filledElements.add(el);
        DOM.highlightField(el);
      }
    }

    // === PASS 1.2: Instant Legal & Compliance Heuristics (< 10ms) ===
    for (const el of elements) {
      if (!DOM.isVisible(el)) continue;
      if (el.type === 'file' || el.type === 'password' || el.type === 'submit' || el.type === 'button') continue;
      if (el.readOnly) continue;
      if (filledElements.has(el) || DOM.isAlreadyFilled(el)) continue;

      let qText = null;
      if (el.type === 'radio') {
        const radios = document.querySelectorAll(`input[type="radio"][name="${CSS.escape(el.name)}"]`);
        qText = Matcher.findRadioGroupQuestionText(el, radios);
      } else {
        qText = Matcher.findFieldQuestionText(el);
      }
      if (!qText) continue;

      const complianceAns = Matcher.matchStandardComplianceQuestion(qText, profile);
      if (complianceAns) {
        let filled = false;
        if (el.tagName === 'SELECT') {
          filled = DOM.fillSelect(el, complianceAns);
        } else if (el.type === 'radio') {
          filled = DOM.fillRadioGroup(el, complianceAns);
        } else if (el.type === 'checkbox') {
          const shouldCheck = /^(yes|true|1|agree|checked)$/i.test(complianceAns);
          if (el.checked !== shouldCheck) {
            el.click();
            filled = true;
          }
        } else if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
          DOM.setNativeValue(el, complianceAns);
          filled = true;
        }

        if (filled) {
          profileFilled++;
          filledElements.add(el);
          DOM.highlightField(el);
        }
      }
    }

    // === PASS 1.5: Saved Custom Q&A (Knowledge Base) Matching ===
    if (customQA && customQA.length > 0) {
      for (const el of elements) {
        if (!DOM.isVisible(el)) continue;
        if (el.type === 'file' || el.type === 'password' || el.type === 'submit' || el.type === 'button') continue;
        if (el.readOnly) continue;
        if (filledElements.has(el) || DOM.isAlreadyFilled(el)) continue;

        let qText = null;
        if (el.type === 'radio') {
          const radios = document.querySelectorAll(`input[type="radio"][name="${CSS.escape(el.name)}"]`);
          qText = Matcher.findRadioGroupQuestionText(el, radios);
        } else {
          qText = Matcher.findFieldQuestionText(el);
        }

        if (!qText) continue;

        const matchedQA = Matcher.findMatchingCustomQA(qText, customQA);
        if (matchedQA && matchedQA.answer && matchedQA.answer.trim()) {
          let filled = false;
          if (el.tagName === 'SELECT') {
            filled = DOM.fillSelect(el, matchedQA.answer);
          } else if (el.type === 'radio') {
            filled = DOM.fillRadioGroup(el, matchedQA.answer);
          } else if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
            DOM.setNativeValue(el, matchedQA.answer);
            filled = true;
          }

          if (filled) {
            profileFilled++;
            filledElements.add(el);
            DOM.highlightField(el);
          }
        }
      }
    }

    // === PASS 1.8: Zero-Latency Query Cache Matching (< 5ms) ===
    try {
      const { quickfill_ai_cache = {} } = await chrome.storage.local.get('quickfill_ai_cache');
      for (const el of elements) {
        if (!DOM.isVisible(el)) continue;
        if (el.type === 'file' || el.type === 'password' || el.type === 'submit' || el.type === 'button') continue;
        if (el.readOnly) continue;
        if (filledElements.has(el) || DOM.isAlreadyFilled(el)) continue;

        let qText = null;
        if (el.type === 'radio') {
          const radios = document.querySelectorAll(`input[type="radio"][name="${CSS.escape(el.name)}"]`);
          qText = Matcher.findRadioGroupQuestionText(el, radios);
        } else {
          qText = Matcher.findFieldQuestionText(el);
        }
        if (!qText) continue;

        const normQ = Matcher.normalizeQuestion ? Matcher.normalizeQuestion(qText) : qText.toLowerCase().trim();
        const cachedEntry = quickfill_ai_cache[normQ];
        if (cachedEntry && cachedEntry.answer) {
          let filled = false;
          if (el.tagName === 'SELECT') {
            filled = DOM.fillSelect(el, cachedEntry.answer);
          } else if (el.type === 'radio') {
            filled = DOM.fillRadioGroup(el, cachedEntry.answer);
          } else if (el.type === 'checkbox') {
            const shouldCheck = /^(yes|true|1|agree|checked)$/i.test(cachedEntry.answer);
            if (el.checked !== shouldCheck) {
              el.click();
              filled = true;
            }
          } else if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
            DOM.setNativeValue(el, cachedEntry.answer);
            filled = true;
          }

          if (filled) {
            aiFilled++;
            filledElements.add(el);
            DOM.highlightFieldAI(el);
          }
        }
      }
    } catch (cacheErr) {
      Logger.warn('content', `Cache lookup note: ${cacheErr.message}`);
    }

    // === PASS 2: AI-Powered Missing Questions ===
    let aiError = null;
    let newQuestionsSaved = 0;
    if (useAI) {
      if (!aiSettings?.apiKey || !aiSettings.apiKey.trim()) {
        aiError = 'AI Assist is ON, but no API Key is saved. Open Settings → AI Configuration and enter your Gemini or OpenAI API Key.';
        Logger.warn('content', aiError);
      } else {
        const aiResult = await fillUnmatchedWithAI(elements, filledElements, profile, aiSettings, customQA || []);
        aiFilled += aiResult.aiFilled || 0;
        aiError = aiResult.error || null;
        newQuestionsSaved = aiResult.newSavedQA?.length || 0;
      }
    }

    const totalFilled = profileFilled + aiFilled + (resumeAttached ? 1 : 0);
    Logger.info('content', `Form fill finished: ${totalFilled}/${fieldsFound + (resumeAttached ? 1 : 0)} filled`, {
      profileFilled,
      aiFilled,
      resumeAttached,
      attachedResumeName,
      newQuestionsSaved,
      aiError,
    });

    return {
      fieldsFound: fieldsFound + (resumeAttached ? 1 : 0),
      fieldsFilled: totalFilled,
      profileFilled,
      aiFilled,
      resumeAttached,
      attachedResumeName,
      aiError,
      newQuestionsSaved,
    };
  }

  // ============================================================
  // 3. PUBLIC RUNNER & TAB MESSAGING
  // ============================================================

  window.executeQuickFill = async function (useAI = false) {
    try {
      const { profile, aiSettings, customQA, savedResume } = await chrome.storage.local.get([
        'profile',
        'aiSettings',
        'customQA',
        'savedResume',
      ]);
      if (!profile) {
        return { error: 'No profile saved. Please set up your profile first.' };
      }
      return await fillFormFields(profile, useAI, aiSettings, customQA || [], savedResume || null);
    } catch (err) {
      Logger.error('content', err, { context: 'window.executeQuickFill' });
      return { error: 'Fill error: ' + err.message };
    }
  };

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action !== 'FILL_FORM') return false;

    const elements = DOM.getAllFillableElements();
    if (window !== window.top && elements.length === 0) {
      return false; // Don't intercept in empty iframes
    }

    (async () => {
      try {
        const result = await window.executeQuickFill(!!message.useAI);
        sendResponse(result);
      } catch (err) {
        Logger.error('content', err, { context: 'FILL_FORM listener' });
        sendResponse({ error: 'Fill error: ' + err.message });
      }
    })();

    return true;
  });
})();
