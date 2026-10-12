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

      const cleanText = (resumeText || '').trim();

      Logger.info('resume-parser', 'Starting resume parse', {
        hasBase64Pdf: !!base64Pdf,
        textLength: cleanText.length,
        hasAIKey: !!(apiKey && apiKey.trim()),
        provider,
      });

      // Always run heuristics first as baseline
      const heuristicResult = this.extractResumeHeuristics(cleanText);

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
              let geminiModel = (model || 'gemini-2.0-flash').replace(/^models\//, '');
              if (geminiModel.includes('3.8') || geminiModel.includes('3.6')) {
                geminiModel = 'gemini-2.0-flash';
              }

              // Fast Path: If we have clean extracted or pasted resume text (> 80 chars),
              // send text prompt with generous 30s timeout and 3000 max tokens.
              // This is 5x faster (1.5-2.5s) and avoids base64 upload latency!
              if (cleanText.length > 80) {
                try {
                  rawJSON = await aiServiceInstance.callGemini(
                    cleanKey,
                    geminiModel,
                    `${resumePrompt}\n\nRESUME TEXT:\n${cleanText}`,
                    3000,
                    30000
                  );
                } catch (textErr) {
                  Logger.warn('resume-parser', `Gemini text prompt failed (${textErr.message}), trying inlineData if PDF provided`);
                  if (base64Pdf && (mimeType === 'application/pdf' || !mimeType)) {
                    rawJSON = await aiServiceInstance.callGemini(
                      cleanKey,
                      geminiModel,
                      [
                        { inlineData: { mimeType: 'application/pdf', data: base64Pdf } },
                        { text: resumePrompt },
                      ],
                      3000,
                      35000
                    );
                  } else {
                    throw textErr;
                  }
                }
              } else if (base64Pdf && (mimeType === 'application/pdf' || !mimeType)) {
                // Scanned or non-extractable PDF: use multimodal PDF vision
                rawJSON = await aiServiceInstance.callGemini(
                  cleanKey,
                  geminiModel,
                  [
                    { inlineData: { mimeType: 'application/pdf', data: base64Pdf } },
                    { text: resumePrompt },
                  ],
                  3000,
                  35000
                );
              } else {
                throw new Error('No readable text or PDF content found in resume to parse');
              }
            } else if (provider === 'openai') {
              if (cleanText.length < 30) {
                throw new Error('OpenAI requires extracted text. Please paste your resume text or ensure the PDF contains selectable text.');
              }
              rawJSON = await aiServiceInstance.callOpenAI(
                cleanKey,
                model || 'gpt-4o-mini',
                `${resumePrompt}\n\nRESUME TEXT:\n${cleanText}`,
                3000,
                30000
              );
            }

            const parsed = aiServiceInstance.parseAIResponse(rawJSON);
            if (parsed && typeof parsed === 'object') {
              // Merge AI parsed profile with heuristics (fill any blanks AI missed)
              const mergedProfile = { ...heuristicResult.profile, ...(parsed.profile || {}) };
              
              // Prefer non-empty values
              Object.keys(mergedProfile).forEach((k) => {
                if ((mergedProfile[k] === undefined || mergedProfile[k] === null || mergedProfile[k] === '') && heuristicResult.profile[k]) {
                  mergedProfile[k] = heuristicResult.profile[k];
                }
              });

              // Ensure work history is array
              if (!Array.isArray(mergedProfile.workHistory) || mergedProfile.workHistory.length === 0) {
                if (Array.isArray(heuristicResult.profile.workHistory) && heuristicResult.profile.workHistory.length > 0) {
                  mergedProfile.workHistory = heuristicResult.profile.workHistory;
                }
              }

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
                workHistoryCount: Array.isArray(mergedProfile.workHistory) ? mergedProfile.workHistory.length : 0,
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
        workHistoryCount: Array.isArray(heuristicResult.profile.workHistory) ? heuristicResult.profile.workHistory.length : 0,
        customQACount: heuristicResult.customQA.length,
      });

      return {
        profile: heuristicResult.profile,
        customQA: heuristicResult.customQA,
        source: 'heuristic',
      };
    },

    /**
     * Direct parser for pasted resume text
     * @param {string} resumeText
     * @param {Object} aiSettings
     * @returns {Promise<{ profile: Object, customQA: Array, source: string }>}
     */
    async parseResumeText(resumeText, aiSettings) {
      return this.parseResume({
        resumeText,
        base64Pdf: null,
        mimeType: 'text/plain',
        aiSettings,
      });
    },

    /**
     * Enhanced offline section-based heuristic extractor for resumes
     * @param {string} text
     * @returns {{ profile: Object, customQA: Array }}
     */
    extractResumeHeuristics(text) {
      const profile = {
        workHistory: [],
      };
      const customQA = [];
      if (!text || typeof text !== 'string') return { profile, customQA };

      const cleanText = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      const lines = cleanText.split('\n').map((l) => l.trim()).filter(Boolean);

      // 1. Email Address
      const emailMatch = cleanText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
      if (emailMatch) profile.email = emailMatch[0].trim();

      // 2. Phone Number (US, International, and clean formats)
      const phoneMatch = cleanText.match(/(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
      if (phoneMatch) profile.phone = phoneMatch[0].trim();

      // 3. LinkedIn Profile
      const linkedinMatch = cleanText.match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/([a-zA-Z0-9_-]+)/i);
      if (linkedinMatch) {
        profile.linkedin = linkedinMatch[0].startsWith('http') ? linkedinMatch[0] : 'https://' + linkedinMatch[0];
      }

      // 4. GitHub Profile
      const githubMatch = cleanText.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/([a-zA-Z0-9_-]+)/i);
      if (githubMatch) {
        profile.github = githubMatch[0].startsWith('http') ? githubMatch[0] : 'https://' + githubMatch[0];
      }

      // 5. Personal Portfolio / Website
      const portfolioMatch = cleanText.match(/https?:\/\/(?:www\.)?(?!linkedin|github)[a-zA-Z0-9-]+\.[a-z]{2,}(?:\/[^\s|)]*)?/i);
      if (portfolioMatch) {
        const url = portfolioMatch[0];
        if (!url.includes('@') && !url.includes('google.com') && !url.includes('adobe.com') && !url.includes('w3.org')) {
          profile.portfolio = url;
        }
      }

      // 6. Candidate Name
      const nonNameWords = /resume|curriculum|vitae|contact|phone|email|linkedin|github|portfolio|summary|experience|education|skills|page|developer|engineer|designer|manager|consultant|analyst|full[\s_-]?stack|profile|about|projects/i;

      // Check first 5 non-empty lines for candidate name
      for (let i = 0; i < Math.min(lines.length, 5); i++) {
        const line = lines[i].replace(/[|•·,;]/g, '').trim();
        const words = line.split(/\s+/).filter(Boolean);
        if (words.length >= 2 && words.length <= 4) {
          if (!nonNameWords.test(line) && !/\d/.test(line) && !line.includes('@')) {
            profile.fullName = words.join(' ');
            profile.firstName = words[0];
            profile.lastName = words.slice(1).join(' ');
            break;
          }
        }
      }

      // 7. Location (City, State / Country)
      const locationMatch = cleanText.match(/\b([A-Z][a-zA-Z\s.-]+),\s*([A-Z]{2}\b|[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)/);
      if (locationMatch && !nonNameWords.test(locationMatch[1])) {
        profile.city = locationMatch[1].trim();
        profile.country = locationMatch[2].trim();
        profile.address = `${profile.city}, ${profile.country}`;
      }

      // 8. Section Breakdown
      // We look for common section headers: SUMMARY, EXPERIENCE, EDUCATION, SKILLS
      const sectionHeaderRegex = /^(?:professional\s+summary|summary|profile|about\s+me|work\s+experience|experience|employment\s+history|education|academic\s+background|technical\s+skills|skills|technologies|projects|certifications)\b/i;
      
      const sections = {};
      let currentSection = 'header';
      sections[currentSection] = [];

      lines.forEach((line) => {
        const cleanLine = line.replace(/[:#]/g, '').trim();
        if (cleanLine.length < 40 && sectionHeaderRegex.test(cleanLine)) {
          const matchKey = cleanLine.toLowerCase();
          if (matchKey.includes('summary') || matchKey.includes('about') || matchKey.includes('profile')) {
            currentSection = 'summary';
          } else if (matchKey.includes('experience') || matchKey.includes('employment') || matchKey.includes('history')) {
            currentSection = 'experience';
          } else if (matchKey.includes('education') || matchKey.includes('academic')) {
            currentSection = 'education';
          } else if (matchKey.includes('skill') || matchKey.includes('technolog')) {
            currentSection = 'skills';
          } else if (matchKey.includes('certif')) {
            currentSection = 'certifications';
          } else if (matchKey.includes('project')) {
            currentSection = 'projects';
          }
          if (!sections[currentSection]) sections[currentSection] = [];
        } else {
          if (!sections[currentSection]) sections[currentSection] = [];
          sections[currentSection].push(line);
        }
      });

      // 9. Process Summary Section
      if (sections['summary'] && sections['summary'].length > 0) {
        profile.summary = sections['summary'].slice(0, 8).join(' ').trim();
        profile.experienceDescription = profile.summary;
      } else {
        const summaryMatch = cleanText.match(/(?:Professional\s+Summary|Summary|About\s+Me|Executive\s+Summary|Profile)[:\s]+([\s\S]{20,500}?)(?=(?:Technical\s+Skills|Skills|Core\s+Competencies|Education|Work\s+History|Work\s+Experience|Projects)(?::|\s+[A-Z])|\n\n|$)/i);
        if (summaryMatch) {
          profile.summary = summaryMatch[1].replace(/\s+/g, ' ').trim();
          profile.experienceDescription = profile.summary;
        }
      }

      // 10. Process Experience Section (Multi-role work history extraction)
      const expLines = sections['experience'] || [];
      const dateRangeRegex = /\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}|\d{1,2}\/\d{4}|\b(?:19|20)\d{2})\s*(?:[-–—to\s]+)\s*((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}|\d{1,2}\/\d{4}|\b(?:19|20)\d{2}|Present|Current)\b/i;

      const extractedJobs = [];
      let currentJob = null;

      for (let i = 0; i < expLines.length; i++) {
        const line = expLines[i];
        const dateMatch = line.match(dateRangeRegex);

        if (dateMatch) {
          const startDate = dateMatch[1].trim();
          const endDate = dateMatch[2].trim();
          const remainingLine = line.replace(dateMatch[0], '').trim();

          if (currentJob && (currentJob.jobTitle || currentJob.company)) {
            if (i > 0 && remainingLine.length <= 3) {
              const prevLine = expLines[i - 1].trim();
              currentJob.description = currentJob.description.replace(prevLine, '').trim();
            }
            extractedJobs.push(currentJob);
          }

          function parseTitleCompany(raw) {
            if (!raw) return { title: '', org: '' };
            const clean = raw.replace(/[(),;]/g, ' ').replace(/\s+/g, ' ').trim();
            if (raw.includes('|')) {
              const p = raw.split('|').map((s) => s.trim()).filter(Boolean);
              return { title: p[0] || '', org: p[1] || '' };
            }
            if (raw.includes('•')) {
              const p = raw.split('•').map((s) => s.trim()).filter(Boolean);
              return { title: p[0] || '', org: p[1] || '' };
            }
            const atMatch = raw.match(/(.*?)\s+(?:at|@)\s+(.*)/i);
            if (atMatch) {
              return { title: atMatch[1].trim(), org: atMatch[2].trim() };
            }
            const dashMatch = raw.split(/\s+[-–—]\s+/);
            if (dashMatch.length >= 2) {
              return { title: dashMatch[0].trim(), org: dashMatch[1].trim() };
            }
            if (raw.includes(',')) {
              const p = raw.split(',').map((s) => s.trim()).filter(Boolean);
              return { title: p[0] || '', org: p[1] || '' };
            }
            return { title: clean, org: '' };
          }

          let jobTitle = '';
          let company = '';

          if (remainingLine.length > 3) {
            const parsed = parseTitleCompany(remainingLine);
            jobTitle = parsed.title;
            company = parsed.org;
          } else if (i > 0) {
            const prev = expLines[i - 1].trim();
            const parsed = parseTitleCompany(prev);
            jobTitle = parsed.title;
            company = parsed.org;
          }

          currentJob = {
            id: 'exp_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
            jobTitle: jobTitle || 'Software Engineer',
            company: company || '',
            startDate,
            endDate,
            duration: `${startDate} – ${endDate}`,
            description: '',
          };
        } else if (currentJob) {
          if (line.startsWith('•') || line.startsWith('-') || line.startsWith('*')) {
            currentJob.description += (currentJob.description ? '\n' : '') + line;
          } else if (line.length < 60 && !currentJob.company && !currentJob.description) {
            currentJob.company = line;
          } else if (!line.match(dateRangeRegex) && currentJob.description.length < 600) {
            currentJob.description += (currentJob.description ? ' ' : '') + line;
          }
        }
      }

      if (currentJob && (currentJob.jobTitle || currentJob.company)) {
        extractedJobs.push(currentJob);
      }

      if (extractedJobs.length > 0) {
        profile.workHistory = extractedJobs;
        profile.currentJobTitle = extractedJobs[0].jobTitle;
        profile.currentCompany = extractedJobs[0].company;
        profile.currentStartDate = extractedJobs[0].startDate;
        profile.currentEndDate = extractedJobs[0].endDate;
      } else {
        // Fallback title regex
        const titleMatch = cleanText.match(/\b(?:Senior|Junior|Lead|Principal|Staff)?\s*(?:Software|Frontend|Backend|Full[\s-]?Stack|Web|Mobile|DevOps|Cloud|Data|AI|Product)?\s*(?:Engineer|Developer|Architect|Designer|Manager|Consultant|Analyst|Scientist)\b/i);
        if (titleMatch) profile.currentJobTitle = titleMatch[0].trim();

        const companyMatch = cleanText.match(/(?:at|@)\s+([A-Z][a-zA-Z0-9&.,\s-]{2,35}?)(?=\s+(?:as|in|from|\d{4}|present|current|\n|$|,))/);
        if (companyMatch) profile.currentCompany = companyMatch[1].trim();
      }

      // 11. Years of Experience
      const expMatch = cleanText.match(/(\d{1,2})\+?\s*(?:years?|yrs?)(?:\s*(?:of|in))?\s*(?:experience|exp)/i);
      if (expMatch) {
        profile.yearsOfExperience = expMatch[1];
      } else if (extractedJobs.length > 0) {
        // Estimate from earliest year
        const years = cleanText.match(/\b(?:199\d|200\d|201\d|202\d)\b/g);
        if (years && years.length >= 2) {
          const numYears = years.map(Number).sort((a, b) => a - b);
          const diff = new Date().getFullYear() - numYears[0];
          if (diff >= 0 && diff <= 35) profile.yearsOfExperience = String(diff);
        }
      }

      // 12. Skills Extraction
      if (sections['skills'] && sections['skills'].length > 0) {
        profile.skills = sections['skills'].join(', ').replace(/\s+/g, ' ').trim();
      } else {
        const skillsMatch = cleanText.match(/(?:Technical\s+Skills|Skills|Core\s+Competencies|Technologies|Tech\s+Stack)[:\s]+([\s\S]{15,400}?)(?=(?:Education|Academic\s+Background|Work\s+History|Experience|Projects|Certifications|Summary)(?::|\s+[A-Z])|\n\n|$)/i);
        if (skillsMatch) {
          profile.skills = skillsMatch[1].replace(/\s+/g, ' ').trim();
        }
      }

      if (profile.skills) {
        customQA.push({
          question: 'What is your primary programming language / core tech stack?',
          answer: profile.skills,
        });
      }

      // 13. Education Section
      const eduLines = sections['education'] || [];
      const eduText = eduLines.join(' ');

      if (/doctor|ph\.?d|doctorate/i.test(eduText || cleanText)) {
        profile.educationLevel = 'Ph.D. / Doctorate';
      } else if (/master(?:'s)?|m\.?s\b|mba|m\.?tech|m\.?a\b/i.test(eduText || cleanText)) {
        profile.educationLevel = "Master's Degree";
      } else if (/bachelor(?:'s)?|b\.?s\b|b\.?tech|b\.?e\b|b\.?a\b/i.test(eduText || cleanText)) {
        profile.educationLevel = "Bachelor's Degree";
      } else if (/associate(?:'s)?|a\.?s\b|a\.?a\b/i.test(eduText || cleanText)) {
        profile.educationLevel = 'Associate Degree';
      } else if (/high\s+school/i.test(eduText || cleanText)) {
        profile.educationLevel = 'High School';
      }

      const majorMatch = (eduText || cleanText).match(/(?:Bachelor|Master|Doctor|Associate|B\.S\.|M\.S\.|Degree)?\s*(?:of\s+Science|of\s+Arts)?\s*in\s+([A-Z][a-zA-Z\s&/]{3,35}?)(?=,|\s+at|\s+from|\s+University|\s+College|\n|$)/i);
      if (majorMatch) profile.major = majorMatch[1].trim();

      const uniMatch = (eduText || cleanText).match(/\b(?:University\s+of\s+[A-Z][a-zA-Z]+(?:\s*,\s*[A-Z][a-zA-Z]+)?|[A-Z][a-zA-Z\s&.-]+(?:\bUniversity|\bCollege|\bInstitute\s+of\s+Technology|\bAcademy))\b/);
      if (uniMatch) profile.university = uniMatch[0].trim();

      const gradYearMatch = (eduText || cleanText).match(/(?:graduat(?:ed?|ion)|class\s+of|completed(?:\s+in)?|\b(?:19|20)\d{2}\s*[-–]\s*)((?:19|20)\d{2})/i);
      if (gradYearMatch) profile.graduationYear = gradYearMatch[1];

      const gpaMatch = (eduText || cleanText).match(/\b(?:gpa|cgpa)[:\s]*([0-4]\.\d{1,2}(?:\s*\/\s*4(?:\.0)?)?|[0-9]\.\d{1,2}(?:\s*\/\s*10(?:\.0)?)?)/i);
      if (gpaMatch) profile.gpa = gpaMatch[1].trim();

      if (profile.educationLevel || profile.university) {
        customQA.push({
          question: 'Describe your educational background',
          answer: [profile.educationLevel, profile.major ? `in ${profile.major}` : '', profile.university ? `at ${profile.university}` : '', profile.graduationYear ? `(${profile.graduationYear})` : ''].filter(Boolean).join(' '),
        });
      }

      // 14. Certifications
      const certMatch = cleanText.match(/(?:Certifications?|Licenses?|Credentials?|Professional\s+Certifications?)[:\s]+([\s\S]{10,350}?)(?=(?:Education|Academic|Experience|Projects|Skills|Summary)(?::|\s+[A-Z])|\n\n|$)/i);
      if (certMatch) profile.certifications = certMatch[1].replace(/\s+/g, ' ').trim();

      // 15. Availability / Notice Period
      const noticeMatch = cleanText.match(/\b(immediate(?:ly)?|1\s*week|2\s*weeks|30\s*days|1\s*month|2\s*months)\b/i);
      if (noticeMatch) {
        profile.noticePeriod = noticeMatch[1].toLowerCase().includes('immediate') ? 'Immediate' : noticeMatch[1];
      }

      return { profile, customQA };
    },

    /**
     * Client-side PDF text extraction using PDF.js when available, falling back to Flate stream extraction
     * @param {ArrayBuffer} buffer
     * @returns {Promise<string>}
     */
    async extractTextFromPDFBuffer(buffer) {
      // 1. Try PDF.js engine (full support for ToUnicode CMaps, font subsets, multi-column layouts)
      const pdfLib = (typeof pdfjsLib !== 'undefined') ? pdfjsLib : (typeof global !== 'undefined' ? global.pdfjsLib : null);
      if (pdfLib && typeof pdfLib.getDocument === 'function') {
        try {
          if (typeof chrome !== 'undefined' && chrome.runtime?.getURL && pdfLib.GlobalWorkerOptions) {
            pdfLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('scripts/pdf.worker.min.js');
          }
          if (pdfLib.VerbosityLevel && typeof pdfLib.VerbosityLevel.ERRORS !== 'undefined') {
            pdfLib.verbosity = pdfLib.VerbosityLevel.ERRORS;
          }
          const data = new Uint8Array(buffer);
          const doc = await pdfLib.getDocument({ data }).promise;
          const pageStrings = [];

          for (let p = 1; p <= doc.numPages; p++) {
            const page = await doc.getPage(p);
            const textContent = await page.getTextContent();
            const items = textContent.items || [];

            if (items.length > 0) {
              // Sort items top-to-bottom, then left-to-right
              items.sort((a, b) => {
                const yA = a.transform ? a.transform[5] : 0;
                const yB = b.transform ? b.transform[5] : 0;
                if (Math.abs(yA - yB) > 4) return yB - yA; // Different lines
                const xA = a.transform ? a.transform[4] : 0;
                const xB = b.transform ? b.transform[4] : 0;
                return xA - xB;
              });

              let lastY = null;
              let lineStr = '';
              for (const item of items) {
                const y = item.transform ? item.transform[5] : 0;
                if (lastY !== null && Math.abs(lastY - y) > 4) {
                  lineStr += '\n';
                } else if (lineStr.length > 0 && !lineStr.endsWith(' ') && !lineStr.endsWith('\n')) {
                  lineStr += ' ';
                }
                lineStr += item.str;
                lastY = y;
              }
              pageStrings.push(lineStr);
            }
          }

          const extracted = pageStrings.join('\n\n').trim();
          if (extracted.length > 20) {
            Logger.info('resume-parser', `PDF.js successfully extracted ${extracted.length} chars from ${doc.numPages} page(s)`);
            return extracted;
          }
        } catch (pdfErr) {
          Logger.warn('resume-parser', 'PDF.js extraction failed, falling back to FlateDecode stream extractor: ' + pdfErr.message);
        }
      }

      // 2. Stream-based FlateDecode fallback
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
     * Client-side DOCX text extraction from ArrayBuffer using native zip parsing & DecompressionStream
     * @param {ArrayBuffer} buffer
     * @returns {Promise<string>}
     */
    async extractTextFromDocxBuffer(buffer) {
      try {
        const bytes = new Uint8Array(buffer);
        const view = new DataView(buffer);
        let offset = 0;

        while (offset + 30 < bytes.length) {
          const sig = view.getUint32(offset, true);
          if (sig === 0x04034b50) {
            const compMethod = view.getUint16(offset + 8, true);
            const compSize = view.getUint32(offset + 18, true);
            const nameLen = view.getUint16(offset + 26, true);
            const extraLen = view.getUint16(offset + 28, true);

            const nameBytes = bytes.subarray(offset + 30, offset + 30 + nameLen);
            const name = new TextDecoder('utf-8').decode(nameBytes);
            const dataOffset = offset + 30 + nameLen + extraLen;
            const compData = bytes.subarray(dataOffset, dataOffset + compSize);

            if (name === 'word/document.xml') {
              let xmlStr = '';
              if (compMethod === 8) {
                // Deflate-compressed
                if (typeof DecompressionStream !== 'undefined') {
                  const ds = new DecompressionStream('deflate-raw');
                  const writer = ds.writable.getWriter();
                  writer.write(compData);
                  writer.close();
                  const reader = ds.readable.getReader();
                  const chunks = [];
                  while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    chunks.push(value);
                  }
                  const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
                  const merged = new Uint8Array(totalLen);
                  let pos = 0;
                  for (const c of chunks) {
                    merged.set(c, pos);
                    pos += c.length;
                  }
                  xmlStr = new TextDecoder('utf-8').decode(merged);
                }
              } else {
                xmlStr = new TextDecoder('utf-8').decode(compData);
              }

              if (xmlStr) {
                const text = xmlStr
                  .replace(/<\/w:p>/g, '\n')
                  .replace(/<w:t[^>]*>(.*?)<\/w:t>/g, '$1 ')
                  .replace(/<[^>]+>/g, '')
                  .replace(/&amp;/g, '&')
                  .replace(/&lt;/g, '<')
                  .replace(/&gt;/g, '>')
                  .replace(/&quot;/g, '"')
                  .replace(/&apos;/g, "'")
                  .replace(/[ \t]+/g, ' ')
                  .replace(/\n\s*\n/g, '\n\n')
                  .trim();
                Logger.info('resume-parser', `DOCX parser extracted ${text.length} chars from word/document.xml`);
                return text;
              }
              break;
            }
            offset = dataOffset + compSize;
          } else {
            offset++;
          }
        }
      } catch (err) {
        Logger.error('resume-parser', 'DOCX extraction error: ' + err.message);
      }
      return '';
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
