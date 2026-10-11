# ⚡ QuickFill — AI-Powered Job Application AutoFiller

[![Chrome Extension](https://img.shields.io/badge/Chrome_Extension-Manifest_V3-4285F4?style=flat-square&logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/mv3/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)
[![Google Gemini API](https://img.shields.io/badge/AI-Google_Gemini_3.8_/_3.x_/_2.5-orange?style=flat-square&logo=google)](https://aistudio.google.com/)
[![OpenAI API](https://img.shields.io/badge/AI-OpenAI_GPT--4o_/_o3--mini-green?style=flat-square&logo=openai&logoColor=white)](https://platform.openai.com/)

**QuickFill** is a privacy-first, high-performance Chrome Extension (Manifest V3) that eliminates the repetitive grind of filling out job applications. By combining local heuristic field recognition with Google Gemini & OpenAI intelligence, QuickFill automatically identifies, maps, and accurately fills application forms across Greenhouse, Lever, Workday, Ashby, Taleo, and custom company career portals in seconds.

---

## 🌟 Key Features

### 1. 🎯 Intelligent Form Recognition & Filling
- **Universal ATS Compatibility**: Tailored detectors for **Greenhouse**, **Lever**, **Workday**, **Ashby**, **Taleo**, and generic HTML5/WAI-ARIA forms.
- **Smart Heuristic Field Matching**: Instant, zero-latency detection of personal info, contact details, work history, education, social profiles, and work authorization questions.
- **Native Event Emulation**: Dispatches realistic `input`, `change`, `blur`, and keyboard events to trigger modern reactive frameworks (React, Angular, Vue, Redux).
- **Interactive Month/Year Date Picker**: Built-in month & year picker ensures clean, valid standard date formats without manual typing errors.

### 2. 🤖 Hybrid AI Engine (Google Gemini & OpenAI)
- **Latest 2026 Model Support**:
  - **Gemini 3.8 Flash** *(Default)* — Flagship high-speed model optimized for agentic loops & form filling.
  - **Gemini 3.6 Flash** & **Gemini 3 Flash Preview** — Fast incremental & preview reasoning.
  - **Gemini 3.1 Pro Preview** — Deep reasoning for long-form answers and complex essays.
  - **Gemini 3.5 Flash Lite** & **Gemini 3.1 Flash Lite** — Ultra-low-latency, high-throughput variants.
  - **Gemini 2.5 Flash / Pro / Flash-Lite** — Stable, production-grade models.
  - **OpenAI GPT-4o, GPT-4o Mini & o3-mini**.
- **Context-Aware Question Answering**: Automatically drafts authentic responses for subjective questions (*"Why do you want to join us?"*, *"Describe a challenging project"*), leveraging your saved resume and profile context.
- **Zero-Latency AI Cache**: Answers to repeated job questions are auto-cached locally. Repeated questions fill in **0ms** without consuming API tokens or rate limits.
- **Sliding-Window Rate Limiter**: Built-in 14 RPM throttling protects free-tier keys from HTTP 429 quota exhaustion.
- **Sub-Second Key Verification**: Fast metadata ping (`GET /v1beta/models`) verifies API keys and project model entitlements in **< 400ms**.

### 3. 📄 Smart Resume Parsing
- **Drag-and-Drop Resume Import**: Drop your PDF or text resume to automatically populate your profile fields (Contact, Work Experience, Education, Skills, and Summary).
- **Dual-Layer Extraction**: Uses local regex heuristics with graceful AI synthesis fallback for unmatched resume blocks.

### 4. 📚 Custom Q&A Knowledge Base
- Pre-save answers to common employer questionnaires:
  - Work Authorization / Visa Sponsorship
  - Salary Expectations & Currency Preferences
  - Notice Period & Earliest Start Date
  - Demographic & Voluntary Disclosure preferences

### 5. 🎨 Modern Vercel-Inspired UI
- Sleek dark and light mode theme switcher.
- Non-intrusive floating in-page QuickFill pill for one-click filling right inside the job application page.
- Skills manager with dynamic autocomplete and quick-select suggestion chips.
- Integrated diagnostics and telemetry log viewer for transparent tracking.

---

## 🏗️ Architecture & Project Structure

The extension follows a modular, decoupled architecture:

```
AutoFillJobs/
├── manifest.json              # Chrome Extension Manifest V3 configuration
├── background.js              # Service worker router & background orchestrator
├── content.js                 # Content script coordinator & in-page floating pill
├── options.html               # Settings dashboard (Tabs: Resume, Experience, AI, Logs)
├── options.js                 # Dashboard logic, state management, autocomplete & test ping
├── options.css                # Polished design system (Dark/Light themes, Vercel styling)
├── popup.html                 # Extension toolbar popup interface
├── popup.js                   # Popup trigger actions, telemetry badges & toggles
├── popup.css                  # Popup styling & micro-animations
├── test-form.html             # Local mock application form for offline testing
├── icons/                     # Extension branding icons (16px, 48px, 128px)
└── scripts/
    ├── logger.js              # Centralized logging & error telemetry system
    ├── field-matcher.js       # Regex patterns & heuristic field recognition dictionary
    ├── dom-filler.js          # Direct DOM value setter & reactive event dispatcher
    ├── form-engine.js         # Form field scanner, selector engine & score-based matcher
    ├── ai-filler.js           # Content script orchestrator for background AI generation
    ├── ai-service.js          # Gemini & OpenAI client, caching, rate limiting & ping
    └── resume-parser.js       # PDF text extractor & profile synthesis engine
```

---

## 🚀 Installation & Getting Started

### Prerequisites
- Google Chrome, Brave, Microsoft Edge, or any Chromium-based browser.
- (Optional) A free [Google AI Studio API Key](https://aistudio.google.com/apikey) or [OpenAI API Key](https://platform.openai.com/api-keys) for AI question answering.

### Step-by-Step Setup

1. **Clone or Download the Repository**:
   ```bash
   git clone https://github.com/naveenkumar80/AutoFillJobs.git
   ```
   *(Or download and extract the ZIP file to your computer).*

2. **Open Extensions in Chrome**:
   - Navigate to `chrome://extensions` in your browser address bar.
   - Enable **Developer mode** toggle in the top-right corner.

3. **Load the Extension**:
   - Click the **Load unpacked** button in the top-left.
   - Select the `AutoFillJobs` folder containing `manifest.json`.
   - The **Job Application QuickFill** extension will appear in your extensions list.

4. **Pin the Extension**:
   - Click the puzzle icon (Extensions) in your browser toolbar and pin **QuickFill** for quick access.

---

## ⚙️ Configuration

1. **Open Settings**:
   - Right-click the QuickFill icon and choose **Options**, or click the gear icon inside the popup.
2. **Import or Enter Profile Details**:
   - **Resume Import**: Upload your PDF resume to auto-fill your profile fields.
   - **Personal Details**: Verify your name, email, phone, location, LinkedIn, GitHub, and portfolio links.
   - **Work Experience**: Add your roles with company names, titles, and dates.
   - **Skills & Tech**: Add your primary languages, tools, and frameworks.
   - **Knowledge Base**: Add custom Q&A answers for standard application questions.
3. **Configure AI Engine (Optional)**:
   - Navigate to the **AI Engine** tab.
   - Toggle **Enable AI Auto-Fill**.
   - Select **Google Gemini** or **OpenAI**.
   - Select your preferred model (e.g., `gemini-3.8-flash` or `gpt-4o-mini`).
   - Paste your API Key and click **Test Connection** (responds in < 400ms).
4. **Save Changes**:
   - Click **Save Changes** or press `Ctrl + S`.

---

## 💻 How to Use

1. Navigate to any supported job application page (e.g., Greenhouse, Lever, Workday, or the included `test-form.html`).
2. When the page loads, QuickFill automatically detects the application form:
   - Click the floating **⚡ QuickFill** pill on the page, OR
   - Click the extension icon in your browser toolbar and click **Fill Application Now**.
3. All matched profile fields are instantly filled.
4. If AI Auto-Fill is enabled, unmapped long-form questions are synthesized in the background and filled with smooth visual highlights.
5. Review your application and submit!

---

## 🔒 Privacy & Security

- **100% Local Storage**: All profile data, work history, resume information, and API keys are stored exclusively in your browser's `chrome.storage.local`.
- **Zero Third-Party Tracking**: QuickFill has no analytics, tracking servers, or telemetry collection.
- **Direct API Communication**: When AI features are enabled, requests are sent directly from your browser to Google Generative Language or OpenAI endpoints. Your data is never routed through an intermediary proxy.

---

## 🧪 Testing Locally

A mock application form is bundled for development and testing:
1. Open [`test-form.html`](test-form.html) directly in Chrome:
   ```
   file:///c:/path/to/AutoFillJobs/test-form.html
   ```
2. Click the floating **⚡ QuickFill** pill or use the popup to verify form detection, field matching, and date pickers offline.

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
