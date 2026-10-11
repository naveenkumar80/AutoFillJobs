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

    const questionsBatch = questionsToAsk.slice(0, 25);
    Logger.info('content', `Dispatching ${questionsBatch.length} unmatched questions to AI`);

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
        const target = targetElements[i];
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

          // Add to auto-save collection for future applications
          newSavedQA.push({
            id: 'qa_' + Date.now() + '_' + i,
            question: questionsBatch[i].questionText,
            answer: answerText,
            autoSaved: true,
          });
        }
      }

      if (newSavedQA.length > 0) {
        await saveNewCustomQAs(newSavedQA);
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

      const profileValue = profile[profileKey];
      if (!profileValue || !profileValue.trim()) continue;

      const isYesNoField = Matcher.FIELD_PATTERNS[profileKey]?.isYesNo;
      if (usedKeys.has(profileKey) && !isYesNoField) continue;

      let filled = false;

      if (el.tagName === 'SELECT') {
        filled = DOM.fillSelect(el, profileValue);
      } else if (el.type === 'radio') {
        filled = DOM.fillRadioGroup(el, profileValue);
      } else if (el.type === 'checkbox' && isYesNoField) {
        const shouldCheck = profileValue.toLowerCase() === 'yes';
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

    // === PASS 2: AI-Powered Missing Questions ===
    let aiError = null;
    let newQuestionsSaved = 0;
    if (useAI) {
      if (!aiSettings?.apiKey || !aiSettings.apiKey.trim()) {
        aiError = 'AI Assist is ON, but no API Key is saved. Open Settings → AI Configuration and enter your Gemini or OpenAI API Key.';
        Logger.warn('content', aiError);
      } else {
        const aiResult = await fillUnmatchedWithAI(elements, filledElements, profile, aiSettings, customQA || []);
        aiFilled = aiResult.aiFilled || 0;
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
