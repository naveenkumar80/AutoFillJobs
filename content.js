/**
 * content.js — Form Filling Orchestrator for QuickFill
 * 
 * Injected into web pages and iframes.
 * Coordinates modular scripts:
 * - scripts/logger.js (Error & event logging)
 * - scripts/dom-filler.js (Framework-safe value setters & highlights)
 * - scripts/field-matcher.js (Regex matching & Custom Q&A search)
 * - scripts/ai-filler.js (AI question harvesting, micro-batching, auto-save)
 * - scripts/form-engine.js (Multi-pass form filling execution)
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

  /**
   * Execute full form fill workflow using stored profile and settings.
   * Exposed globally on window for programmatic frame execution.
   * 
   * @param {boolean} [useAI=false]
   * @returns {Promise<Object>}
   */
  window.executeQuickFill = async function (useAI = false) {
    try {
      const isTop = window === window.top;
      const elements = DOM ? DOM.getAllFillableElements() : [];

      // Skip empty, advertising, or tracking subframes (< 2 fillable elements)
      if (!isTop && elements.length < 2) {
        return { fieldsFound: 0, fieldsFilled: 0, profileFilled: 0, aiFilled: 0 };
      }

      const { profile, aiSettings, customQA, savedResume } = await chrome.storage.local.get([
        'profile',
        'aiSettings',
        'customQA',
        'savedResume',
      ]);

      if (!profile) {
        return { error: 'No profile saved. Please set up your profile first.' };
      }

      const FormEngine = window.QuickFillFormEngine;
      if (!FormEngine) {
        Logger.error('content', 'QuickFillFormEngine not loaded');
        return { error: 'Form engine module not initialized. Please refresh the page.' };
      }

      return await FormEngine.fillFormFields(
        profile,
        useAI,
        aiSettings,
        customQA || [],
        savedResume || null
      );
    } catch (err) {
      Logger.error('content', err, { context: 'window.executeQuickFill' });
      return { error: 'Fill error: ' + err.message };
    }
  };

  /**
   * Listen for messages from popup or background scripts
   */
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action !== 'FILL_FORM') return false;

    if (DOM && window !== window.top) {
      const elements = DOM.getAllFillableElements();
      if (elements.length === 0) {
        return false; // Don't intercept in empty iframes
      }
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
