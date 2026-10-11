/**
 * scripts/logger.js — Centralized Logging & Error Tracking for QuickFill
 * 
 * Provides unified error, warning, and info logging across:
 * - background service worker
 * - content scripts
 * - popup UI
 * - options page
 * 
 * Stores the most recent 60 logs in chrome.storage.local for inspection in UI.
 */

(function (global) {
  const MAX_LOGS = 60;
  const STORAGE_KEY = 'quickfill_logs';

  const Logger = {
    /**
     * Log an error message with contextual details
     * @param {string} source - e.g. 'background', 'content', 'options', 'ai-service'
     * @param {string|Error} error - Error object or error description
     * @param {Object} [details] - Optional extra metadata
     */
    error(source, error, details = {}) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      const entry = createLogEntry('error', source, message, { ...details, stack });

      console.error(`[QuickFill:${source}] ❌ ${message}`, details, stack || '');
      persistLog(entry);
      return entry;
    },

    /**
     * Log a warning
     * @param {string} source
     * @param {string} message
     * @param {Object} [details]
     */
    warn(source, message, details = {}) {
      const entry = createLogEntry('warn', source, message, details);
      console.warn(`[QuickFill:${source}] ⚠️ ${message}`, details);
      persistLog(entry);
      return entry;
    },

    /**
     * Log informational message
     * @param {string} source
     * @param {string} message
     * @param {Object} [details]
     */
    info(source, message, details = {}) {
      const entry = createLogEntry('info', source, message, details);
      console.log(`[QuickFill:${source}] ℹ️ ${message}`, details);
      persistLog(entry);
      return entry;
    },

    /**
     * Retrieve all saved logs
     * @returns {Promise<Array>}
     */
    async getLogs() {
      try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
          const res = await chrome.storage.local.get(STORAGE_KEY);
          return Array.isArray(res[STORAGE_KEY]) ? res[STORAGE_KEY] : [];
        } else if (typeof localStorage !== 'undefined') {
          return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
        }
      } catch (e) {
        console.warn('[Logger] Failed to read logs from storage:', e);
      }
      return [];
    },

    /**
     * Clear all saved logs
     * @returns {Promise<void>}
     */
    async clearLogs() {
      try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
          await chrome.storage.local.set({ [STORAGE_KEY]: [] });
        } else if (typeof localStorage !== 'undefined') {
          localStorage.removeItem(STORAGE_KEY);
        }
      } catch (e) {
        console.warn('[Logger] Failed to clear logs:', e);
      }
    },
  };

  /**
   * Create a standardized log entry
   */
  function createLogEntry(level, source, message, details = {}) {
    return {
      id: 'log_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
      timestamp: new Date().toISOString(),
      displayTime: new Date().toLocaleTimeString(),
      level,
      source,
      message,
      details: sanitizeDetails(details),
    };
  }

  /**
   * Ensure details object contains no circular references or DOM elements
   */
  function sanitizeDetails(details) {
    if (!details || typeof details !== 'object') return {};
    const clean = {};
    for (const [k, v] of Object.entries(details)) {
      if (v instanceof Element) {
        clean[k] = `<${v.tagName.toLowerCase()} id="${v.id || ''}" name="${v.getAttribute('name') || ''}">`;
      } else if (typeof v === 'function') {
        clean[k] = '[Function]';
      } else if (v instanceof Error) {
        clean[k] = { message: v.message, stack: v.stack };
      } else {
        try {
          // Verify JSON serializability
          JSON.stringify(v);
          clean[k] = v;
        } catch {
          clean[k] = String(v);
        }
      }
    }
    return clean;
  }

  /**
   * Persist entry into chrome.storage.local or localStorage
   */
  async function persistLog(entry) {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(STORAGE_KEY, (res) => {
          const logs = Array.isArray(res[STORAGE_KEY]) ? res[STORAGE_KEY] : [];
          logs.unshift(entry);
          if (logs.length > MAX_LOGS) logs.length = MAX_LOGS;
          chrome.storage.local.set({ [STORAGE_KEY]: logs });
        });
      } else if (typeof localStorage !== 'undefined') {
        const logs = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
        logs.unshift(entry);
        if (logs.length > MAX_LOGS) logs.length = MAX_LOGS;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(logs));
      }
    } catch (e) {
      // Silently ignore storage errors in logging to avoid feedback loops
    }
  }

  // Export to global scope (works in Window and ServiceWorkerGlobalScope)
  global.QuickFillLogger = Logger;
})(typeof self !== 'undefined' ? self : this);
