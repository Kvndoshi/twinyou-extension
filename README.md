# TwinYou - AI Compose Assistant (Browser Extension)

AI-powered text composition assistant that learns your writing style. Works on any website — emails, messages, documents, and more.

## Features

- **Smart Compose**: Analyzes page context and generates drafts in your voice
- **Document Editor Support**: Works with Google Docs, Word Online, and more
- **Chat Assistant**: In-page chat panel with page-aware conversation (Alt+W)
- **Selection Rewrite**: Highlight text and rewrite it with AI
- **BYOK (Bring Your Own Key)**: Use your own API keys for OpenAI, Anthropic, Gemini, or OpenRouter
- **Keyboard Shortcuts**: Alt+Q to compose, Alt+W to toggle chat
- **Privacy First**: Your API keys stay in your browser, never stored on servers

## Beta Testing Guide

### Step 1: Download the Extension

1. Download or clone this repository to your computer
2. Unzip if needed — you should have a folder containing `manifest.json`, `background.js`, `content.js`, etc.

### Step 2: Install in Chrome / Edge / Brave

1. Open your browser and go to `chrome://extensions/` (or `edge://extensions/` for Edge)
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **"Load unpacked"**
4. Select the folder containing `manifest.json` (the root of this repo)
5. The extension icon should appear in your toolbar

### Step 3: Sign In

1. Click the TwinYou extension icon in your toolbar
2. Click **"Sign in with Google"**
3. Complete the Google sign-in flow
4. You should see your name and a "Compose" button

### Step 4: Start Using

#### Quick Compose (Alt+Q)
1. Go to any website with a text field (Gmail, LinkedIn, Slack, etc.)
2. Click into the text field you want to write in
3. Press **Alt+Q** or click the extension icon and hit **"Compose"**
4. The AI will analyze the page context and generate a draft
5. The draft is automatically inserted into the field

#### Chat Assistant (Alt+W)
1. Press **Alt+W** on any page to open the chat panel
2. **Chat mode**: General conversation with your AI assistant
3. **With Page mode**: Ask questions about the current page content
4. **Agent mode**: Let the AI fill in form fields for you

#### Selection Rewrite
1. Select/highlight any text in a text field
2. Press **Alt+Q** or click "Compose"
3. Enter a prompt (e.g., "make it more professional")
4. The selected text will be rewritten in place

#### Document Editors
- Works in **Google Docs** and **Word Online**
- Place your cursor where you want text, then press Alt+Q
- Supports full document rewrite or cursor-position insertion

### Step 5: Settings (Optional)

Click the gear icon in the extension popup to:
- **Add your own API key (BYOK)**: Use your preferred LLM provider
- **Change the server URL**: Point to a different backend if needed
- **Select a preferred model**: Choose which AI model to use

## Supported Platforms

Works on any website with text input fields. Tested on:
- Gmail, Outlook, Yahoo Mail
- LinkedIn (messages, posts, comments)
- Slack, Discord, WhatsApp Web
- Twitter/X, Reddit, Facebook
- Google Docs, Word Online
- ChatGPT, Claude, and other AI chat interfaces
- Job application forms
- Any contenteditable field or textarea

## Reporting Issues

Found a bug or have feedback? Please open an issue on this repository with:
1. What you were trying to do
2. What happened instead
3. The website/platform you were using
4. Your browser name and version

## Privacy

Your data is handled with care:
- BYOK API keys are stored locally in Chrome storage and never sent to our servers
- Google sign-in is used only for authentication
- See our [Privacy Policy](privacy-policy.md) for full details

## License

MIT
