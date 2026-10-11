/**
 * scripts/dom-filler.js — DOM Traversal & Framework-Safe Value Setting
 * 
 * Works reliably across React, Vue, Angular, and vanilla HTML forms.
 * Bypasses synthetic event listeners by invoking native prototype setters.
 */

(function (global) {
  const DOMFiller = {
    /**
     * Recursively collect all fillable form elements, piercing shadow DOMs and accessible iframes
     * @param {Document|ShadowRoot|Element} [root]
     * @returns {HTMLElement[]}
     */
    getAllFillableElements(root = document) {
      const elements = [];
      const selectors = 'input, textarea, select';

      function collectFromRoot(currentRoot) {
        if (!currentRoot || !currentRoot.querySelectorAll) return;

        try {
          const matched = currentRoot.querySelectorAll(selectors);
          matched.forEach((el) => elements.push(el));
        } catch {}

        // Shadow DOM traversal
        try {
          const allEls = currentRoot.querySelectorAll('*');
          allEls.forEach((el) => {
            if (el.shadowRoot) collectFromRoot(el.shadowRoot);
          });
        } catch {}

        // Accessible iframes traversal
        try {
          const iframes = currentRoot.querySelectorAll('iframe');
          iframes.forEach((iframe) => {
            try {
              if (iframe.contentDocument) collectFromRoot(iframe.contentDocument);
            } catch {}
          });
        } catch {}
      }

      collectFromRoot(root);
      return elements;
    },

    /**
     * Check if element is visible and interactive
     * @param {HTMLElement} el
     * @returns {boolean}
     */
    isVisible(el) {
      if (!el || el.type === 'hidden' || el.disabled) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      if (el.offsetWidth === 0 && el.offsetHeight === 0) return false;
      return true;
    },

    /**
     * Check if field already contains user input
     * @param {HTMLElement} el
     * @returns {boolean}
     */
    isAlreadyFilled(el) {
      if (!el) return false;
      if (el.tagName === 'SELECT') {
        return el.selectedIndex > 0;
      }
      return !!(el.value && el.value.trim().length > 0);
    },

    /**
     * Set value bypassing React/Vue/Angular property overrides
     * @param {HTMLInputElement|HTMLTextAreaElement} el
     * @param {string} value
     */
    setNativeValue(el, value) {
      const prototype = el instanceof HTMLTextAreaElement
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;

      const nativeSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (nativeSetter) {
        nativeSetter.call(el, value);
      } else {
        el.value = value;
      }

      // Dispatch events expected by modern reactivity engines
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    },

    /**
     * Fill select dropdown with fuzzy match
     * @param {HTMLSelectElement} select
     * @param {string} targetValue
     * @returns {boolean}
     */
    fillSelect(select, targetValue) {
      if (!select || !targetValue) return false;
      const cleanTarget = targetValue.toLowerCase().trim();
      let bestIndex = -1;

      // Exact match
      for (let i = 0; i < select.options.length; i++) {
        const text = select.options[i].text.toLowerCase().trim();
        const val = select.options[i].value.toLowerCase().trim();
        if (text === cleanTarget || val === cleanTarget) {
          bestIndex = i;
          break;
        }
      }

      // Substring match
      if (bestIndex === -1) {
        for (let i = 0; i < select.options.length; i++) {
          const text = select.options[i].text.toLowerCase().trim();
          const val = select.options[i].value.toLowerCase().trim();
          if ((text && text.includes(cleanTarget)) || (cleanTarget && cleanTarget.includes(text))) {
            bestIndex = i;
            break;
          }
        }
      }

      if (bestIndex !== -1 && bestIndex !== select.selectedIndex) {
        select.selectedIndex = bestIndex;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        select.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }
      return false;
    },

    /**
     * Fill radio button group
     * @param {HTMLInputElement} radio
     * @param {string} targetValue
     * @returns {boolean}
     */
    fillRadioGroup(radio, targetValue) {
      if (!radio || !radio.name) return false;
      const groupName = radio.name;
      const radios = document.querySelectorAll(`input[type="radio"][name="${CSS.escape(groupName)}"]`);
      const cleanTarget = targetValue.toLowerCase().trim();

      for (const r of radios) {
        const rVal = (r.value || '').toLowerCase().trim();
        const rLabel = (this.findLabelText(r) || '').toLowerCase().trim();

        if (rVal === cleanTarget || rLabel === cleanTarget || rLabel.includes(cleanTarget) || cleanTarget.includes(rLabel)) {
          if (!r.checked) {
            r.click();
            r.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
          return false;
        }
      }
      return false;
    },

    /**
     * Find associated label text for an element
     * @param {HTMLElement} el
     * @returns {string|null}
     */
    findLabelText(el) {
      if (!el) return null;

      // 1. Label with for="id"
      if (el.id && typeof document !== 'undefined' && typeof document.querySelector === 'function') {
        try {
          const escapedId = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(el.id) : el.id;
          const label = document.querySelector(`label[for="${escapedId}"]`);
          if (label) return label.textContent.trim();
        } catch {}
      }

      // 2. Parent wrapping label
      const parentLabel = typeof el.closest === 'function' ? el.closest('label') : null;
      if (parentLabel) {
        const clone = parentLabel.cloneNode(true);
        clone.querySelectorAll('input, textarea, select').forEach((i) => i.remove());
        const text = clone.textContent.trim();
        if (text) return text;
      }

      // 3. Previous sibling label / span
      const prev = el.previousElementSibling;
      if (prev && (prev.tagName === 'LABEL' || prev.tagName === 'SPAN' || prev.tagName === 'DIV')) {
        const text = prev.textContent.trim();
        if (text.length > 1 && text.length < 80) return text;
      }

      // 4. Form-group container heading
      const container = typeof el.closest === 'function'
        ? el.closest('.field, .form-group, .form-item, [class*="group"], [class*="field"]')
        : null;
      if (container) {
        const header = container.querySelector('label, legend, [class*="label"], [class*="title"]');
        if (header && !header.contains(el)) return header.textContent.trim();
      }

      return null;
    },

    /**
     * Highlight profile filled field (green)
     * @param {HTMLElement} el
     */
    highlightField(el) {
      if (!el) return;
      const origOutline = el.style.outline;
      const origTransition = el.style.transition;
      el.style.transition = 'outline 0.3s ease, box-shadow 0.3s ease';
      el.style.outline = '2px solid #22c55e';
      el.style.boxShadow = '0 0 8px rgba(34, 197, 94, 0.35)';

      setTimeout(() => {
        el.style.outline = origOutline;
        el.style.boxShadow = '';
        setTimeout(() => { el.style.transition = origTransition; }, 300);
      }, 2500);
    },

    /**
     * Highlight AI-filled field (purple)
     * @param {HTMLElement} el
     */
    highlightFieldAI(el) {
      if (!el) return;
      const origOutline = el.style.outline;
      const origTransition = el.style.transition;
      el.style.transition = 'outline 0.3s ease, box-shadow 0.3s ease';
      el.style.outline = '2px solid #a855f7';
      el.style.boxShadow = '0 0 10px rgba(168, 85, 247, 0.45)';

      setTimeout(() => {
        el.style.outline = origOutline;
        el.style.boxShadow = '';
        setTimeout(() => { el.style.transition = origTransition; }, 300);
      }, 3000);
    },
    /**
     * Programmatically attach a saved resume/file object to an input[type="file"]
     * @param {HTMLInputElement} input
     * @param {Object} fileData - { name, type, base64, lastModified }
     * @returns {boolean}
     */
    attachFile(input, fileData) {
      if (!input || !fileData || !fileData.base64) return false;
      try {
        const binaryStr = atob(fileData.base64);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) {
          bytes[i] = binaryStr.charCodeAt(i);
        }
        const blob = new Blob([bytes], { type: fileData.type || 'application/pdf' });
        const file = new File([blob], fileData.name || 'resume.pdf', {
          type: fileData.type || 'application/pdf',
          lastModified: fileData.lastModified || Date.now(),
        });

        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;

        // Dispatch events expected by React/Vue/Angular and native listeners
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      } catch (err) {
        console.error('[QuickFillDOM] attachFile error:', err);
        return false;
      }
    },
  };

  global.QuickFillDOM = DOMFiller;
})(typeof self !== 'undefined' ? self : this);
