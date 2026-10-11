/**
 * scripts/field-matcher.js — Field Identification & Knowledge Base Matching
 * 
 * Maps web form inputs to candidate profile properties and custom Q&A items
 * using multi-attribute heuristic matching and semantic keyword scoring.
 */

(function (global) {
  const DOM = global.QuickFillDOM;

  const FIELD_PATTERNS = {
    firstName: {
      regex: /first[\s_-]?name|given[\s_-]?name|fname|name[\s_-]?first|vorname|prénom|nombre/i,
      inputTypes: ['text'],
      autocomplete: 'given-name',
    },
    lastName: {
      regex: /last[\s_-]?name|family[\s_-]?name|lname|surname|name[\s_-]?last|nachname|nom(?!bre)/i,
      inputTypes: ['text'],
      autocomplete: 'family-name',
    },
    fullName: {
      regex: /full[\s_-]?name|your[\s_-]?name|^name$|display[\s_-]?name|candidate[\s_-]?name|applicant[\s_-]?name|awsm_applicant_name/i,
      inputTypes: ['text'],
      autocomplete: 'name',
    },
    email: {
      regex: /e[\s_-]?mail|correo|email[\s_-]?address|applicant[\s_-]?email|awsm_applicant_email/i,
      inputTypes: ['email', 'text'],
      autocomplete: 'email',
    },
    phone: {
      regex: /phone|tel(?:ephone)?|mobile|cell|número[\s_-]?de[\s_-]?tel|phone[\s_-]?number|contact[\s_-]?number|applicant[\s_-]?phone|awsm_applicant_phone/i,
      inputTypes: ['tel', 'text', 'number'],
      autocomplete: 'tel',
    },
    city: {
      regex: /\bcity\b|ciudad|location(?!.*(?:country|type|pref))|\bort\b|ville|city[\s_-]?town/i,
      inputTypes: ['text'],
      autocomplete: 'address-level2',
    },
    country: {
      regex: /\bcountry\b|país|nation|land(?!ing)|country[\s_-]?region/i,
      inputTypes: ['text'],
      autocomplete: 'country-name',
    },
    address: {
      regex: /\baddress\b|street|dirección|straße|adresse|street[\s_-]?address|mailing[\s_-]?address/i,
      inputTypes: ['text'],
      autocomplete: 'street-address',
    },
    linkedin: {
      regex: /linkedin|linked[\s_-]?in/i,
      inputTypes: ['url', 'text'],
    },
    github: {
      regex: /github|git[\s_-]?hub/i,
      inputTypes: ['url', 'text'],
    },
    portfolio: {
      regex: /portfolio|website|personal[\s_-]?site|personal[\s_-]?url|webpage|home[\s_-]?page|blog/i,
      inputTypes: ['url', 'text'],
    },
    // Work Experience
    currentJobTitle: {
      regex: /(?:current|most[\s_-]?recent|present)?[\s_-]?(?:job[\s_-]?title|current[\s_-]?role|position[\s_-]?title|current[\s_-]?position|designation)\b|job[\s_-]?title\b|occupation\b/i,
      inputTypes: ['text'],
    },
    currentCompany: {
      regex: /(?:current|most[\s_-]?recent|present)[\s_-]?(?:company|employer|organization|workplace)|current[\s_-]?employer|company[\s_-]?name\b/i,
      inputTypes: ['text'],
    },
    currentStartDate: {
      regex: /(?:job|work|employment|role|position)?[\s_-]?(?:start[\s_-]?date|from[\s_-]?date|date[\s_-]?from|start[\s_-]?month|start[\s_-]?year|started)\b/i,
      inputTypes: ['text', 'date', 'number'],
    },
    currentEndDate: {
      regex: /(?:job|work|employment|role|position)?[\s_-]?(?:end[\s_-]?date|to[\s_-]?date|date[\s_-]?to|end[\s_-]?month|end[\s_-]?year|ended|until)\b/i,
      inputTypes: ['text', 'date', 'number'],
    },
    yearsOfExperience: {
      regex: /years?[\s_-]?(?:of[\s_-]?)?experience|experience[\s_-]?years?|total[\s_-]?experience|work[\s_-]?experience[\s_-]?years?/i,
      inputTypes: ['text', 'number'],
    },
    desiredSalary: {
      regex: /(?:desired|expected|target|base|annual|minimum)[\s_-]?(?:salary|compensation|pay|rate|expectations?)|salary[\s_-]?(?:expectations?|requirement|desired|target)/i,
      inputTypes: ['text', 'number'],
    },
    experienceDescription: {
      regex: /(?:work|job|employment|professional)[\s_-]?(?:experience|history|background)[\s_-]?(?:summary|description|details)|key[\s_-]?accomplishments|role[\s_-]?description/i,
      inputTypes: ['text'],
    },
    // Education
    educationLevel: {
      regex: /(?:highest[\s_-]?)?(?:education[\s_-]?(?:level|completed)?|degree(?:[\s_-]?level)?|level[\s_-]?of[\s_-]?education)|highest[\s_-]?degree|qualification\b/i,
    },
    university: {
      regex: /(?:university|college|school|institution|alma[\s_-]?mater|institute)[\s_-]?(?:name)?/i,
      inputTypes: ['text'],
    },
    major: {
      regex: /(?:major|field[\s_-]?of[\s_-]?study|discipline|specialization|degree[\s_-]?(?:name|subject|major))/i,
      inputTypes: ['text'],
    },
    graduationYear: {
      regex: /(?:grad(?:uation)?|completion|passing)[\s_-]?(?:year|date)/i,
      inputTypes: ['text', 'number'],
    },
    gpa: {
      regex: /\bgpa\b|grade[\s_-]?point[\s_-]?average|\bcgpa\b/i,
      inputTypes: ['text', 'number'],
    },
    // Skills & Certifications
    skills: {
      regex: /(?:technical[\s_-]?)?skills|technologies|tech[\s_-]?stack|core[\s_-]?competencies|programming[\s_-]?languages|primary[\s_-]?skills/i,
      inputTypes: ['text'],
    },
    certifications: {
      regex: /(?:certifications?|licenses?|credentials?|professional[\s_-]?certifications?)/i,
      inputTypes: ['text'],
    },
    // Work Authorization & Preferences
    authorizedToWork: {
      regex: /work[\s_-]?(?:auth(?:orization)?|eligib(?:ility)?|permit)|authorized?[\s_-]?(?:to[\s_-]?)?work|legally[\s_-]?(?:authorized?|eligible|allowed)|right[\s_-]?to[\s_-]?work|employment[\s_-]?eligib/i,
      isYesNo: true,
    },
    requiresSponsorship: {
      regex: /sponsor(?:ship)?|visa[\s_-]?(?:sponsor|status|support|requirement)|require[\s_-]?(?:sponsor|visa)|immigration[\s_-]?sponsor|need[\s_-]?sponsor/i,
      isYesNo: true,
    },
    workPreference: {
      regex: /(?:work[\s_-]?(?:preference|arrangement|place|type|model)|hybrid[\s_-]?preference|remote[\s_-]?(?:preference|work|only)|location[\s_-]?preference)/i,
    },
    earliestStartDate: {
      regex: /(?:earliest[\s_-]?)?(?:start[\s_-]?date|date[\s_-]?available)|available[\s_-]?(?:to[\s_-]?start|from)|availability[\s_-]?date/i,
      inputTypes: ['text', 'date'],
    },
    noticePeriod: {
      regex: /notice[\s_-]?period|notice[\s_-]?duration/i,
      inputTypes: ['text', 'number'],
    },
    // Professional Summary & Bio
    summary: {
      regex: /summary|cover[\s_-]?letter|about[\s_-]?(?:you|me|yourself)?|bio(?:graphy)?|description|additional[\s_-]?info(?:rmation)?|introduction|tell[\s_-]?us|message|applicant[\s_-]?letter|awsm_applicant_letter/i,
      inputTypes: ['text'],
    },
  };

  const FieldMatcher = {
    FIELD_PATTERNS,

    /**
     * Match a form element against known profile field patterns
     * @param {HTMLElement} el
     * @returns {string|null} - Profile key (e.g. 'firstName', 'email')
     */
    matchFieldToProfile(el) {
      if (!el) return null;

      const attrsToCheck = [
        el.getAttribute('id'),
        el.getAttribute('name'),
        el.getAttribute('autocomplete'),
        el.getAttribute('placeholder'),
        el.getAttribute('aria-label'),
        el.getAttribute('data-automation-id'),
        el.getAttribute('data-test'),
        el.getAttribute('data-qa'),
        el.getAttribute('data-field-name'),
      ].filter(Boolean);

      const labelText = DOM ? DOM.findLabelText(el) : null;
      if (labelText) attrsToCheck.push(labelText);

      // Check specific keys first
      for (const [key, pattern] of Object.entries(FIELD_PATTERNS)) {
        if (key === 'fullName') continue; // Test specific firstName/lastName first
        for (const attr of attrsToCheck) {
          if (pattern.regex.test(attr)) return key;
        }
      }

      // Check fullName fallback
      if (FIELD_PATTERNS.fullName) {
        for (const attr of attrsToCheck) {
          if (FIELD_PATTERNS.fullName.regex.test(attr)) return 'fullName';
        }
      }

      return null;
    },

    /**
     * Clean and extract readable question text from a field
     * @param {HTMLElement} el
     * @returns {string|null}
     */
    findFieldQuestionText(el) {
      if (!el) return null;
      let text = DOM ? DOM.findLabelText(el) : null;

      if (!text || text.length < 3) {
        const container = el.closest('.field, .form-group, .application-question, [class*="question"], [class*="field"], [class*="form-item"]');
        if (container) {
          const heading = container.querySelector('label, legend, .label, [class*="title"], [class*="header"]');
          if (heading && !heading.contains(el)) text = heading.textContent;
        }
      }

      if (!text) {
        text = el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.name || el.id;
      }

      if (!text) return null;

      text = text
        .replace(/[\*✱]/g, '')
        .replace(/\s*\(?(required|optional)\)?\s*/gi, '')
        .replace(/\s+/g, ' ')
        .trim();

      return text.length >= 2 ? text : null;
    },

    /**
     * Extract question text for radio groups
     */
    findRadioGroupQuestionText(firstRadio, radios) {
      if (!firstRadio) return null;
      const fieldset = firstRadio.closest('fieldset');
      if (fieldset) {
        const legend = fieldset.querySelector('legend');
        if (legend && legend.textContent.trim()) {
          return legend.textContent.replace(/[\*✱]/g, '').trim();
        }
      }

      const container = firstRadio.closest('.field, .form-group, .application-question, [class*="question"], [class*="field"]');
      if (container) {
        const heading = container.querySelector('legend, .label, label, [class*="title"], [class*="header"]');
        const isRadioLabel = radios && Array.from(radios).some((r) => heading?.contains(r) || r.closest('label') === heading);
        if (heading && !isRadioLabel && heading.textContent.trim()) {
          return heading.textContent.replace(/[\*✱]/g, '').trim();
        }
      }

      if (firstRadio.name) {
        return firstRadio.name.replace(/[_-]/g, ' ').replace(/([A-Z])/g, ' $1').trim();
      }

      return null;
    },

    /**
     * Match a form question against user's saved Knowledge Base (Custom Q&A)
     * @param {string} formQuestionText
     * @param {Array} customQAList
     * @returns {Object|null}
     */
    findMatchingCustomQA(formQuestionText, customQAList) {
      if (!customQAList || customQAList.length === 0 || !formQuestionText) return null;
      const normForm = formQuestionText.toLowerCase().replace(/[^\w\s]/g, '').trim();

      // 1. Exact match
      for (const item of customQAList) {
        if (!item.question || !item.answer) continue;
        const normSaved = item.question.toLowerCase().replace(/[^\w\s]/g, '').trim();
        if (normForm === normSaved) return item;
      }

      // 2. Substring match
      for (const item of customQAList) {
        if (!item.question || !item.answer) continue;
        const normSaved = item.question.toLowerCase().replace(/[^\w\s]/g, '').trim();
        if (normForm.includes(normSaved) || normSaved.includes(normForm)) return item;
      }

      // 3. Keyword overlap match
      const stopWords = new Set(['what', 'your', 'about', 'tell', 'have', 'with', 'this', 'that', 'from', 'please', 'describe', 'enter', 'the', 'and']);
      const formWords = new Set(normForm.split(/\s+/).filter((w) => w.length > 2 && !stopWords.has(w)));
      if (formWords.size === 0) return null;

      let bestMatch = null;
      let bestScore = 0;

      for (const item of customQAList) {
        if (!item.question || !item.answer) continue;
        const normSaved = item.question.toLowerCase().replace(/[^\w\s]/g, '').trim();
        const savedWords = normSaved.split(/\s+/).filter((w) => w.length > 2 && !stopWords.has(w));
        if (savedWords.length === 0) continue;

        let overlap = 0;
        for (const sw of savedWords) {
          if (formWords.has(sw)) overlap++;
        }

        const score = overlap / Math.min(formWords.size, savedWords.length);
        if (score >= 0.5 && score > bestScore) {
          bestScore = score;
          bestMatch = item;
        }
      }

      return bestMatch;
    },

    /**
     * Determine if a file input element is intended for resume/CV upload
     * @param {HTMLInputElement} el
     * @param {number} [totalFileInputsCount=1]
     * @returns {boolean}
     */
    isResumeFileInput(el, totalFileInputsCount = 1) {
      if (!el || el.tagName !== 'INPUT' || el.type !== 'file') return false;

      const excludePattern = /photo|avatar|headshot|profile[\s_-]?(?:pic|image)|transcript|video|certificate|portfolio[\s_-]?file/i;
      const resumePattern = /\b(?:resume|cv|curriculum[\s_-]?vitae|applicant[\s_-]?cv|awsm_applicant_cv|candidate[\s_-]?cv|upload[\s_-]?resume|attach[\s_-]?resume|my[\s_-]?resume)\b/i;

      const id = el.id || '';
      const name = el.name || '';
      const aria = (typeof el.getAttribute === 'function' ? el.getAttribute('aria-label') : '') || '';
      const dataAttr = typeof el.getAttribute === 'function'
        ? (el.getAttribute('data-automation-id') || '') + ' ' + (el.getAttribute('data-qa') || '')
        : '';
      const labelText = DOM ? (DOM.findLabelText(el) || '') : '';
      const parentText = el.parentElement ? (el.parentElement.textContent || '').substring(0, 150) : '';

      const combined = `${id} ${name} ${aria} ${dataAttr} ${labelText} ${parentText}`.toLowerCase();

      // Check for explicit exclusions
      if (excludePattern.test(combined)) {
        return false;
      }

      // Check for explicit resume patterns
      if (resumePattern.test(combined)) {
        return true;
      }

      // If only one file input on the entire form, it is overwhelmingly the resume
      if (totalFileInputsCount === 1) {
        return true;
      }

      return false;
    },
  };

  global.QuickFillMatcher = FieldMatcher;
})(typeof self !== 'undefined' ? self : this);
