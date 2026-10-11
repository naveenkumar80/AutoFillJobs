/**
 * background.js — Service Worker Orchestrator for QuickFill
 * 
 * Modular service worker importing:
 * - scripts/logger.js (Error & event tracking)
 * - scripts/ai-service.js (Gemini & OpenAI API integration)
 * - scripts/resume-parser.js (Resume text & PDF extraction)
 */

importScripts(
  'scripts/logger.js',
  'scripts/ai-service.js',
  'scripts/resume-parser.js'
);

const Logger = self.QuickFillLogger;
const AIService = self.QuickFillAIService;
const ResumeParser = self.QuickFillResumeParser;

Logger.info('background', 'QuickFill background service worker initialized');

// ============================================================
// MESSAGE ROUTER
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const action = message?.action;

  // 1. AI Question Answer Generation
  if (action === 'AI_GENERATE') {
    AIService.generateAnswers(message)
      .then((result) => sendResponse(result))
      .catch((err) => {
        Logger.error('background', `AI_GENERATE failed: ${err.message}`, { tabId: sender?.tab?.id });
        sendResponse({ error: err.message, answers: {} });
      });
    return true; // Keep message channel open for async response
  }

  // 2. Resume Parsing (PDF / Text)
  if (action === 'PARSE_RESUME') {
    ResumeParser.parseResume(message)
      .then((result) => sendResponse(result))
      .catch((err) => {
        Logger.error('background', `PARSE_RESUME failed: ${err.message}`);
        sendResponse({ error: err.message });
      });
    return true;
  }

  // 3. Test AI Connection
  if (action === 'TEST_AI') {
    AIService.testConnection(message.aiSettings)
      .then((result) => sendResponse(result))
      .catch((err) => {
        Logger.error('background', `TEST_AI failed: ${err.message}`);
        sendResponse({ error: err.message });
      });
    return true;
  }

  // 4. Retrieve Logs
  if (action === 'GET_LOGS') {
    Logger.getLogs()
      .then((logs) => sendResponse({ logs }))
      .catch((err) => sendResponse({ error: err.message, logs: [] }));
    return true;
  }

  // 5. Clear Logs
  if (action === 'CLEAR_LOGS') {
    Logger.clearLogs()
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  // 6. AI Zero-Latency Cache Management
  if (action === 'GET_CACHE_STATS') {
    AIService.getCacheStats()
      .then((stats) => sendResponse({ stats }))
      .catch((err) => sendResponse({ error: err.message, stats: { count: 0 } }));
    return true;
  }

  if (action === 'CLEAR_CACHE') {
    AIService.clearCache()
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  return false;
});
