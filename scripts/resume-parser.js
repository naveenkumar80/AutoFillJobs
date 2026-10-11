/**
 * scripts/resume-parser.js — Resume Text & Document Extraction for QuickFill
 * 
 * Capabilities:
 * - Pure client-side PDF FlateDecode stream decompression via DecompressionStream
 * - Multi-attribute heuristic regex extractor (Name, Email, Phone, Links, Bio, Skills, Education)
 * - AI-powered structured extraction (Gemini 3.8/2.5/1.5 Flash with inlineData or OpenAI)
 * - Automatic heuristic fallback and field merging
 */

(function (global) {
  const Logger = global.QuickFillLogger || {
    error: (src, err) => console.error(`[${src}]`, err),
    warn: (src, msg) => console.warn(`[${src}]`, msg),
    info: (src, msg) => console.log(`[${src}]`, msg),
  };

  const AIService = global.QuickFillAIService;

  /**
   * Decompress a compressed PDF stream chunk using native DecompressionStream
   * @param {Uint8Array} uint8
   * @returns {Promise<string>}
   */
  async function decompressPdfStream(uint8) {
    if (typeof DecompressionStream === 'undefined') {
      return '';
    }

    // 1. Try standard zlib/deflate
    try {
      const ds = new DecompressionStream('deflate');
      const writer = ds.writable.getWriter();
      writer.write(uint8);
      writer.close();
      const reader = ds.readable.getReader();
      const chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      return chunksToLatin1(chunks);
    } catch (e1) {
      // 2. Try raw deflate (without zlib header)
      try {
        const dsRaw = new DecompressionStream('deflate-raw');
        const writer = dsRaw.writable.getWriter();
        writer.write(uint8);
        writer.close();
        const reader = dsRaw.readable.getReader();
        const chunks = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
        return chunksToLatin1(chunks);
      } catch (e2) {
        return '';
      }
    }
  }

  function chunksToLatin1(chunks) {
    let result = '';
    for (const chunk of chunks) {
      const len = chunk.length;
      const step = 8192;
      for (let i = 0; i < len; i += step) {
        result += String.fromCharCode.apply(null, chunk.subarray(i, i + step));
      }
    }
    return result;
  }

  const ResumeParser = {
    /**
     * Parse resume with AI (if API key available) or heuristic regex fallback
     * @param {Object} params - { resumeText, base64Pdf, mimeType, aiSettings }
     * @returns {Promise<{ profile: Object, customQA: Array, source: string }>}
     */
    async parseResume({ resumeText, base64Pdf, mimeType, aiSettings }) {
      const { provider = 'gemini', apiKey, model } = aiSettings || {};

      Logger.info('resume-parser', 'Starting resume parse', {
        hasBase64Pdf: !!base64Pdf,
        textLength: (resumeText || '').length,
        hasAIKey: !!(apiKey && apiKey.trim()),
        provider,
      });

      // Always run heuristics first as baseline
      const heuristicResult = this.extractResumeHeuristics(resumeText || '');

      // If AI key is provided, attempt AI-powered parsing
      if (apiKey && apiKey.trim()) {
        const aiServiceInstance = AIService || global.QuickFillAIService;
        if (aiServiceInstance) {
          const resumePrompt = `You are an expert resume parser for job application autofill.
Analyze the following resume and extract the candidate's information into a valid JSON object.

JSON STRUCTURE REQUIRED:
{
  "profile": {
    "firstName": "Candidate first name",
    "lastName": "Candidate last name",
    "fullName": "Full legal name",
    "email": "Email address",
    "phone": "Phone number",
    "city": "Current city",
    "country": "Current country",
    "address": "Street address or location line",
    "currentJobTitle": "Current or most recent job title (e.g. Senior Software Engineer)",
    "currentCompany": "Current or most recent company / employer (e.g. TechCorp Inc.)",
    "currentStartDate": "Start date of current role (e.g. Jan 2022 or 2022-01) or empty string",
    "currentEndDate": "End date of current role (e.g. Present) or empty string",
    "yearsOfExperience": "Total estimated years of experience as a number (e.g. 5)",
    "desiredSalary": "Expected/desired salary if mentioned or empty string",
    "experienceDescription": "Concise 2-3 sentence summary of key work accomplishments and roles",
    "educationLevel": "Highest degree level (e.g. Bachelor's Degree, Master's Degree, Ph.D. / Doctorate, Associate Degree, High School)",
    "university": "Name of university or college attended",
    "major": "Major or field of study (e.g. Computer Science)",
    "graduationYear": "4-digit graduation or completion year (e.g. 2021)",
    "gpa": "GPA or Grade Point Average if listed or empty string",
    "skills": "Comma-separated list of core technical skills and tools",
    "certifications": "Professional certifications and licenses or empty string",
    "linkedin": "LinkedIn profile URL (or empty string)",
    "github": "GitHub profile URL (or empty string)",
    "portfolio": "Personal website or portfolio URL (or empty string)",
    "authorizedToWork": "Yes or No based on work authorization or citizen status",
    "requiresSponsorship": "No or Yes based on visa sponsorship status",
    "workPreference": "Remote, Hybrid, On-site, or Open to Any",
    "earliestStartDate": "Earliest start date or availability",
    "noticePeriod": "Notice period if mentioned (e.g. Immediate, 2 weeks) or empty string",
    "summary": "Professional 3-5 sentence bio/summary showcasing skills, background, and value",
    "workHistory": [
      {
        "jobTitle": "Past job title (e.g. Software Engineer)",
        "company": "Company / Organization name",
        "startDate": "Start date (e.g. Jan 2020 or 2020-01)",
        "endDate": "End date (e.g. Dec 2022)",
        "description": "Key responsibilities and technical accomplishments"
      }
    ]
  },
  "customQA": [
    {
      "question": "What is your primary programming language / core tech stack?",
      "answer": "List of top skills, languages, and frameworks from resume"
    },
    {
      "question": "Describe your educational background",
      "answer": "Highest degree, field of study, and university"
    },
    {
      "question": "Summary of recent work experience and key accomplishments",
      "answer": "2-3 sentences summarizing roles, companies, and achievements"
    },
    {
      "question": "Why should we hire you for this role?",
      "answer": "Persuasive summary of candidate's technical strengths and impact"
    }
  ]
}

Return ONLY this JSON object.`;

          try {
            let rawJSON;
            const cleanKey = apiKey.trim().replace(/^["']|["']$/g, '');

            if (provider === 'gemini') {
              let geminiModel = model || 'gemini-3.8-flash';
              if (geminiModel.includes('2.0')) geminiModel = 'gemini-3.8-flash';

              if (base64Pdf && (mimeType === 'application/pdf' || !mimeType)) {
                try {
                  rawJSON = await aiServiceInstance.callGemini(cleanKey, geminiModel, [
                    { inlineData: { mimeType: 'application/pdf', data: base64Pdf } },
                    { text: resumePrompt },
                  ], 2048);
                } catch (pdfErr) {
                  Logger.warn('resume-parser', `Gemini inlineData PDF failed (${pdfErr.message}), trying text prompt`);
                  if (resumeText && resumeText.trim().length > 30) {
                    rawJSON = await aiServiceInstance.callGemini(cleanKey, geminiModel, `${resumePrompt}\n\nRESUME TEXT:\n${resumeText}`, 2048);
                  } else {
                    throw pdfErr;
                  }
                }
              } else {
                rawJSON = await aiServiceInstance.callGemini(cleanKey, geminiModel, `${resumePrompt}\n\nRESUME TEXT:\n${resumeText}`, 2048);
              }
            } else if (provider === 'openai') {
              rawJSON = await aiServiceInstance.callOpenAI(cleanKey, model || 'gpt-4o-mini', `${resumePrompt}\n\nRESUME TEXT:\n${resumeText}`, 2048);
            }

            const parsed = aiServiceInstance.parseAIResponse(rawJSON);
            if (parsed && typeof parsed === 'object') {
              // Merge AI parsed profile with heuristics (fill any blanks AI missed)
              const mergedProfile = { ...heuristicResult.profile, ...(parsed.profile || {}) };
              // Prefer non-empty values
              Object.keys(mergedProfile).forEach((k) => {
                if (!mergedProfile[k] && heuristicResult.profile[k]) {
                  mergedProfile[k] = heuristicResult.profile[k];
                }
              });

              // Merge custom Q&A
              const aiCustomQA = Array.isArray(parsed.customQA) ? parsed.customQA : [];
              const combinedQA = [...aiCustomQA];
              (heuristicResult.customQA || []).forEach((hqa) => {
                if (!combinedQA.some((c) => c.question.toLowerCase() === hqa.question.toLowerCase())) {
                  combinedQA.push(hqa);
                }
              });

              Logger.info('resume-parser', 'AI resume parse succeeded and merged with heuristics', {
                fieldsCount: Object.keys(mergedProfile).length,
                customQACount: combinedQA.length,
              });

              return {
                profile: mergedProfile,
                customQA: combinedQA,
                source: 'ai',
              };
            }
          } catch (aiErr) {
            Logger.warn('resume-parser', `AI resume parse failed (${aiErr.message}), using regex heuristics`);
          }
        }
      }

      // Return heuristic fallback
      Logger.info('resume-parser', 'Using heuristic resume extraction results', {
        fieldsFound: Object.keys(heuristicResult.profile).length,
        customQACount: heuristicResult.customQA.length,
      });

      return {
        profile: heuristicResult.profile,
        customQA: heuristicResult.customQA,
        source: 'heuristic',
      };
    },

    /**
     * Offline heuristic regex extractor for common resume patterns
     * @param {string} text
     * @returns {{ profile: Object, customQA: Array }}
     */
    extractResumeHeuristics(text) {
      const profile = {};
      const customQA = [];
      if (!text || typeof text !== 'string') return { profile, customQA };

      // 1. Email Address
      const emailMatch = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
      if (emailMatch) profile.email = emailMatch[0].trim();

      // 2. Phone Number (US, International, and common formats)
      const phoneMatch = text.match(/(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
      if (phoneMatch) profile.phone = phoneMatch[0].trim();

      // 3. LinkedIn Profile
      const linkedinMatch = text.match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/([a-zA-Z0-9_-]+)/i);
      if (linkedinMatch) {
        profile.linkedin = linkedinMatch[0].startsWith('http') ? linkedinMatch[0] : 'https://' + linkedinMatch[0];
      }

      // 4. GitHub Profile
      const githubMatch = text.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/([a-zA-Z0-9_-]+)/i);
      if (githubMatch) {
        profile.github = githubMatch[0].startsWith('http') ? githubMatch[0] : 'https://' + githubMatch[0];
      }

      // 5. Personal Portfolio / Website
      const portfolioMatch = text.match(/https?:\/\/(?:www\.)?(?!linkedin|github)[a-zA-Z0-9-]+\.[a-z]{2,}(?:\/[^\s|)]*)?/i);
      if (portfolioMatch) {
        const url = portfolioMatch[0];
        if (!url.includes('@') && !url.includes('google.com') && !url.includes('adobe.com')) {
          profile.portfolio = url;
        }
      }

      // 6. Candidate Name
      const nonNameWords = /resume|curriculum|vitae|contact|phone|email|linkedin|github|portfolio|summary|experience|education|skills|page|developer|engineer|designer|manager|consultant|analyst|full[\s_-]?stack/i;

      // Try start of text match first (e.g. "Jane Doe ...")
      const startNameMatch = text.match(/^\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})/);
      if (startNameMatch && !nonNameWords.test(startNameMatch[1])) {
        profile.fullName = startNameMatch[1].trim();
        const parts = profile.fullName.split(/\s+/);
        profile.firstName = parts[0];
        profile.lastName = parts.slice(1).join(' ');
      } else {
        const lines = text
          .split(/[\r\n]+/)
          .map((l) => l.trim())
          .filter((l) => l.length > 0 && l.length < 60);

        for (let i = 0; i < Math.min(lines.length, 6); i++) {
          const line = lines[i].replace(/[^\w\s]/g, '').trim();
          const words = line.split(/\s+/).filter(Boolean);
          if (words.length >= 2 && words.length <= 4) {
            if (!nonNameWords.test(line) && !/\d/.test(line)) {
              profile.fullName = words.join(' ');
              profile.firstName = words[0];
              profile.lastName = words.slice(1).join(' ');
              break;
            }
          }
        }
      }

      // 7. Location (City, State / Country)
      const locationMatch = text.match(/\b([A-Z][a-zA-Z\s.-]+),\s*([A-Z]{2}\b|[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)/);
      if (locationMatch && !nonNameWords.test(locationMatch[1])) {
        profile.city = locationMatch[1].trim();
        profile.country = locationMatch[2].trim();
        profile.address = `${profile.city}, ${profile.country}`;
      }

      // 8. Professional Summary / Bio
      const summaryMatch = text.match(/(?:Professional\s+Summary|Summary|About\s+Me|Executive\s+Summary|Profile)[:\s]+([\s\S]{20,500}?)(?=(?:Technical\s+Skills|Skills|Core\s+Competencies|Education|Work\s+History|Work\s+Experience|Projects)(?::|\s+[A-Z])|\n\n|$)/i);
      if (summaryMatch) {
        profile.summary = summaryMatch[1].replace(/\s+/g, ' ').trim();
      }

      // 9. Years of Experience
      const expMatch = text.match(/(\d{1,2})\+?\s*(?:years?|yrs?)(?:\s*(?:of|in))?\s*(?:experience|exp)/i);
      if (expMatch) {
        profile.yearsOfExperience = expMatch[1];
      }

      // 10. Current / Most Recent Job Title
      const titleMatch = text.match(/([A-Z][a-zA-Z\s/-]+(?:Engineer|Developer|Architect|Designer|Manager|Consultant|Analyst|Scientist|Specialist|Lead))\s+(?:with|\sat|@|having)\s+\d+/i)
        || text.match(/\b(?:Senior|Junior|Lead|Principal|Staff)?\s*(?:Software|Frontend|Backend|Full[\s-]?Stack|Web|Mobile|DevOps|Cloud|Data|AI)?\s*(?:Engineer|Developer|Architect|Designer|Manager|Consultant|Analyst)\b/i);
      if (titleMatch) {
        profile.currentJobTitle = (titleMatch[1] || titleMatch[0]).trim();
      }

      // 11. Current / Most Recent Company
      const companyMatch = text.match(/(?:at|@)\s+([A-Z][a-zA-Z0-9&.,\s-]{2,35}?)(?=\s+(?:as|in|from|\d{4}|present|current|\n|$|,))/);
      if (companyMatch) {
        profile.currentCompany = companyMatch[1].trim();
      }

      // 12. Notice Period / Availability
      const noticeMatch = text.match(/\b(immediate(?:ly)?|1\s*week|2\s*weeks|30\s*days|1\s*month|2\s*months)\b/i);
      if (noticeMatch) {
        profile.noticePeriod = noticeMatch[1].toLowerCase().includes('immediate') ? 'Immediate' : noticeMatch[1];
      }

      // 13. Technical Skills
      const skillsMatch = text.match(/(?:Technical\s+Skills|Skills|Core\s+Competencies|Technologies|Tech\s+Stack)[:\s]+([\s\S]{15,400}?)(?=(?:Education|Academic\s+Background|Work\s+History|Experience|Projects|Certifications|Summary)(?::|\s+[A-Z])|\n\n|$)/i);
      if (skillsMatch) {
        const skillsText = skillsMatch[1].replace(/\s+/g, ' ').trim();
        profile.skills = skillsText;
        customQA.push({
          question: 'What is your primary programming language / core tech stack?',
          answer: skillsText,
        });
      }

      // 14. Education Level & Degree
      if (/doctor|ph\.?d|doctorate/i.test(text)) {
        profile.educationLevel = 'Ph.D. / Doctorate';
      } else if (/master(?:'s)?|m\.?s\b|mba|m\.?tech|m\.?a\b/i.test(text)) {
        profile.educationLevel = "Master's Degree";
      } else if (/bachelor(?:'s)?|b\.?s\b|b\.?tech|b\.?e\b|b\.?a\b/i.test(text)) {
        profile.educationLevel = "Bachelor's Degree";
      } else if (/associate(?:'s)?|a\.?s\b|a\.?a\b/i.test(text)) {
        profile.educationLevel = 'Associate Degree';
      } else if (/high\s+school/i.test(text)) {
        profile.educationLevel = 'High School';
      }

      // 15. Major / Field of Study
      const majorMatch = text.match(/(?:Bachelor|Master|Doctor|Associate|B\.S\.|M\.S\.|Degree)?\s*(?:of\s+Science|of\s+Arts)?\s*in\s+([A-Z][a-zA-Z\s&/]{3,35}?)(?=,|\s+at|\s+from|\s+University|\s+College|\n|$)/i);
      if (majorMatch) {
        profile.major = majorMatch[1].trim();
      }

      // 16. University / College
      const uniMatch = text.match(/\b(?:University\s+of\s+[A-Z][a-zA-Z]+(?:\s*,\s*[A-Z][a-zA-Z]+)?|[A-Z][a-zA-Z\s&.-]+(?:\bUniversity|\bCollege|\bInstitute\s+of\s+Technology|\bAcademy))\b/);
      if (uniMatch) {
        profile.university = uniMatch[0].trim();
      }

      // 17. Graduation Year
      const gradYearMatch = text.match(/(?:graduat(?:ed?|ion)|class\s+of|completed(?:\s+in)?|\b(?:19|20)\d{2}\s*[-–]\s*)((?:19|20)\d{2})/i);
      if (gradYearMatch) {
        profile.graduationYear = gradYearMatch[1];
      }

      // 18. GPA
      const gpaMatch = text.match(/\b(?:gpa|cgpa)[:\s]*([0-4]\.\d{1,2}(?:\s*\/\s*4(?:\.0)?)?|[0-9]\.\d{1,2}(?:\s*\/\s*10(?:\.0)?)?)/i);
      if (gpaMatch) {
        profile.gpa = gpaMatch[1].trim();
      }

      // 19. Certifications
      const certMatch = text.match(/(?:Certifications?|Licenses?|Credentials?|Professional\s+Certifications?)[:\s]+([\s\S]{10,350}?)(?=(?:Education|Academic|Experience|Projects|Skills|Summary)(?::|\s+[A-Z])|\n\n|$)/i);
      if (certMatch) {
        profile.certifications = certMatch[1].replace(/\s+/g, ' ').trim();
      }

      // 20. Experience Highlights
      if (profile.summary) {
        profile.experienceDescription = profile.summary;
      }

      // 21. Custom Q&A: Education Background
      const eduMatch = text.match(/(?:Education|Academic\s+Background|Degrees)[:\s]+([\s\S]{15,350}?)(?=(?:Experience|Work\s+History|Work\s+Experience|Projects|Skills|Technical\s+Skills)(?::|\s+[A-Z])|\n\n|$)/i);
      if (eduMatch) {
        customQA.push({
          question: 'Describe your educational background',
          answer: eduMatch[1].replace(/\s+/g, ' ').trim(),
        });
      }

      return { profile, customQA };
    },

    /**
     * Pure client-side PDF text extraction from ArrayBuffer using native Flate decompression
     * @param {ArrayBuffer} buffer
     * @returns {Promise<string>}
     */
    async extractTextFromPDFBuffer(buffer) {
      try {
        const bytes = new Uint8Array(buffer);
        let latin1 = '';
        const step = 8192;
        for (let i = 0; i < bytes.length; i += step) {
          latin1 += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
        }

        const textPieces = [];
        const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
        let match;

        while ((match = streamRegex.exec(latin1)) !== null) {
          const rawStream = match[1];

          // Check if stream is Flate compressed
          let content = rawStream;
          if (typeof DecompressionStream !== 'undefined') {
            const rawBytes = new Uint8Array(rawStream.length);
            for (let b = 0; b < rawStream.length; b++) {
              rawBytes[b] = rawStream.charCodeAt(b);
            }
            const decompressed = await decompressPdfStream(rawBytes);
            if (decompressed && decompressed.length > 0) {
              content = decompressed;
            }
          }

          // Extract plain Tj strings: (text) Tj
          const tjRegex = /\(([^)]+)\)\s*(?:Tj|'|")/g;
          let tm;
          while ((tm = tjRegex.exec(content)) !== null) {
            textPieces.push(decodePdfString(tm[1]));
          }

          // Extract array TJ strings: [(text) 20 (more)] TJ
          const arrayTjRegex = /\[([^\]]+)\]\s*TJ/g;
          let am;
          while ((am = arrayTjRegex.exec(content)) !== null) {
            const inner = am[1];
            const innerTj = /\(([^)]+)\)/g;
            let im;
            while ((im = innerTj.exec(inner)) !== null) {
              textPieces.push(decodePdfString(im[1]));
            }
          }
        }

        const joined = textPieces.join(' ').replace(/\s+/g, ' ').trim();
        if (joined.length > 40) {
          return joined;
        }

        // Fallback: extract printable strings from raw buffer
        return latin1.replace(/[^\x20-\x7E\n]/g, ' ').replace(/\s+/g, ' ').trim();
      } catch (err) {
        Logger.error('resume-parser', 'extractTextFromPDFBuffer error: ' + err.message);
        return '';
      }
    },

    /**
     * Convert ArrayBuffer to Base64 efficiently
     * @param {ArrayBuffer} buffer
     * @returns {string}
     */
    arrayBufferToBase64(buffer) {
      const bytes = new Uint8Array(buffer);
      let binary = '';
      const chunkSize = 16384;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
      }
      return btoa(binary);
    },
  };

  /**
   * Unescape standard PDF octal and backslash escapes
   */
  function decodePdfString(str) {
    if (!str) return '';
    return str
      .replace(/\\([0-7]{1,3})/g, (match, oct) => String.fromCharCode(parseInt(oct, 8)))
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\b/g, '\b')
      .replace(/\\f/g, '\f')
      .replace(/\\\(/g, '(')
      .replace(/\\\)/g, ')')
      .replace(/\\\\/g, '\\');
  }

  global.QuickFillResumeParser = ResumeParser;
})(typeof self !== 'undefined' ? self : this);
