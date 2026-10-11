/**
 * scripts/ai-service.js — AI API Providers & Prompt Generation for QuickFill
 * 
 * Handles all AI interactions:
 * - Google Gemini (gemini-3.8-flash with auto-retry and multi-modal support)
 * - OpenAI (gpt-4o-mini / gpt-4o with json_object mode)
 * - Structured prompt construction & robust response parsing
 */

(function (global) {
  const Logger = global.QuickFillLogger || {
    error: (src, err) => console.error(src, err),
    warn: (src, msg) => console.warn(src, msg),
    info: (src, msg) => console.log(src, msg),
  };

  const AIService = {
    /**
     * Orchestrates AI generation for unmatched form questions.
     * @param {Object} params
     * @returns {Promise<{ answers: Object }>}
     */
    async generateAnswers({ questions, profile, customQA = [], aiSettings }) {
      const { provider = 'gemini', apiKey, model } = aiSettings || {};

      if (!apiKey || !apiKey.trim()) {
        const err = new Error('No API key configured. Open Settings → AI Configuration and enter your API key.');
        Logger.error('ai-service', err);
        throw err;
      }

      const cleanKey = apiKey.trim().replace(/^["']|["']$/g, '');

      if (!questions || questions.length === 0) {
        return { answers: {} };
      }

      Logger.info('ai-service', `Generating answers for ${questions.length} questions via ${provider}`, { model });

      const prompt = this.buildPrompt(questions, profile, customQA);
      let rawJSON;

      try {
        if (provider === 'gemini') {
          let geminiModel = model || 'gemini-3.8-flash';
          if (geminiModel.includes('2.0')) geminiModel = 'gemini-3.8-flash';
          rawJSON = await this.callGemini(cleanKey, geminiModel, prompt);
        } else if (provider === 'openai') {
          rawJSON = await this.callOpenAI(cleanKey, model || 'gpt-4o-mini', prompt);
        } else {
          throw new Error(`Unknown AI provider: "${provider}". Use "gemini" or "openai".`);
        }

        const answers = this.parseAIResponse(rawJSON);
        Logger.info('ai-service', `Successfully parsed answers for ${Object.keys(answers).length} fields`);
        return { answers };
      } catch (err) {
        Logger.error('ai-service', err, { provider, model, questionCount: questions.length });
        throw err;
      }
    },

    /**
     * Test connection to provider with lightweight prompt
     * @param {Object} aiSettings
     * @returns {Promise<{ success: boolean, elapsed: number, model: string, response: Object }>}
     */
    async testConnection(aiSettings) {
      const { provider = 'gemini', apiKey, model } = aiSettings || {};

      if (!apiKey || !apiKey.trim()) {
        throw new Error('API key is empty. Please enter your API key first.');
      }

      const cleanKey = apiKey.trim().replace(/^["']|["']$/g, '');
      let testModel = model || (provider === 'gemini' ? 'gemini-3.8-flash' : 'gpt-4o-mini');
      if (provider === 'gemini' && testModel.includes('2.0')) {
        testModel = 'gemini-3.8-flash';
      }

      const testPrompt = 'Respond with JSON: {"status": "ok", "message": "QuickFill AI connection test successful"}';
      const startTime = Date.now();
      let rawJSON;

      try {
        if (provider === 'gemini') {
          rawJSON = await this.callGemini(cleanKey, testModel, testPrompt);
        } else if (provider === 'openai') {
          rawJSON = await this.callOpenAI(cleanKey, testModel, testPrompt);
        } else {
          throw new Error(`Unknown provider: ${provider}`);
        }

        const elapsed = Date.now() - startTime;
        const parsed = this.parseAIResponse(rawJSON);
        Logger.info('ai-service', `Test connection verified in ${elapsed}ms`, { model: testModel });
        return { success: true, elapsed, model: testModel, response: parsed };
      } catch (err) {
        Logger.error('ai-service', `Test connection failed: ${err.message}`, { provider, model: testModel });
        throw err;
      }
    },

    /**
     * Call Google Gemini API with auto-retry and multi-modal support
     */
    async callGemini(apiKey, model, promptOrParts) {
      const parts = typeof promptOrParts === 'string'
        ? [{ text: promptOrParts }]
        : promptOrParts;

      const cleanKey = (apiKey || '').trim().replace(/^["']|["']$/g, '');
      let targetModel = model || 'gemini-3.8-flash';
      if (targetModel.includes('2.0') || targetModel.includes('2.5')) {
        targetModel = 'gemini-3.8-flash';
      }

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${cleanKey}`;

      let response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts }],
            generationConfig: {
              responseMimeType: 'application/json',
              temperature: 0.2,
              maxOutputTokens: 3072,
            },
          }),
        });
      } catch (netErr) {
        throw new Error(`Network error connecting to Gemini API: ${netErr.message}`);
      }

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMsg = errorData?.error?.message || `HTTP ${response.status} ${response.statusText}`;

        // Auto-retry if API recommends a newer model
        const suggestedModelMatch = errorMsg.match(/models\/(gemini-[\w.-]+)/);
        if (suggestedModelMatch && suggestedModelMatch[1] && suggestedModelMatch[1] !== targetModel) {
          Logger.warn('ai-service', `Retrying with suggested model ${suggestedModelMatch[1]}`);
          return await this.callGemini(apiKey, suggestedModelMatch[1], promptOrParts);
        }

        if (errorMsg.includes('no longer available') && targetModel !== 'gemini-3.8-flash') {
          Logger.warn('ai-service', 'Model retired, retrying with gemini-3.8-flash');
          return await this.callGemini(apiKey, 'gemini-3.8-flash', promptOrParts);
        }

        // Retry without responseMimeType if structured output is unsupported
        if (errorMsg.includes('responseMimeType') || errorMsg.includes('generationConfig')) {
          try {
            const fallbackRes = await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ parts }],
                generationConfig: {
                  temperature: 0.2,
                  maxOutputTokens: 3072,
                },
              }),
            });
            if (fallbackRes.ok) {
              const fbData = await fallbackRes.json();
              const fbText = fbData?.candidates?.[0]?.content?.parts?.[0]?.text;
              if (fbText) return fbText;
            }
          } catch {}
        }

        throw new Error(`Gemini API error: ${errorMsg}`);
      }

      const data = await response.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!text) {
        const blockReason = data?.promptFeedback?.blockReason;
        const finishReason = data?.candidates?.[0]?.finishReason;
        if (blockReason) throw new Error(`Gemini blocked prompt: ${blockReason}`);
        if (finishReason && finishReason !== 'STOP') throw new Error(`Gemini finished with reason: ${finishReason}`);
        throw new Error('Gemini returned an empty response. Check your API key and quota.');
      }

      return text;
    },

    /**
     * Call OpenAI Chat Completions API
     */
    async callOpenAI(apiKey, model, prompt) {
      const cleanKey = (apiKey || '').trim().replace(/^["']|["']$/g, '');
      const selectedModel = model || 'gpt-4o-mini';

      let response;
      try {
        response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${cleanKey}`,
          },
          body: JSON.stringify({
            model: selectedModel,
            messages: [
              {
                role: 'system',
                content: 'You are a professional job application assistant. Always respond with valid JSON only, no markdown code fences or conversational text.',
              },
              {
                role: 'user',
                content: prompt,
              },
            ],
            temperature: 0.2,
            max_tokens: 3072,
            response_format: { type: 'json_object' },
          }),
        });
      } catch (netErr) {
        throw new Error(`Network error connecting to OpenAI API: ${netErr.message}`);
      }

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMsg = errorData?.error?.message || `HTTP ${response.status} ${response.statusText}`;
        throw new Error(`OpenAI API error: ${errorMsg}`);
      }

      const data = await response.json();
      const text = data?.choices?.[0]?.message?.content;

      if (!text) {
        throw new Error('OpenAI returned an empty response. Check your API key and quota.');
      }

      return text;
    },

    /**
     * Parse raw AI response string into structured object
     */
    parseAIResponse(rawJSON) {
      let cleaned = (rawJSON || '').trim();

      const codeBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (codeBlockMatch) cleaned = codeBlockMatch[1].trim();

      const jsonMatch = cleaned.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
      if (jsonMatch) cleaned = jsonMatch[0];

      try {
        let parsed = JSON.parse(cleaned);
        if (!parsed || typeof parsed !== 'object') {
          throw new Error('Response is not a valid JSON structure');
        }
        if (parsed.answers && typeof parsed.answers === 'object') parsed = parsed.answers;
        else if (parsed.responses && typeof parsed.responses === 'object') parsed = parsed.responses;
        else if (parsed.data && typeof parsed.data === 'object') parsed = parsed.data;
        return parsed;
      } catch (parseErr) {
        Logger.error('ai-service', 'Failed to parse AI JSON', { raw: rawJSON });
        throw new Error('Failed to parse AI response. Model returned: ' + (rawJSON.length > 80 ? rawJSON.slice(0, 80) + '…' : rawJSON));
      }
    },

    /**
     * Build prompt from candidate profile, saved Q&A, and form questions
     */
    buildPrompt(questions, profile, customQA = []) {
      const profileLines = Object.entries(profile || {})
        .filter(([, v]) => v && String(v).trim())
        .map(([key, value]) => `- ${this.formatKeyName(key)}: ${value}`)
        .join('\n');

      const qaLines = (customQA || [])
        .filter((qa) => qa.question && qa.answer)
        .map((qa) => `- Question: "${qa.question}" -> Answer: "${qa.answer}"`)
        .join('\n');

      const questionLines = questions.map((q, i) => {
        let line = `${i}: "${q.questionText}"`;
        if (q.fieldType) line += ` (type: ${q.fieldType})`;
        if (q.options && q.options.length > 0) {
          line += ` [choose from: ${q.options.map((o) => `"${o}"`).join(', ')}]`;
        }
        if (q.maxLength) line += ` (max ${q.maxLength} characters)`;
        return line;
      }).join('\n');

      return `You are a professional job application assistant. A candidate needs help filling out a job application form.

CANDIDATE PROFILE:
${profileLines || '(No profile data available)'}

SAVED CANDIDATE KNOWLEDGE BASE & PAST ANSWERS:
${qaLines || '(No saved custom answers)'}

Based on the candidate's profile and knowledge base, generate appropriate and professional answers for the following form questions. Each question is identified by its index number.

FORM QUESTIONS:
${questionLines}

INSTRUCTIONS:
- Provide concise, professional answers suitable for a job application.
- For dropdown/select fields, choose one of the provided options EXACTLY as written.
- For radio button fields, choose one of the provided options EXACTLY as written.
- For short text fields, keep answers brief and to the point.
- For textarea / bio / cover letter fields, provide a well-written, tailored 2-4 sentence response based on the candidate's experience.
- Draw on the candidate's profile and knowledge base where relevant.
- For salary questions, respond with "Open to discussion" or a market-aligned range.
- If a question cannot be answered, use an empty string "".

Respond ONLY with a valid JSON object where keys are the question index numbers (as strings) and values are the answer strings.
Example format: {"0": "Answer one", "1": "Answer two", "2": "Selected Option"}`;
    },

    formatKeyName(key) {
      const map = {
        firstName: 'First Name',
        lastName: 'Last Name',
        fullName: 'Full Name',
        email: 'Email',
        phone: 'Phone',
        city: 'City',
        country: 'Country',
        address: 'Address',
        currentJobTitle: 'Current / Most Recent Job Title',
        currentCompany: 'Current / Most Recent Company',
        yearsOfExperience: 'Years of Experience',
        desiredSalary: 'Desired / Expected Salary',
        experienceDescription: 'Work Experience Highlights & Accomplishments',
        educationLevel: 'Highest Education Level',
        university: 'University / College',
        major: 'Major / Field of Study',
        graduationYear: 'Graduation Year',
        gpa: 'GPA / Grade Point Average',
        skills: 'Core Skills & Technologies',
        certifications: 'Certifications & Licenses',
        linkedin: 'LinkedIn',
        github: 'GitHub',
        portfolio: 'Portfolio/Website',
        authorizedToWork: 'Authorized to Work',
        requiresSponsorship: 'Requires Sponsorship',
        workPreference: 'Work Location Preference',
        earliestStartDate: 'Earliest Start Date',
        noticePeriod: 'Notice Period',
        summary: 'Professional Summary / Bio',
      };
      return map[key] || key.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase());
    },
  };

  global.QuickFillAIService = AIService;
})(typeof self !== 'undefined' ? self : this);
