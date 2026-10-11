/**
 * popup.js — Job Application QuickFill Popup Controller
 * Manages the popup UI: profile preview, AI toggle, fill triggering, and status display
 */

/**
 * Load profile & AI settings from storage and render the preview card
 */
function renderProfilePreview() {
  if (typeof chrome === 'undefined' || !chrome?.storage?.local) {
    // Standalone / development preview fallback
    const container = document.getElementById('profilePreview');
    if (container) {
      container.classList.remove('empty');
      container.innerHTML = `
        <div class="profile-row">
          <div class="profile-avatar">JD</div>
          <div class="profile-info">
            <div class="profile-name">Jane Doe</div>
            <div class="profile-email">jane@example.com</div>
          </div>
          <span class="profile-badge ready">● Ready</span>
        </div>
        <div class="profile-resume-badge">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>
          <span>Resume attached: <strong>resume.pdf</strong></span>
        </div>
      `;
      const btn = document.getElementById('btnFill');
      if (btn) btn.disabled = false;
      const aiRow = document.getElementById('aiToggleRow');
      if (aiRow) aiRow.style.display = 'flex';
    }
    return;
  }
  chrome.storage.local.get(['profile', 'aiSettings', 'aiPopupEnabled', 'savedResume'], ({ profile, aiSettings, aiPopupEnabled, savedResume }) => {
    const container = document.getElementById('profilePreview');
    const aiToggleRow = document.getElementById('aiToggleRow');
    const aiToggle = document.getElementById('aiToggle');

    // Check if AI is configured in options
    if (aiSettings && aiSettings.apiKey && aiSettings.apiKey.trim()) {
      aiToggleRow.style.display = 'flex';
      aiToggle.checked = aiPopupEnabled !== undefined ? !!aiPopupEnabled : (aiSettings.enabled !== false);
    } else {
      aiToggleRow.style.display = 'none';
    }

    if (!profile || (!profile.firstName && !profile.email)) {
      // No profile saved — show setup prompt
      container.classList.add('empty');
      container.innerHTML = `
        <div class="profile-empty-text">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#eab308" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
          <span>No profile saved yet. Click "Settings & Knowledge Base" below to get started.</span>
        </div>
      `;
      document.getElementById('btnFill').disabled = true;
      return;
    }

    // Build display values
    const displayName = profile.fullName
      || [profile.firstName, profile.lastName].filter(Boolean).join(' ')
      || 'Unnamed';
    const initials = (profile.firstName?.[0] || '') + (profile.lastName?.[0] || '');
    const displayEmail = profile.email || 'No email set';

    // Count how many fields are filled
    const totalFields = Object.keys(profile).length;
    const filledFields = Object.values(profile).filter((v) => v && v.trim()).length;
    const isComplete = filledFields >= 6; // reasonable threshold

    const resumeBadgeHtml = savedResume && savedResume.name
      ? `<div class="profile-resume-badge"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg><span>Resume attached: <strong>${escapeHtml(savedResume.name)}</strong></span></div>`
      : '';

    container.classList.remove('empty');
    container.innerHTML = `
      <div class="profile-row">
        <div class="profile-avatar">${initials.toUpperCase() || '?'}</div>
        <div class="profile-info">
          <div class="profile-name">${escapeHtml(displayName)}</div>
          <div class="profile-email">${escapeHtml(displayEmail)}</div>
        </div>
        <span class="profile-badge ${isComplete ? 'ready' : 'incomplete'}">
          ${isComplete ? '● Ready' : `${filledFields}/${totalFields}`}
        </span>
      </div>
      ${resumeBadgeHtml}
    `;

    // Enable the fill button since we have a profile
    document.getElementById('btnFill').disabled = false;
  });
}

/**
 * Escape HTML special characters to prevent XSS in dynamic content
 */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/**
 * Update the status area with a message and split stats
 * @param {'idle'|'working'|'success'|'error'} state
 * @param {string} message
 * @param {{ found?: number, profile?: number, ai?: number }|null} stats
 */
function setStatus(state, message, stats = null) {
  const area = document.getElementById('statusArea');
  const msgEl = document.getElementById('statusMessage');
  const statsRow = document.getElementById('statsRow');

  // Reset area classes
  area.className = 'status-area fade-in';
  if (state === 'success') area.classList.add('success');
  if (state === 'error') area.classList.add('error');

  msgEl.innerHTML = `
    <span class="dot ${state}"></span>
    <span>${message}</span>
  `;

  if (stats && stats.found !== undefined) {
    statsRow.style.display = 'flex';
    document.getElementById('statFound').textContent = stats.found ?? 0;
    document.getElementById('statProfile').textContent = stats.profile ?? 0;
    document.getElementById('statAI').textContent = stats.ai ?? 0;
  } else {
    statsRow.style.display = 'none';
  }
}

/**
 * Handle the "Fill Form Now" button click
 * Sends a message to the content script in the active tab with AI preferences
 */
async function handleFill() {
  const btn = document.getElementById('btnFill');
  const btnText = document.getElementById('btnFillText');
  const aiToggleRow = document.getElementById('aiToggleRow');
  const aiToggle = document.getElementById('aiToggle');

  const useAI = aiToggleRow && aiToggleRow.style.display !== 'none' && aiToggle?.checked;

  // Update UI to "filling" state
  btn.disabled = true;
  btn.classList.add('filling');
  btnText.textContent = useAI ? 'Filling & AI…' : 'Filling…';
  setStatus('working', useAI
    ? 'Scanning fields and generating AI answers for missing questions…'
    : 'Scanning page for form fields…'
  );

  try {
    // Get the active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || !tab.id) {
      setStatus('error', 'No active tab found. Please open a web page.');
      resetButton();
      return;
    }

    // Ensure content scripts are injected into all frames
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: [
          'scripts/logger.js',
          'scripts/dom-filler.js',
          'scripts/field-matcher.js',
          'scripts/ai-filler.js',
          'scripts/form-engine.js',
          'content.js',
        ],
      });
    } catch (injectionError) {
      console.log('Injection note:', injectionError.message);
    }

    // Execute fill: top frame first (fast path for 95%+ of job portals)
    let results = [];
    try {
      results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: async (useAI) => {
          if (typeof window.executeQuickFill === 'function') {
            return await window.executeQuickFill(useAI);
          }
          return null;
        },
        args: [useAI],
      });

      // If top frame had no fields, check subframes for embedded application iframes
      const topFound = results?.[0]?.result?.fieldsFound || 0;
      if (topFound === 0) {
        const subResults = await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          func: async (useAI) => {
            if (window !== window.top && typeof window.executeQuickFill === 'function') {
              return await window.executeQuickFill(useAI);
            }
            return null;
          },
          args: [useAI],
        });
        if (subResults && subResults.length > 0) {
          results = subResults;
        }
      }
    } catch (execError) {
      console.warn('executeScript failed, will try sendMessage fallback:', execError);
    }

    let fieldsFound = 0;
    let fieldsFilled = 0;
    let profileFilled = 0;
    let aiFilled = 0;
    let resumeAttached = false;
    let attachedResumeName = null;
    let aiError = null;
    let newQuestionsSaved = 0;
    let hasAnyResult = false;
    let lastError = null;

    if (results && results.length > 0) {
      for (const res of results) {
        const r = res?.result;
        if (r && typeof r === 'object') {
          if (r.error) {
            lastError = r.error;
          }
          if (r.aiError) {
            aiError = r.aiError;
          }
          if (r.newQuestionsSaved) {
            newQuestionsSaved += r.newQuestionsSaved;
          }
          if (r.resumeAttached) {
            resumeAttached = true;
            attachedResumeName = r.attachedResumeName;
          }
          if (r.fieldsFound > 0 || r.fieldsFilled > 0) {
            hasAnyResult = true;
            fieldsFound += (r.fieldsFound || 0);
            fieldsFilled += (r.fieldsFilled || 0);
            profileFilled += (r.profileFilled || 0);
            aiFilled += (r.aiFilled || 0);
          }
        }
      }
    }

    // Fallback: if executeScript returned no results, send message via tabs.sendMessage
    if (!hasAnyResult && !lastError) {
      const fallbackRes = await new Promise((resolve) => {
        chrome.tabs.sendMessage(tab.id, { action: 'FILL_FORM', useAI }, (resp) => {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(resp);
        });
      });

      if (fallbackRes) {
        hasAnyResult = true;
        fieldsFound = fallbackRes.fieldsFound || 0;
        fieldsFilled = fallbackRes.fieldsFilled || 0;
        profileFilled = fallbackRes.profileFilled || 0;
        aiFilled = fallbackRes.aiFilled || 0;
        if (fallbackRes.resumeAttached) {
          resumeAttached = true;
          attachedResumeName = fallbackRes.attachedResumeName;
        }
        if (fallbackRes.aiError) aiError = fallbackRes.aiError;
        if (fallbackRes.newQuestionsSaved) newQuestionsSaved = fallbackRes.newQuestionsSaved;
        if (fallbackRes.error) lastError = fallbackRes.error;
      }
    }

    if (lastError && !hasAnyResult) {
      setStatus('error', lastError);
      resetButton();
      return;
    }

    if (fieldsFilled === 0 && fieldsFound === 0) {
      setStatus('idle', 'No fillable form fields detected on this page.');
    } else if (fieldsFilled === 0) {
      if (aiError) {
        setStatus('error', `Found ${fieldsFound} fields, but AI could not answer: ${aiError}`, {
          found: fieldsFound,
          profile: 0,
          ai: 0,
        });
      } else {
        setStatus('idle', `Found ${fieldsFound} fields but none could be filled. Check that your profile details match.`, {
          found: fieldsFound,
          profile: 0,
          ai: 0,
        });
      }
    } else {
      let msg = `Successfully filled ${fieldsFilled} of ${fieldsFound} fields!`;
      if (aiFilled > 0 && profileFilled > 0) {
        msg = `Filled ${profileFilled} from profile + ${aiFilled} answered by AI!`;
      } else if (aiFilled > 0) {
        msg = `Filled ${aiFilled} custom questions with AI!`;
      }

      if (resumeAttached) {
        msg += ` • Attached ${attachedResumeName || 'resume'}!`;
      }

      if (newQuestionsSaved > 0) {
        msg += ` (${newQuestionsSaved} saved to Knowledge Base for future!)`;
      } else if (aiError) {
        msg += ` (AI note: ${aiError})`;
      }

      setStatus('success', msg, {
        found: fieldsFound,
        profile: profileFilled,
        ai: aiFilled,
      });
    }

    resetButton();
  } catch (err) {
    setStatus('error', 'Unexpected error: ' + err.message);
    resetButton();
  }
}

/**
 * Reset the fill button back to its default state
 */
function resetButton() {
  const btn = document.getElementById('btnFill');
  const btnText = document.getElementById('btnFillText');
  btn.disabled = false;
  btn.classList.remove('filling');
  btnText.textContent = 'Fill Form Now';
}

/**
 * Open the options page when "Edit Profile" is clicked
 */
function openSettings() {
  chrome.runtime.openOptionsPage();
}

/**
 * Theme management for Popup
 */
function initTheme() {
  let theme = localStorage.getItem('quickfill_theme');
  if (!theme && typeof chrome !== 'undefined' && chrome?.storage?.local) {
    chrome.storage.local.get(['theme'], ({ theme: storedTheme }) => {
      if (storedTheme) {
        applyTheme(storedTheme);
      } else {
        const sys = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
        applyTheme(sys);
      }
    });
    return;
  }
  if (!theme) {
    theme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  applyTheme(theme);
}

function applyTheme(theme) {
  if (theme === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  localStorage.setItem('quickfill_theme', theme);
  if (typeof chrome !== 'undefined' && chrome?.storage?.local) {
    chrome.storage.local.set({ theme });
  }
}

function toggleTheme() {
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  const newTheme = isLight ? 'dark' : 'light';
  applyTheme(newTheme);
}

// --- Initialize ---
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  renderProfilePreview();
  document.getElementById('btnFill').addEventListener('click', handleFill);
  document.getElementById('btnSettings').addEventListener('click', openSettings);
  document.getElementById('themeToggle')?.addEventListener('click', toggleTheme);

  // Remember AI toggle preference in popup
  document.getElementById('aiToggle')?.addEventListener('change', (e) => {
    if (typeof chrome !== 'undefined' && chrome?.storage?.local) {
      chrome.storage.local.set({ aiPopupEnabled: e.target.checked });
    }
  });
});
