/**
 * scripts/form-engine.js — Multi-Pass Form Filling Engine for QuickFill
 * 
 * Part of QuickFill Form Automation System.
 * Responsibilities:
 * - Traverses DOM for fillable fields (piercing shadow DOM & iframes via QuickFillDOM)
 * - Pass 0: Automatic Resume / CV file attachment to dropzones and file inputs
 * - Pass 1: Deterministic profile matching using regex heuristics & standard defaults
 * - Pass 1.2: Instant (< 10ms) legal, background check, work authorization & compliance heuristics
 * - Pass 1.5: Saved Custom Q&A (Knowledge Base) semantic & fuzzy matching
 * - Pass 1.8: Zero-Latency LRU response cache matching (< 5ms)
 * - Pass 2: AI-powered question resolution via QuickFillAIFiller micro-batching
 */

(function (global) {
  const Logger = global.QuickFillLogger || {
    error: (src, err) => console.error(src, err),
    warn: (src, msg) => console.warn(src, msg),
    info: (src, msg) => console.log(src, msg),
  };

  const DOM = global.QuickFillDOM;
  const Matcher = global.QuickFillMatcher;

  const FormEngine = {
    /**
     * Execute complete fill workflow across all deterministic and AI passes.
     * 
     * @param {Object} profile - User's saved profile
     * @param {boolean} [useAI=false] - Whether AI Assist is enabled
     * @param {Object} [aiSettings=null] - { provider, apiKey, model }
     * @param {Array} [customQA=[]] - User's saved Q&A library
     * @param {Object} [savedResume=null] - { name, type, base64 }
     * @returns {Promise<Object>} Summary metrics of the fill execution
     */
    async fillFormFields(profile, useAI = false, aiSettings = null, customQA = [], savedResume = null) {
      if (!DOM || !Matcher) {
        Logger.error('form-engine', 'Missing required dependencies: QuickFillDOM or QuickFillMatcher');
        return { error: 'Missing core form-filling modules.' };
      }

      const elements = DOM.getAllFillableElements();
      let fieldsFound = 0;
      let profileFilled = 0;
      let aiFilled = 0;
      let resumeAttached = false;
      let attachedResumeName = null;

      const usedKeys = new Set();
      const filledElements = new Set();

      Logger.info('form-engine', `Starting form fill: ${elements.length} elements scanned`, {
        useAI,
        hasSavedResume: !!savedResume?.base64,
      });

      // ============================================================
      // ============================================================
      // PASS 0: Resume / CV File Auto-Upload
      // ============================================================
      if (savedResume && savedResume.base64) {
        const allFileInputs = Array.from(document.querySelectorAll('input[type="file"]'));
        for (const fileInput of allFileInputs) {
          try {
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

                Logger.info('form-engine', `Successfully attached resume (${savedResume.name}) to file input`, {
                  id: fileInput.id,
                  name: fileInput.name,
                });
                break; // Standard job applications have 1 primary resume upload
              }
            }
          } catch (attachErr) {
            Logger.error('form-engine', `Failed to attach resume to input: ${attachErr.message}`, {
              id: fileInput?.id,
              error: attachErr,
            });
          }
        }
      }

      // ============================================================
      // PASS 1: Deterministic Profile-Based Matching
      // ============================================================
      for (const el of elements) {
        try {
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
        } catch (pass1Err) {
          Logger.warn('form-engine', `Error filling profile field: ${pass1Err.message}`, {
            name: el?.name,
            id: el?.id,
            error: pass1Err,
          });
        }
      }

      // ============================================================
      // PASS 1.2: Instant Legal & Compliance Heuristics (< 10ms)
      // ============================================================
      for (const el of elements) {
        try {
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
        } catch (pass12Err) {
          Logger.warn('form-engine', `Error filling compliance field: ${pass12Err.message}`, {
            name: el?.name,
            id: el?.id,
            error: pass12Err,
          });
        }
      }

      // ============================================================
      // PASS 1.5: Saved Custom Q&A (Knowledge Base) Matching
      // ============================================================
      if (customQA && customQA.length > 0) {
        for (const el of elements) {
          try {
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
          } catch (pass15Err) {
            Logger.warn('form-engine', `Error filling custom Q&A field: ${pass15Err.message}`, {
              name: el?.name,
              id: el?.id,
              error: pass15Err,
            });
          }
        }
      }

      // ============================================================
      // PASS 1.8: Zero-Latency Query Cache Matching (< 5ms)
      // ============================================================
      try {
        const { quickfill_ai_cache = {} } = await chrome.storage.local.get('quickfill_ai_cache');
        for (const el of elements) {
          try {
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
            let cachedEntry = quickfill_ai_cache[normQ];

            // Fuzzy match against cached entries (> 75% token overlap)
            if (!cachedEntry) {
              const qTokens = normQ.split(/\s+/).filter((w) => w.length > 2);
              if (qTokens.length >= 2) {
                for (const [cKey, cVal] of Object.entries(quickfill_ai_cache)) {
                  if (!cVal?.answer) continue;
                  const cTokens = cKey.split(/\s+/).filter((w) => w.length > 2);
                  const overlap = qTokens.filter((w) => cTokens.includes(w)).length;
                  const minLen = Math.min(qTokens.length, cTokens.length);
                  if (minLen > 0 && overlap / minLen >= 0.75) {
                    cachedEntry = cVal;
                    break;
                  }
                }
              }
            }

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
          } catch (pass18Err) {
            Logger.warn('form-engine', `Error filling cached field: ${pass18Err.message}`, {
              name: el?.name,
              id: el?.id,
              error: pass18Err,
            });
          }
        }
      } catch (cacheErr) {
        Logger.warn('form-engine', `Cache lookup note: ${cacheErr.message}`);
      }

      // ============================================================
      // PASS 2: AI-Powered Missing Questions
      // ============================================================
      let aiError = null;
      let newQuestionsSaved = 0;
      if (useAI) {
        const AIFiller = global.QuickFillAIFiller;
        if (!aiSettings?.apiKey || !aiSettings.apiKey.trim()) {
          aiError = 'AI Assist is ON, but no API Key is saved. Open Settings → AI Configuration and enter your Gemini or OpenAI API Key.';
          Logger.warn('form-engine', aiError);
        } else if (!AIFiller) {
          aiError = 'QuickFillAIFiller module not loaded.';
          Logger.error('form-engine', aiError);
        } else {
          const aiResult = await AIFiller.fillUnmatchedWithAI(elements, filledElements, profile, aiSettings, customQA || []);
          aiFilled += aiResult.aiFilled || 0;
          aiError = aiResult.error || null;
          newQuestionsSaved = aiResult.newSavedQA?.length || 0;
        }
      }

      const totalFilled = profileFilled + aiFilled + (resumeAttached ? 1 : 0);
      Logger.info('form-engine', `Form fill finished: ${totalFilled}/${fieldsFound + (resumeAttached ? 1 : 0)} filled`, {
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
    },
  };

  global.QuickFillFormEngine = FormEngine;
})(typeof self !== 'undefined' ? self : this);
