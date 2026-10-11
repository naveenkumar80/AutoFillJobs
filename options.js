/**
 * options.js — Job Application QuickFill Options Page
 * Handles loading and saving user profile data, resume parsing,
 * custom Q&A knowledge base, and AI settings to chrome.storage.local
 */

// All profile field IDs — must match the HTML form input IDs
const PROFILE_FIELDS = [
  // Personal Info
  'firstName',
  'lastName',
  'fullName',
  'email',
  'phone',
  // Location
  'city',
  'country',
  'address',
  // Work Experience
  'currentJobTitle',
  'currentCompany',
  'currentStartDate',
  'currentEndDate',
  'yearsOfExperience',
  'desiredSalary',
  'experienceDescription',
  // Education
  'educationLevel',
  'university',
  'major',
  'graduationYear',
  'gpa',
  // Skills & Certifications
  'skills',
  'certifications',
  // Links
  'linkedin',
  'github',
  'portfolio',
  // Work Authorization & Preferences
  'authorizedToWork',
  'requiresSponsorship',
  'workPreference',
  'earliestStartDate',
  'noticePeriod',
  // Professional Summary
  'summary',
];

// Model options per provider (using verified official production model identifiers)
const MODEL_OPTIONS = {
  gemini: [
    { value: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash (Fastest & Latest)' },
    { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
    { value: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash' },
    { value: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro (Deep Reasoning)' },
  ],
  openai: [
    { value: 'gpt-4o-mini', label: 'GPT-4o Mini (Fast & Cheap)' },
    { value: 'gpt-4o', label: 'GPT-4o (Best Quality)' },
  ],
};

// API key hints per provider
const API_KEY_HINTS = {
  gemini: 'Gemini: Get a free key at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a>',
  openai: 'OpenAI: Get a key at <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener">platform.openai.com/api-keys</a>',
};

// State for custom Q&A items, saved resume, and work history
let currentCustomQA = [];
let currentSavedResume = null;
let currentWorkHistory = [];

/**
 * Safely check if chrome.storage.local is available in this environment
 * @returns {boolean}
 */
function hasStorage() {
  try {
    return (
      typeof chrome !== 'undefined' &&
      typeof chrome.storage !== 'undefined' &&
      typeof chrome.storage.local !== 'undefined' &&
      typeof chrome.storage.local.get === 'function'
    );
  } catch (e) {
    return false;
  }
}

/**
 * Format bytes to human readable format (KB, MB)
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/**
 * Render the saved resume badge in the UI
 * @param {Object|null} savedResume
 */
function renderSavedResumeBadge(savedResume) {
  const infoEl = document.getElementById('savedResumeInfo');
  const nameEl = document.getElementById('savedResumeFileName');
  const metaEl = document.getElementById('savedResumeMeta');
  if (!infoEl || !nameEl || !metaEl) return;

  if (savedResume && savedResume.base64) {
    currentSavedResume = savedResume;
    nameEl.textContent = savedResume.name || 'Resume.pdf';
    metaEl.innerHTML = `${formatBytes(savedResume.size || 0)} &bull; Saved &amp; Ready to Auto-Upload on Job Forms`;
    infoEl.style.display = 'block';
  } else {
    currentSavedResume = null;
    infoEl.style.display = 'none';
  }
}

// ============================================================
// 1. DATA LOADING & POPULATION
// ============================================================

/**
 * Load saved profile, custom Q&A, AI settings, and resume into UI
 */
function populateForm(profile, aiSettings, customQA, savedResume) {
  // 1. Load profile fields
  if (profile) {
    PROFILE_FIELDS.forEach((field) => {
      const el = document.getElementById(field);
      if (el && profile[field] !== undefined && profile[field] !== null) {
        el.value = profile[field];
      }
    });

    // Load work history
    currentWorkHistory = Array.isArray(profile.workHistory) ? profile.workHistory : [];
    renderExperienceList();

    // Render skill tags
    renderSkillTags();
  } else {
    currentWorkHistory = [];
    renderExperienceList();
    renderSkillTags();
  }

  // 2. Load custom Q&A Knowledge Base
  currentCustomQA = Array.isArray(customQA) ? customQA : [];
  renderCustomQAList();

  // 3. Load Saved Resume File Badge
  renderSavedResumeBadge(savedResume);

  // 4. Load AI settings
  if (aiSettings) {
    const enabledEl = document.getElementById('aiEnabled');
    if (enabledEl) enabledEl.checked = !!aiSettings.enabled;

    const providerEl = document.getElementById('aiProvider');
    if (providerEl && aiSettings.provider) providerEl.value = aiSettings.provider;

    // Update model options for the selected provider
    updateModelOptions(aiSettings.provider || 'gemini');

    const modelEl = document.getElementById('aiModel');
    if (modelEl && aiSettings.model) {
      let modelVal = aiSettings.model;
      if (modelVal === 'gemini-2.0-flash' || modelVal.includes('2.0') || modelVal.includes('2.5')) {
        modelVal = 'gemini-3.8-flash';
      }
      modelEl.value = modelVal;
    }

    const apiKeyEl = document.getElementById('aiApiKey');
    if (apiKeyEl && aiSettings.apiKey) apiKeyEl.value = aiSettings.apiKey;

    // Update UI visibility
    updateAIFieldsVisibility(!!aiSettings.enabled);
    updateApiKeyHint(aiSettings.provider || 'gemini');
  }
}

/**
 * Load saved profile, custom Q&A, AI settings, and resume from storage
 */
function loadProfile() {
  if (!hasStorage()) {
    try {
      const profile = JSON.parse(localStorage.getItem('quickfill_profile') || 'null');
      const aiSettings = JSON.parse(localStorage.getItem('quickfill_aiSettings') || 'null');
      const customQA = JSON.parse(localStorage.getItem('quickfill_customQA') || '[]');
      const savedResume = JSON.parse(localStorage.getItem('quickfill_savedResume') || 'null');
      populateForm(profile, aiSettings, customQA, savedResume);
    } catch (e) {}
    return;
  }
  chrome.storage.local.get(['profile', 'aiSettings', 'customQA', 'savedResume'], ({ profile, aiSettings, customQA, savedResume }) => {
    populateForm(profile, aiSettings, customQA, savedResume);
  });
}

/**
 * Gather all form values into a profile object
 * Auto-computes fullName from first + last if fullName is left blank
 */
function gatherProfile() {
  const profile = {};

  PROFILE_FIELDS.forEach((field) => {
    const el = document.getElementById(field);
    if (el) {
      profile[field] = el.value.trim();
    }
  });

  // Auto-compute fullName if left empty
  if (!profile.fullName && (profile.firstName || profile.lastName)) {
    profile.fullName = [profile.firstName, profile.lastName].filter(Boolean).join(' ');
    document.getElementById('fullName').value = profile.fullName;
  }

  // Gather past work history entries
  profile.workHistory = gatherWorkHistory();

  return profile;
}

/**
 * Gather AI settings from the form
 */
function gatherAISettings() {
  const apiKey = document.getElementById('aiApiKey')?.value?.trim() || '';
  const isChecked = document.getElementById('aiEnabled')?.checked;
  return {
    enabled: isChecked !== undefined ? isChecked : apiKey.length > 0,
    provider: document.getElementById('aiProvider')?.value || 'gemini',
    model: document.getElementById('aiModel')?.value || 'gemini-3.8-flash',
    apiKey,
  };
}


// ============================================================
// 2. CUSTOM Q&A KNOWLEDGE BASE MANAGEMENT
// ============================================================

/**
 * Render the Custom Q&A list in the UI
 */
function renderCustomQAList() {
  const container = document.getElementById('customQAList');
  if (!container) return;

  if (currentCustomQA.length === 0) {
    container.innerHTML = `
      <div class="qa-empty-state">
        <span>No custom questions saved yet. As AI answers questions on job boards, or when you import a resume, they will appear here.</span>
      </div>
    `;
    return;
  }

  container.innerHTML = currentCustomQA.map((item, idx) => `
    <div class="qa-card" data-id="${item.id || idx}">
      <div class="qa-card-header">
        <span class="qa-badge ${item.autoSaved ? 'learned' : ''}">${item.autoSaved ? 'Auto-Learned' : 'Custom'}</span>
        <button type="button" class="btn-icon-danger btn-delete-qa" data-idx="${idx}" title="Delete question">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
        </button>
      </div>
      <div class="qa-inputs-grid">
        <div class="qa-field">
          <label>Question Prompt</label>
          <input type="text" class="qa-question-val" data-idx="${idx}" value="${escapeHtml(item.question || '')}" placeholder="e.g. Why are you interested in this role?" />
        </div>
        <div class="qa-field">
          <label>Saved Response</label>
          <textarea class="qa-answer-val" data-idx="${idx}" placeholder="e.g. I am passionate about building modern web applications...">${escapeHtml(item.answer || '')}</textarea>
        </div>
      </div>
    </div>
  `).join('');

  // Wire delete buttons
  container.querySelectorAll('.btn-delete-qa').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(e.currentTarget.getAttribute('data-idx'), 10);
      deleteCustomQA(idx);
    });
  });

  // Wire input changes to update state
  container.querySelectorAll('.qa-question-val').forEach((inp) => {
    inp.addEventListener('input', (e) => {
      const idx = parseInt(e.target.getAttribute('data-idx'), 10);
      if (currentCustomQA[idx]) currentCustomQA[idx].question = e.target.value;
    });
  });

  container.querySelectorAll('.qa-answer-val').forEach((txt) => {
    txt.addEventListener('input', (e) => {
      const idx = parseInt(e.target.getAttribute('data-idx'), 10);
      if (currentCustomQA[idx]) currentCustomQA[idx].answer = e.target.value;
    });
  });
}

/**
 * Add a new blank custom Q&A card
 */
function addCustomQA(question = '', answer = '') {
  currentCustomQA.push({
    id: 'qa_' + Date.now(),
    question: question,
    answer: answer,
    autoSaved: false,
  });
  renderCustomQAList();

  // Scroll to bottom of Q&A list
  const container = document.getElementById('customQAList');
  if (container) {
    const lastCard = container.lastElementChild;
    lastCard?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    lastCard?.querySelector('.qa-question-val')?.focus();
  }
}

/**
 * Delete a custom Q&A card by index
 * @param {number} idx
 */
function deleteCustomQA(idx) {
  currentCustomQA.splice(idx, 1);
  renderCustomQAList();
  showToast('Question removed from Knowledge Base', 'success');
}

/**
 * Gather clean custom Q&A items from state
 * @returns {Array}
 */
function gatherCustomQA() {
  return currentCustomQA.filter((item) => (item.question && item.question.trim()) || (item.answer && item.answer.trim()));
}


// ============================================================
// 2B. WORK HISTORY MANAGER (DYNAMIC MULTI-EXPERIENCE)
// ============================================================

/**
 * Render the dynamic list of past work experience entries
 */
function renderExperienceList() {
  const container = document.getElementById('experienceList');
  if (!container) return;

  if (currentWorkHistory.length === 0) {
    container.innerHTML = `
      <div class="exp-empty-state">
        <span>No additional past roles added yet. Click <strong>+ Add Experience</strong> to list previous companies, internships, or earlier career positions.</span>
      </div>
    `;
    return;
  }

  // Ensure legacy duration strings are split into startDate / endDate if missing
  currentWorkHistory.forEach((item) => {
    if (!item.startDate && item.duration) {
      const parts = item.duration.split(/\s*[-–—to]+\s*/i);
      if (parts.length >= 2) {
        item.startDate = parts[0]?.trim() || '';
        item.endDate = parts[1]?.trim() || '';
      } else {
        item.startDate = item.duration.trim();
      }
    }
  });

  container.innerHTML = currentWorkHistory.map((item, idx) => `
    <div class="dynamic-entry-card" data-idx="${idx}">
      <div class="entry-card-header">
        <div class="entry-card-header-left">
          <span class="entry-index-badge">Role #${idx + 1}</span>
          <span class="entry-title-preview">${escapeHtml(item.jobTitle || 'Untitled Position')}</span>
          ${item.company ? `<span class="entry-company-preview">at ${escapeHtml(item.company)}</span>` : ''}
        </div>
        <button type="button" class="btn-icon-danger btn-delete-exp" data-idx="${idx}" title="Remove role">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
        </button>
      </div>
      <div class="form-grid">
        <div class="form-group">
          <label>Job Title</label>
          <input type="text" class="exp-title-input" data-idx="${idx}" value="${escapeHtml(item.jobTitle || '')}" placeholder="e.g. Software Engineer" />
        </div>
        <div class="form-group">
          <label>Company / Organization</label>
          <input type="text" class="exp-company-input" data-idx="${idx}" value="${escapeHtml(item.company || '')}" placeholder="e.g. Acme Corp" />
        </div>
        <div class="form-group">
          <label>Start Date</label>
          <div class="datepicker-input-wrapper">
            <input type="text" class="exp-start-input month-year-input" data-idx="${idx}" value="${escapeHtml(item.startDate || '')}" placeholder="Select Month &amp; Year" readonly />
            <button type="button" class="btn-picker-icon" tabindex="-1" title="Select Month &amp; Year">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                <line x1="16" y1="2" x2="16" y2="6"></line>
                <line x1="8" y1="2" x2="8" y2="6"></line>
                <line x1="3" y1="10" x2="21" y2="10"></line>
              </svg>
            </button>
          </div>
        </div>
        <div class="form-group">
          <label>End Date</label>
          <div class="end-date-wrapper">
            <div class="datepicker-input-wrapper" style="flex: 1;">
              <input type="text" class="exp-end-input month-year-input is-end-date" data-idx="${idx}" value="${escapeHtml(item.endDate || '')}" placeholder="Select Month &amp; Year or Present" readonly />
              <button type="button" class="btn-picker-icon" tabindex="-1" title="Select Month &amp; Year">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                  <line x1="16" y1="2" x2="16" y2="6"></line>
                  <line x1="8" y1="2" x2="8" y2="6"></line>
                  <line x1="3" y1="10" x2="21" y2="10"></line>
                </svg>
              </button>
            </div>
            <button type="button" class="btn-present-chip" data-idx="${idx}" title="Set End Date to Present">Present</button>
          </div>
        </div>
        <div class="form-group full-width">
          <label>Key Responsibilities &amp; Achievements</label>
          <textarea class="exp-desc-input" data-idx="${idx}" placeholder="Architected microservices, mentored developers, improved system uptime...">${escapeHtml(item.description || '')}</textarea>
        </div>
      </div>
    </div>
  `).join('');

  // Wire delete buttons
  container.querySelectorAll('.btn-delete-exp').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(e.currentTarget.getAttribute('data-idx'), 10);
      deleteExperience(idx);
    });
  });

  // Wire input listeners to update state in real-time
  container.querySelectorAll('.exp-title-input').forEach((inp) => {
    inp.addEventListener('input', (e) => {
      const idx = parseInt(e.target.getAttribute('data-idx'), 10);
      if (currentWorkHistory[idx]) {
        currentWorkHistory[idx].jobTitle = e.target.value;
        const preview = e.target.closest('.dynamic-entry-card')?.querySelector('.entry-title-preview');
        if (preview) preview.textContent = e.target.value.trim() || 'Untitled Position';
      }
    });
  });

  container.querySelectorAll('.exp-company-input').forEach((inp) => {
    inp.addEventListener('input', (e) => {
      const idx = parseInt(e.target.getAttribute('data-idx'), 10);
      if (currentWorkHistory[idx]) {
        currentWorkHistory[idx].company = e.target.value;
        const preview = e.target.closest('.dynamic-entry-card')?.querySelector('.entry-company-preview');
        if (preview) preview.textContent = e.target.value.trim() ? `at ${e.target.value.trim()}` : '';
      }
    });
  });

  container.querySelectorAll('.exp-start-input').forEach((inp) => {
    inp.addEventListener('input', (e) => {
      const idx = parseInt(e.target.getAttribute('data-idx'), 10);
      if (currentWorkHistory[idx]) {
        currentWorkHistory[idx].startDate = e.target.value;
        currentWorkHistory[idx].duration = [e.target.value, currentWorkHistory[idx].endDate].filter(Boolean).join(' – ');
      }
    });
  });

  container.querySelectorAll('.exp-end-input').forEach((inp) => {
    inp.addEventListener('input', (e) => {
      const idx = parseInt(e.target.getAttribute('data-idx'), 10);
      if (currentWorkHistory[idx]) {
        currentWorkHistory[idx].endDate = e.target.value;
        currentWorkHistory[idx].duration = [currentWorkHistory[idx].startDate, e.target.value].filter(Boolean).join(' – ');
      }
    });
  });

  container.querySelectorAll('.btn-present-chip').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(e.currentTarget.getAttribute('data-idx'), 10);
      if (currentWorkHistory[idx]) {
        currentWorkHistory[idx].endDate = 'Present';
        currentWorkHistory[idx].duration = [currentWorkHistory[idx].startDate, 'Present'].filter(Boolean).join(' – ');
        const endInp = container.querySelector(`.exp-end-input[data-idx="${idx}"]`);
        if (endInp) {
          endInp.value = 'Present';
          endInp.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
    });
  });

  container.querySelectorAll('.exp-desc-input').forEach((txt) => {
    txt.addEventListener('input', (e) => {
      const idx = parseInt(e.target.getAttribute('data-idx'), 10);
      if (currentWorkHistory[idx]) currentWorkHistory[idx].description = e.target.value;
    });
  });
}

/**
 * Add a new work experience entry
 */
function addExperience(jobTitle = '', company = '', startDate = '', endDate = '', description = '', duration = '') {
  if (!startDate && duration) {
    const parts = duration.split(/\s*[-–—to]+\s*/i);
    startDate = parts[0]?.trim() || '';
    endDate = parts[1]?.trim() || '';
  }
  const computedDuration = duration || [startDate, endDate].filter(Boolean).join(' – ');
  currentWorkHistory.push({
    id: 'exp_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
    jobTitle,
    company,
    startDate,
    endDate,
    duration: computedDuration,
    description,
  });
  renderExperienceList();

  // Scroll to new entry and focus
  const container = document.getElementById('experienceList');
  if (container) {
    const lastCard = container.lastElementChild;
    lastCard?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    lastCard?.querySelector('.exp-title-input')?.focus();
  }
}

/**
 * Delete a work experience entry by index
 */
function deleteExperience(idx) {
  currentWorkHistory.splice(idx, 1);
  renderExperienceList();
  showToast('Role removed from experience history', 'success');
}

/**
 * Gather valid work history entries
 */
function gatherWorkHistory() {
  return currentWorkHistory.filter(
    (exp) =>
      (exp.jobTitle && exp.jobTitle.trim()) ||
      (exp.company && exp.company.trim()) ||
      (exp.startDate && exp.startDate.trim()) ||
      (exp.endDate && exp.endDate.trim()) ||
      (exp.description && exp.description.trim())
  );
}


// ============================================================
// 2C. SKILLS TAGS MANAGER (INTERACTIVE CHIPS + RAW SYNC)
// ============================================================

/**
 * Parse skills string into a clean array of unique skill names
 */
function parseSkillsArray(str) {
  if (!str || typeof str !== 'string') return [];
  return Array.from(new Set(
    str
      .split(/[,;\n•]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  ));
}

/**
 * Render interactive skill tags based on the current #skills textarea value
 */
function renderSkillTags() {
  const container = document.getElementById('skillsTagContainer');
  const skillsInput = document.getElementById('skills');
  if (!container || !skillsInput) return;

  const skills = parseSkillsArray(skillsInput.value);

  if (skills.length === 0) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = skills.map((skill) => `
    <span class="skill-chip">
      <span>${escapeHtml(skill)}</span>
      <button type="button" class="btn-remove-skill" data-skill="${escapeHtml(skill)}" title="Remove skill">&times;</button>
    </span>
  `).join('');

  // Wire remove buttons
  container.querySelectorAll('.btn-remove-skill').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const skillToRemove = e.currentTarget.getAttribute('data-skill');
      removeSkill(skillToRemove);
    });
  });
}

/**
 * Add one or more skills (supports comma-separated) and sync to textarea
 */
function addSkill(skillName) {
  if (!skillName || !skillName.trim()) return;
  const skillsInput = document.getElementById('skills');
  if (!skillsInput) return;

  const currentSkills = parseSkillsArray(skillsInput.value);
  const newSkills = parseSkillsArray(skillName);

  let addedCount = 0;
  newSkills.forEach((s) => {
    if (!currentSkills.some((existing) => existing.toLowerCase() === s.toLowerCase())) {
      currentSkills.push(s);
      addedCount++;
    }
  });

  if (addedCount > 0) {
    skillsInput.value = currentSkills.join(', ');
    renderSkillTags();
    showToast(`Added: ${newSkills.join(', ')}`, 'success');
  }

  const newSkillInput = document.getElementById('newSkillInput');
  if (newSkillInput) {
    newSkillInput.value = '';
    newSkillInput.focus();
  }
}

/**
 * Remove a skill by name and sync to textarea
 */
function removeSkill(skillToRemove) {
  const skillsInput = document.getElementById('skills');
  if (!skillsInput) return;

  const currentSkills = parseSkillsArray(skillsInput.value);
  const filtered = currentSkills.filter(
    (s) => s.toLowerCase() !== (skillToRemove || '').toLowerCase().trim()
  );

  skillsInput.value = filtered.join(', ');
  renderSkillTags();
}


// ============================================================
// 2D. THEME MANAGER (DARK / LIGHT / NO ALL-BLACK)
// ============================================================

function initTheme() {
  let theme = localStorage.getItem('quickfill_theme');
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
  if (hasStorage()) {
    chrome.storage.local.set({ theme });
  }
}

function toggleTheme() {
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  const newTheme = isLight ? 'dark' : 'light';
  applyTheme(newTheme);
  showToast(`Switched to ${newTheme === 'light' ? 'Light' : 'Slate Dark'} theme`, 'success');
}


// ============================================================
// 2E. MONTH & YEAR PICKER COMPONENT (PREVENTS INVALID INPUTS)
// ============================================================

const MonthYearPicker = {
  activeInput: null,
  selectedYear: new Date().getFullYear(),
  selectedMonth: null, // 0-indexed (0 = January)
  isOpen: false,

  MONTH_NAMES: [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ],

  MONTH_SHORT: [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
  ],

  init() {
    this.pickerEl = document.getElementById('monthYearPicker');
    if (!this.pickerEl) return;

    this.yearSelect = document.getElementById('pickerYearSelect');
    this.monthsGrid = document.getElementById('pickerMonthsGrid');
    this.prevYearBtn = document.getElementById('pickerPrevYear');
    this.nextYearBtn = document.getElementById('pickerNextYear');
    this.btnPresent = document.getElementById('pickerBtnPresent');
    this.btnClear = document.getElementById('pickerBtnClear');
    this.btnClose = document.getElementById('pickerBtnClose');

    // Populate year selector (from 1970 to current year + 6)
    const currentYear = new Date().getFullYear();
    const startYear = 1970;
    const endYear = currentYear + 6;
    let yearOptions = '';
    for (let y = endYear; y >= startYear; y--) {
      yearOptions += `<option value="${y}">${y}</option>`;
    }
    if (this.yearSelect) {
      this.yearSelect.innerHTML = yearOptions;
    }

    // Render 12 month buttons
    if (this.monthsGrid) {
      this.monthsGrid.innerHTML = this.MONTH_SHORT.map((m, idx) => `
        <button type="button" class="picker-month-btn" data-month="${idx}">
          ${m}
        </button>
      `).join('');
    }

    // Event listeners
    this.prevYearBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.setYear(this.selectedYear - 1);
    });

    this.nextYearBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.setYear(this.selectedYear + 1);
    });

    this.yearSelect?.addEventListener('change', (e) => {
      this.setYear(parseInt(e.target.value, 10));
    });

    this.monthsGrid?.addEventListener('click', (e) => {
      const btn = e.target.closest('.picker-month-btn');
      if (btn) {
        const monthIdx = parseInt(btn.getAttribute('data-month'), 10);
        this.selectMonth(monthIdx);
      }
    });

    this.btnPresent?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.setValue('Present');
      this.close();
    });

    this.btnClear?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.setValue('');
      this.close();
    });

    this.btnClose?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.close();
    });

    // Close on outside click
    document.addEventListener('pointerdown', (e) => {
      if (!this.isOpen) return;
      if (
        !this.pickerEl.contains(e.target) &&
        (!this.activeInput || !this.activeInput.contains(e.target)) &&
        !e.target.closest('.btn-picker-icon')
      ) {
        this.close();
      }
    });

    // Close on Escape key
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isOpen) {
        this.close();
      }
    });

    // Delegated click listener to open picker on any .month-year-input or .btn-picker-icon
    document.addEventListener('click', (e) => {
      const input = e.target.closest('.month-year-input');
      if (input) {
        this.open(input);
        return;
      }
      const iconBtn = e.target.closest('.btn-picker-icon');
      if (iconBtn) {
        const wrapper = iconBtn.closest('.datepicker-input-wrapper');
        const targetInput = wrapper?.querySelector('.month-year-input');
        if (targetInput) {
          this.open(targetInput);
        }
      }
    });
  },

  setYear(year) {
    this.selectedYear = year;
    if (this.yearSelect) {
      this.yearSelect.value = year;
    }
    this.updateMonthHighlights();
  },

  selectMonth(monthIdx) {
    this.selectedMonth = monthIdx;
    const formatted = `${this.MONTH_NAMES[monthIdx]} ${this.selectedYear}`;
    this.setValue(formatted);
    this.close();
  },

  setValue(val) {
    if (!this.activeInput) return;
    this.activeInput.value = val;
    this.activeInput.dispatchEvent(new Event('input', { bubbles: true }));
    this.activeInput.dispatchEvent(new Event('change', { bubbles: true }));
  },

  updateMonthHighlights() {
    if (!this.monthsGrid) return;
    const btns = this.monthsGrid.querySelectorAll('.picker-month-btn');
    btns.forEach((btn) => {
      const m = parseInt(btn.getAttribute('data-month'), 10);
      btn.classList.toggle('selected', m === this.selectedMonth);
    });
  },

  open(inputEl) {
    if (!this.pickerEl) return;
    this.activeInput = inputEl;

    // Parse current value in input
    const currentVal = (inputEl.value || '').trim();
    const currentYear = new Date().getFullYear();
    const currentMonth = new Date().getMonth();

    if (currentVal.toLowerCase() === 'present') {
      this.selectedYear = currentYear;
      this.selectedMonth = null;
    } else if (currentVal) {
      let foundMonth = null;
      let foundYear = null;

      const isoMatch = currentVal.match(/^(\d{4})[-/](\d{1,2})$/);
      if (isoMatch) {
        foundYear = parseInt(isoMatch[1], 10);
        foundMonth = parseInt(isoMatch[2], 10) - 1;
      } else {
        this.MONTH_NAMES.forEach((name, idx) => {
          if (new RegExp(name.substr(0, 3), 'i').test(currentVal)) {
            foundMonth = idx;
          }
        });
        const yearMatch = currentVal.match(/\b(19\d\d|20\d\d)\b/);
        if (yearMatch) {
          foundYear = parseInt(yearMatch[1], 10);
        }
      }

      this.selectedYear = foundYear || currentYear;
      this.selectedMonth = foundMonth !== null ? foundMonth : currentMonth;
    } else {
      this.selectedYear = currentYear;
      this.selectedMonth = currentMonth;
    }

    this.setYear(this.selectedYear);
    this.updateMonthHighlights();

    // Check if this input is an End Date (can show "Present" button)
    const isEndDate =
      inputEl.classList.contains('is-end-date') ||
      inputEl.classList.contains('exp-end-input') ||
      inputEl.id === 'currentEndDate';

    if (this.btnPresent) {
      this.btnPresent.style.display = isEndDate ? 'inline-flex' : 'none';
    }

    // Position the popover near the target input
    const rect = inputEl.getBoundingClientRect();
    const pickerWidth = 280;
    const pickerHeight = 220;

    let left = rect.left;
    if (left + pickerWidth > window.innerWidth - 12) {
      left = window.innerWidth - pickerWidth - 12;
    }
    if (left < 12) left = 12;

    let top = rect.bottom + 6;
    if (top + pickerHeight > window.innerHeight && rect.top > pickerHeight + 12) {
      top = rect.top - pickerHeight - 6;
    }

    this.pickerEl.style.left = `${left}px`;
    this.pickerEl.style.top = `${top}px`;
    this.pickerEl.classList.add('open');
    this.isOpen = true;
  },

  close() {
    if (!this.pickerEl) return;
    this.pickerEl.classList.remove('open');
    this.isOpen = false;
    this.activeInput = null;
  },
};


// ============================================================
// 3. RESUME QUICK IMPORT
// ============================================================

/**
 * Handle resume file selection, persistence, and data extraction
 * @param {File} file
 */
async function handleResumeUpload(file) {
  if (!file) return;

  const statusEl = document.getElementById('resumeStatus');
  statusEl.style.display = 'flex';
  statusEl.className = 'resume-status-box loading';
  statusEl.innerHTML = `<span class="geist-spinner"></span><span>Reading and saving <strong>${escapeHtml(file.name)}</strong>…</span>`;

  try {
    let resumeText = '';
    let base64Pdf = null;
    const arrayBuffer = await file.arrayBuffer();

    // 1. Convert to Base64 cleanly and safely
    base64Pdf = arrayBufferToBase64(arrayBuffer);

    // 2. Extract text (using pure JS Flate decompression for PDF)
    if (file.type === 'application/pdf' || file.name.endsWith('.pdf')) {
      if (window.QuickFillResumeParser && window.QuickFillResumeParser.extractTextFromPDFBuffer) {
        resumeText = await window.QuickFillResumeParser.extractTextFromPDFBuffer(arrayBuffer);
      } else {
        resumeText = extractTextFromPDFBuffer(arrayBuffer);
      }
    } else {
      resumeText = await file.text();
    }

    // 3. PERSIST RESUME FILE IMMEDIATELY to chrome.storage.local
    const resumeData = {
      name: file.name,
      type: file.type || 'application/pdf',
      size: file.size,
      lastModified: file.lastModified || Date.now(),
      base64: base64Pdf,
      extractedText: (resumeText || '').substring(0, 8000),
      uploadedAt: new Date().toISOString(),
    };
    currentSavedResume = resumeData;

    if (hasStorage()) {
      await chrome.storage.local.set({ savedResume: resumeData });
    } else {
      localStorage.setItem('quickfill_savedResume', JSON.stringify(resumeData));
    }
    renderSavedResumeBadge(resumeData);

    statusEl.innerHTML = `<span class="geist-spinner"></span><span>Extracting candidate details from <strong>${escapeHtml(file.name)}</strong>…</span>`;

    // 4. Parse resume data (try background worker, fallback to in-page parser)
    const aiSettings = gatherAISettings();
    let response = null;

    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      try {
        response = await chrome.runtime.sendMessage({
          action: 'PARSE_RESUME',
          resumeText,
          base64Pdf,
          mimeType: file.type || 'application/pdf',
          aiSettings,
        });
      } catch (msgErr) {
        console.warn('[QuickFill] Background message failed, using in-page parser:', msgErr);
      }
    }

    if (!response && window.QuickFillResumeParser) {
      response = await window.QuickFillResumeParser.parseResume({
        resumeText,
        base64Pdf,
        mimeType: file.type || 'application/pdf',
        aiSettings,
      });
    }

    if (!response || response.error) {
      throw new Error(response?.error || 'Resume parsing service returned empty data');
    }

    const { profile = {}, customQA = [] } = response;
    let populatedCount = 0;

    // 5. Populate profile inputs
    Object.entries(profile).forEach(([field, value]) => {
      const el = document.getElementById(field);
      if (el && value && String(value).trim()) {
        el.value = String(value).trim();
        populatedCount++;
        // Visual highlight
        el.style.borderColor = 'var(--accent-blue)';
        setTimeout(() => { el.style.borderColor = ''; }, 3000);
      }
    });

    // Auto-compute fullName if missing
    if (!document.getElementById('fullName').value && (profile.firstName || profile.lastName)) {
      document.getElementById('fullName').value = [profile.firstName, profile.lastName].filter(Boolean).join(' ');
    }

    // Update interactive skill tags
    renderSkillTags();

    // Populate parsed work history if returned from resume parser
    if (Array.isArray(profile.workHistory) && profile.workHistory.length > 0) {
      currentWorkHistory = profile.workHistory;
      renderExperienceList();
    }

    // 6. Merge custom Q&A items
    let qaCount = 0;
    if (Array.isArray(customQA) && customQA.length > 0) {
      customQA.forEach((newQA) => {
        if (!newQA.question || !newQA.answer) return;
        const exists = currentCustomQA.some(
          (q) => q.question.toLowerCase().trim() === newQA.question.toLowerCase().trim()
        );
        if (!exists) {
          currentCustomQA.push({
            id: 'qa_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
            question: newQA.question,
            answer: newQA.answer,
            autoSaved: true,
          });
          qaCount++;
        }
      });
      renderCustomQAList();
    }

    // 7. Auto-save populated profile so user data is instantly saved
    const updatedProfile = gatherProfile();
    const updatedQA = gatherCustomQA();
    if (hasStorage()) {
      await chrome.storage.local.set({
        profile: updatedProfile,
        customQA: updatedQA,
        savedResume: resumeData,
      });
    } else {
      localStorage.setItem('quickfill_profile', JSON.stringify(updatedProfile));
      localStorage.setItem('quickfill_customQA', JSON.stringify(updatedQA));
      localStorage.setItem('quickfill_savedResume', JSON.stringify(resumeData));
    }

    statusEl.className = 'resume-status-box success';
    statusEl.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><polyline points="20 6 9 17 4 12"></polyline></svg><span>Success! Resume saved & ready to auto-upload on job forms. Extracted <strong>${populatedCount} profile fields</strong> and <strong>${qaCount} custom questions</strong>.</span>`;
    showToast(`Resume saved & imported! ${populatedCount} fields populated.`, 'success');

  } catch (err) {
    console.error('[Resume Parse Error]', err);
    statusEl.className = 'resume-status-box error';
    statusEl.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg><span>Parsing error: ${escapeHtml(err.message)}</span>`;
    showToast('Failed to parse resume: ' + err.message, 'error');
  }
}

/**
 * Remove saved resume from storage and UI
 */
async function deleteSavedResume() {
  currentSavedResume = null;
  if (hasStorage()) {
    await chrome.storage.local.remove('savedResume');
  } else {
    localStorage.removeItem('quickfill_savedResume');
  }
  renderSavedResumeBadge(null);
  const statusEl = document.getElementById('resumeStatus');
  if (statusEl) statusEl.style.display = 'none';
  showToast('Saved resume removed.', 'success');
}

/**
 * Pure client-side PDF text extraction from ArrayBuffer (fallback)
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
function extractTextFromPDFBuffer(buffer) {
  try {
    const bytes = new Uint8Array(buffer);
    let str = '';
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      str += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }

    const textChunks = [];
    const streamRegex = /BT[\s\S]*?ET/g;
    let match;
    while ((match = streamRegex.exec(str)) !== null) {
      const block = match[0];
      const tjRegex = /\(([^)]+)\)\s*(?:Tj|'|")/g;
      let tjMatch;
      while ((tjMatch = tjRegex.exec(block)) !== null) {
        textChunks.push(tjMatch[1]);
      }
      const arrayTjRegex = /\[([^\]]+)\]\s*TJ/g;
      let arrayMatch;
      while ((arrayMatch = arrayTjRegex.exec(block)) !== null) {
        const inner = arrayMatch[1];
        const innerTj = /\(([^)]+)\)/g;
        let im;
        while ((im = innerTj.exec(inner)) !== null) {
          textChunks.push(im[1]);
        }
      }
    }

    const result = textChunks.join(' ').replace(/\s+/g, ' ').trim();
    return result.length > 50 ? result : str.replace(/[^\x20-\x7E\n]/g, ' ');
  } catch (e) {
    return '';
  }
}

/**
 * Convert ArrayBuffer to Base64 string safely without call stack overflow
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 16384;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}


// ============================================================
// 4. SAVE & FORM SUBMISSION
// ============================================================

/**
 * Save profile, custom Q&A, and AI settings to chrome.storage.local
 */
function saveProfile(event) {
  event.preventDefault();

  const profile = gatherProfile();
  const customQA = gatherCustomQA();
  const aiSettings = gatherAISettings();

  // Basic validation: at least first name or email should be filled
  if (!profile.firstName && !profile.email) {
    showToast('Please fill in at least your first name or email.', 'error');
    return;
  }

  // Validate AI settings if enabled
  if (aiSettings.enabled && !aiSettings.apiKey) {
    showToast('AI is enabled but no API key is provided.', 'error');
    return;
  }

  const payload = { profile, customQA, aiSettings };
  if (currentSavedResume) {
    payload.savedResume = currentSavedResume;
  }

  if (!hasStorage()) {
    localStorage.setItem('quickfill_profile', JSON.stringify(profile));
    localStorage.setItem('quickfill_customQA', JSON.stringify(customQA));
    localStorage.setItem('quickfill_aiSettings', JSON.stringify(aiSettings));
    if (currentSavedResume) {
      localStorage.setItem('quickfill_savedResume', JSON.stringify(currentSavedResume));
    }
    showToast('Profile & Knowledge Base saved!', 'success');
    return;
  }

  chrome.storage.local.set(payload, () => {
    if (chrome.runtime.lastError) {
      showToast('Failed to save. ' + chrome.runtime.lastError.message, 'error');
    } else {
      showToast('Profile & Knowledge Base saved successfully!', 'success');
    }
  });
}


// ============================================================
// 5. UI UTILITIES & INITIALIZATION
// ============================================================

/**
 * Update the model dropdown options based on the selected provider
 * @param {string} provider - 'gemini' or 'openai'
 */
function updateModelOptions(provider) {
  const modelSelect = document.getElementById('aiModel');
  if (!modelSelect) return;

  const models = MODEL_OPTIONS[provider] || MODEL_OPTIONS.gemini;
  modelSelect.innerHTML = models
    .map((m) => `<option value="${m.value}">${m.label}</option>`)
    .join('');
}

/**
 * Update the API key hint text based on provider
 * @param {string} provider
 */
function updateApiKeyHint(provider) {
  const hint = document.getElementById('apiKeyHint');
  if (hint) {
    hint.innerHTML = API_KEY_HINTS[provider] || API_KEY_HINTS.gemini;
  }
}

/**
 * Show/hide the AI configuration fields based on the toggle state
 * @param {boolean} enabled
 */
function updateAIFieldsVisibility(enabled) {
  const wrapper = document.getElementById('aiFieldsWrapper');
  if (wrapper) {
    wrapper.style.display = enabled ? 'block' : 'none';
  }
}

/**
 * Toggle API key input visibility between password and text
 */
function toggleApiKeyVisibility() {
  const input = document.getElementById('aiApiKey');
  const btn = document.getElementById('toggleApiKeyVisibility');
  if (input.type === 'password') {
    input.type = 'text';
    btn.textContent = '🙈';
  } else {
    input.type = 'password';
    btn.textContent = '👁';
  }
}

/**
 * Show a toast notification (Vercel / Sonner style)
 * @param {string} message - Message to display
 * @param {'success'|'error'} type - Toast type
 */
function showToast(message, type = 'success') {
  const toast = document.getElementById('toast');
  if (!toast) return;

  toast.className = `toast ${type} visible`;
  toast.innerHTML = `<span>${type === 'success' ? '✓' : '✕'}</span><span>${escapeHtml(message)}</span>`;

  setTimeout(() => {
    toast.classList.remove('visible');
  }, 3500);
}

/**
 * Escape HTML special characters
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

/**
 * Test AI Connection using entered API key & provider
 */
async function testAIConnection() {
  const btn = document.getElementById('btnTestAI');
  const resultEl = document.getElementById('aiTestResult');
  const apiKey = document.getElementById('aiApiKey')?.value?.trim();
  const provider = document.getElementById('aiProvider')?.value || 'gemini';
  const model = document.getElementById('aiModel')?.value || 'gemini-3.8-flash';

  if (!apiKey) {
    resultEl.style.display = 'flex';
    resultEl.className = 'resume-status-box error';
    resultEl.innerHTML = '<span>Please enter your API secret key first.</span>';
    return;
  }

  // Ensure AI is enabled if testing
  const enabledEl = document.getElementById('aiEnabled');
  if (enabledEl && !enabledEl.checked) {
    enabledEl.checked = true;
    updateAIFieldsVisibility(true);
  }

  btn.disabled = true;
  btn.textContent = 'Pinging…';
  resultEl.style.display = 'flex';
  resultEl.className = 'resume-status-box loading';
  resultEl.innerHTML = `<span>Pinging <strong>${provider === 'gemini' ? 'Google Gemini' : 'OpenAI'}</strong> (${escapeHtml(model)})…</span>`;

  try {
    const aiSettings = gatherAISettings();
    let response;
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      response = await chrome.runtime.sendMessage({
        action: 'TEST_AI',
        aiSettings,
      });
    } else {
      // Direct fetch fallback for local browser testing
      const cleanKey = apiKey.replace(/^["']|["']$/g, '');
      const testModel = model || 'gemini-3.8-flash';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${testModel}:generateContent?key=${cleanKey}`;
      const startT = Date.now();
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: 'Respond with JSON {"status":"ok"}' }] }] }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData?.error?.message || `HTTP ${res.status}`);
      }
      response = { success: true, elapsed: Date.now() - startT, model: testModel };
    }

    if (response?.error) {
      throw new Error(response.error);
    }

    resultEl.className = 'resume-status-box success';
    resultEl.innerHTML = `<span><strong>Connection verified!</strong> Model <code>${escapeHtml(response.model || model)}</code> responded in ${response.elapsed || 0}ms.</span>`;
    showToast('AI connection verified', 'success');
  } catch (err) {
    resultEl.className = 'resume-status-box error';
    resultEl.innerHTML = `<span><strong>Connection failed:</strong> ${escapeHtml(err.message)}</span>`;
    showToast('AI test failed: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Test Connection';
  }
}

// ============================================================
// 6. ACTIVITY & ERROR LOGS VIEWER
// ============================================================

/**
 * Render activity and error logs recorded across the extension
 */
async function renderLogs() {
  const container = document.getElementById('logsViewer');
  if (!container) return;

  const logs = await (window.QuickFillLogger ? window.QuickFillLogger.getLogs() : []);
  if (!logs || logs.length === 0) {
    container.innerHTML = '<div style="color: var(--text-muted); padding: 8px 0;">No telemetry recorded yet. Everything is operational.</div>';
    return;
  }

  container.innerHTML = logs.map((log) => {
    let detailsStr = '';
    if (log.details && Object.keys(log.details).length > 0) {
      try {
        detailsStr = `<div style="font-size: 11px; color: var(--text-muted); margin-top: 3px; font-family: var(--font-mono);">${escapeHtml(JSON.stringify(log.details))}</div>`;
      } catch {}
    }
    return `
      <div class="log-entry-row">
        <span class="log-time">${escapeHtml(log.displayTime || '')}</span>
        <span class="log-tag ${escapeHtml(log.level)}">${escapeHtml(log.level)}</span>
        <span class="log-source-label">[${escapeHtml(log.source)}]</span>
        <span class="log-text">${escapeHtml(log.message)}${detailsStr}</span>
      </div>
    `;
  }).join('');
}

/**
 * Copy logs to clipboard for debugging or sharing
 */
async function copyLogs() {
  const logs = await (window.QuickFillLogger ? window.QuickFillLogger.getLogs() : []);
  if (!logs || logs.length === 0) {
    showToast('No logs to copy.', 'error');
    return;
  }
  const text = JSON.stringify(logs, null, 2);
  navigator.clipboard.writeText(text)
    .then(() => showToast('Logs copied to clipboard!', 'success'))
    .catch(() => showToast('Failed to copy logs.', 'error'));
}

/**
 * Clear all persisted logs
 */
async function clearLogs() {
  if (window.QuickFillLogger) {
    await window.QuickFillLogger.clearLogs();
  }
  await renderLogs();
  showToast('Logs cleared!', 'success');
}

// --- Initialize Event Listeners ---
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  loadProfile();
  renderLogs();
  MonthYearPicker.init();

  // Current Role "Present" button
  document.getElementById('btnCurrentPresent')?.addEventListener('click', () => {
    const endInp = document.getElementById('currentEndDate');
    if (endInp) {
      endInp.value = 'Present';
      endInp.dispatchEvent(new Event('input', { bubbles: true }));
      endInp.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });

  // Theme Toggle
  document.getElementById('themeToggle')?.addEventListener('click', toggleTheme);

  // Profile form submission
  document.getElementById('profileForm').addEventListener('submit', saveProfile);

  // Add Custom Q&A button
  document.getElementById('btnAddQA')?.addEventListener('click', () => {
    addCustomQA();
  });

  // Dynamic Work Experience (+ buttons)
  document.getElementById('btnAddExperience')?.addEventListener('click', () => {
    addExperience();
  });
  document.getElementById('btnAddExperienceInline')?.addEventListener('click', () => {
    addExperience();
  });

  // Dynamic Skills Manager (+ button & Enter key)
  const newSkillInput = document.getElementById('newSkillInput');
  const btnAddSkill = document.getElementById('btnAddSkill');

  btnAddSkill?.addEventListener('click', () => {
    if (newSkillInput && newSkillInput.value.trim()) {
      addSkill(newSkillInput.value.trim());
      newSkillInput.value = '';
    }
  });

  newSkillInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (newSkillInput.value.trim()) {
        addSkill(newSkillInput.value.trim());
        newSkillInput.value = '';
      }
    }
  });

  // Two-way sync: manual editing in #skills raw textarea immediately re-renders tags
  document.getElementById('skills')?.addEventListener('input', () => {
    renderSkillTags();
  });

  // Quick suggestions chips
  document.querySelectorAll('#quickSkillsChips .quick-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const skillName = chip.getAttribute('data-skill') || chip.textContent.replace('+', '').trim();
      if (skillName) {
        addSkill(skillName);
      }
    });
  });

  // Resume Upload handling
  const dropZone = document.getElementById('resumeDropZone');
  const fileInput = document.getElementById('resumeFileInput');
  const btnBrowse = document.getElementById('btnBrowseResume');

  btnBrowse?.addEventListener('click', () => fileInput?.click());
  fileInput?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) handleResumeUpload(file);
    // Reset file input value so selecting the same file again triggers change event
    e.target.value = '';
  });

  // Saved resume actions
  document.getElementById('btnReplaceResume')?.addEventListener('click', () => fileInput?.click());
  document.getElementById('btnDeleteResume')?.addEventListener('click', deleteSavedResume);

  // Drag and drop events
  dropZone?.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });

  dropZone?.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
  });

  dropZone?.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    const file = e.dataTransfer?.files?.[0];
    if (file) handleResumeUpload(file);
  });

  // AI toggle visibility
  document.getElementById('aiEnabled')?.addEventListener('change', (e) => {
    updateAIFieldsVisibility(e.target.checked);
  });

  // Provider change → update models + hint
  document.getElementById('aiProvider')?.addEventListener('change', (e) => {
    updateModelOptions(e.target.value);
    updateApiKeyHint(e.target.value);
  });

  // API key visibility toggle
  document.getElementById('toggleApiKeyVisibility')?.addEventListener('click', toggleApiKeyVisibility);

  // Test AI Connection button
  document.getElementById('btnTestAI')?.addEventListener('click', testAIConnection);

  // Auto-enable AI checkbox when typing API key
  document.getElementById('aiApiKey')?.addEventListener('input', (e) => {
    const enabledEl = document.getElementById('aiEnabled');
    if (e.target.value.trim().length > 0 && enabledEl && !enabledEl.checked) {
      enabledEl.checked = true;
      updateAIFieldsVisibility(true);
    }
  });

  // Logs Action Buttons
  document.getElementById('btnRefreshLogs')?.addEventListener('click', renderLogs);
  document.getElementById('btnCopyLogs')?.addEventListener('click', copyLogs);
  document.getElementById('btnClearLogs')?.addEventListener('click', clearLogs);

  // Global Ctrl+S / Cmd+S shortcut to save
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveProfile(e);
    }
  });

  // Sub-Navigation Tab Click & Active Highlighting
  const tabLinks = document.querySelectorAll('.tab-link');
  tabLinks.forEach((tab) => {
    tab.addEventListener('click', (e) => {
      tabLinks.forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
    });
  });

  // Auto-highlight active tab on scroll
  const sections = Array.from(document.querySelectorAll('section.card[id]'));
  window.addEventListener('scroll', () => {
    const scrollPos = window.scrollY + 120;
    for (let i = sections.length - 1; i >= 0; i--) {
      const sec = sections[i];
      if (sec.offsetTop <= scrollPos) {
        tabLinks.forEach((t) => {
          t.classList.toggle('active', t.getAttribute('href') === `#${sec.id}`);
        });
        break;
      }
    }
  }, { passive: true });
});
