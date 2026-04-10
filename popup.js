/**
 * Compose Assistant - Popup Script
 *
 * Single-page popup with topbar navigation.
 * Views: home (compose/chat), settings (LLM config), debug (trace/history).
 */

// =============================================================================
// Configuration
// =============================================================================

// =============================================================================
// State
// =============================================================================

let state = {
  user: null,
  serverUrl: '',  // loaded from background.js via get-settings
  byok: { provider: '', apiKey: '', model: '', baseUrl: '' },
  preferredModel: '',
  lastResult: null,
  debugHistory: [],
  selectionData: null,  // { fullText, selectedText, start, end }
  isComposing: false,
  credit_tier: 'free'
};

let currentView = 'home';

// =============================================================================
// DOM Elements
// =============================================================================

const $ = id => document.getElementById(id);

const elements = {
  authSection: $('auth-section'),
  mainSection: $('main-section'),
  googleSignInBtn: $('google-sign-in-btn'),
  authError: $('auth-error'),
  // Topbar
  userDisplayName: $('user-display-name'),
  userIdDisplay: $('user-id-display'),
  settingsBtn: $('settings-btn'),
  debugBtn: $('debug-btn'),
  // Selection mode
  selectionMode: $('selection-mode'),
  selectedTextPreview: $('selected-text-preview'),
  selectionForm: $('selection-form'),
  selectionPrompt: $('selection-prompt'),
  // Status
  status: $('status'),
  statusText: $('status-text'),
  // No field
  noField: $('no-field'),
  // Results
  results: $('results'),
  resultTime: $('result-time'),
  intentDisplay: $('intent-display'),
  platformDisplay: $('platform-display'),
  confidenceDisplay: $('confidence-display'),
  tokenDisplay: $('token-display'),
  draftDisplay: $('draft-display'),
  copyBtn: $('copy-btn'),
  insertBtn: $('insert-btn'),
  retryBtn: $('retry-btn'),
  // Error
  errorSection: $('error-section'),
  errorMessage: $('error-message'),
  retryErrorBtn: $('retry-error-btn'),
  // Settings
  byokProvider: $('byok-provider'),
  byokFields: $('byok-fields'),
  byokBaseUrlGroup: $('byok-baseurl-group'),
  byokBaseUrl: $('byok-baseurl'),
  byokApikey: $('byok-apikey'),
  byokModel: $('byok-model'),
  saveSettingsBtn: $('save-settings-btn'),
  logoutBtn: $('logout-btn'),
  // Debug
  debugHistoryContainer: $('debug-history-container'),
  // Quick Note (home view)
  noteInput: $('note-input'),
  saveNoteBtn: $('save-note-btn'),
  noteFeedback: $('note-feedback'),
  // Quick Note (settings view)
  settingsNoteInput: $('settings-note-input'),
  saveSettingsNoteBtn: $('save-settings-note-btn'),
  settingsNoteFeedback: $('settings-note-feedback'),
};

// =============================================================================
// Credit Status
// =============================================================================

function updateCreditStatus(tier, remainingUsd, usageUsd, budgetUsd) {
  // Detect BYOK from local config (server only stores paid/free, never "byok")
  const isByok = state.byok.provider && state.byok.apiKey;
  const effectiveTier = isByok ? 'byok' : tier;
  const budget = budgetUsd || 5.0;
  const usage = usageUsd || 0.0;
  const remaining = remainingUsd != null ? remainingUsd : budget;

  // Update settings view card (if visible)
  const badge = document.getElementById('credit-tier-badge');
  const message = document.getElementById('credit-tier-message');
  if (badge && message) {
    if (effectiveTier === 'paid') {
      badge.textContent = 'Paid';
      badge.className = 'badge confidence';
      message.textContent = `$${remaining.toFixed(2)} remaining of $${budget.toFixed(2)}`;
    } else if (effectiveTier === 'byok') {
      badge.textContent = 'Your Key';
      badge.className = 'badge platform';
      message.textContent = 'Using your own API key';
    } else {
      badge.textContent = 'Free';
      badge.className = 'badge tokens';
      message.textContent = 'Credit exhausted. Using free models.';
    }
  }

  // Update topbar badge (always visible)
  const topbarBadge = document.getElementById('topbar-credit-badge');
  if (topbarBadge) {
    topbarBadge.className = 'topbar-credit tier-' + effectiveTier;
    if (effectiveTier === 'paid') {
      topbarBadge.textContent = `$${remaining.toFixed(2)}`;
    } else if (effectiveTier === 'byok') {
      topbarBadge.textContent = 'BYOK';
    } else {
      topbarBadge.textContent = 'Free';
    }
  }

  // Update home view account status card
  const homeTierBadge = document.getElementById('home-tier-badge');
  const homeTierModel = document.getElementById('home-tier-model');
  const homeCreditRemaining = document.getElementById('home-credit-remaining');
  const homeUsageBar = document.getElementById('home-usage-bar');
  const homeUsageText = document.getElementById('home-usage-text');
  const homeCard = document.getElementById('account-status');

  if (homeTierBadge) {
    homeTierBadge.textContent = effectiveTier === 'byok' ? 'BYOK' : effectiveTier === 'paid' ? 'Paid' : 'Free';
    homeTierBadge.className = 'tier-indicator tier-' + effectiveTier;
  }
  if (homeTierModel) {
    if (effectiveTier === 'paid') {
      const modelName = state.preferredModel || 'gemini-3-flash-preview';
      const labels = {
        '': 'Gemini 3 Flash',
        'gemini-3-flash-preview': 'Gemini 3 Flash',
        'gemini-3.1-flash-lite-preview': 'Gemini 3.1 Flash Lite',
        'gemini-3.1-pro-preview': 'Gemini 3.1 Pro',
      };
      homeTierModel.textContent = labels[modelName] || modelName;
    } else if (effectiveTier === 'byok') {
      homeTierModel.textContent = 'Your own provider';
    } else {
      homeTierModel.textContent = 'Qwen Free';
    }
  }
  if (homeCreditRemaining) {
    if (effectiveTier === 'byok') {
      homeCreditRemaining.textContent = '--';
    } else {
      homeCreditRemaining.textContent = `$${remaining.toFixed(2)}`;
    }
  }
  if (homeUsageBar) {
    if (effectiveTier === 'byok') {
      homeUsageBar.style.width = '0%';
    } else {
      const pct = budget > 0 ? Math.min(100, (usage / budget) * 100) : 0;
      homeUsageBar.style.width = `${100 - pct}%`;
      homeUsageBar.className = 'account-usage-bar' + (pct > 90 ? ' exhausted' : pct > 70 ? ' low' : '');
    }
  }
  if (homeUsageText) {
    if (effectiveTier === 'byok') {
      homeUsageText.textContent = 'Using your own API key';
    } else {
      homeUsageText.textContent = `$${usage.toFixed(4)} used of $${budget.toFixed(2)}`;
    }
  }
}

async function fetchCreditStatus() {
  try {
    const data = await apiCall('/auth/credits');
    console.log('[credits] response:', data);
    if (data && data.credit_tier) {
      state.credit_tier = data.credit_tier;
      await chrome.storage.local.set({ credit_tier: data.credit_tier });
      updateCreditStatus(data.credit_tier, data.remaining_usd, data.usage_usd, data.budget_usd);
    }
  } catch (e) {
    console.error('[credits] fetch failed:', e);
    updateCreditStatus(state.credit_tier);
  }
}

// =============================================================================
// Storage
// =============================================================================

async function loadState() {
  const syncData = await chrome.storage.sync.get(['user']);
  const localData = await chrome.storage.local.get(['lastResult', 'debugHistory', 'byok', 'preferredModel', 'credit_tier']);

  // Clean up any stale serverUrl from storage
  chrome.storage.sync.remove('serverUrl');

  if (syncData.user) state.user = syncData.user;

  // BYOK lives in local storage (API keys should not sync across devices)
  if (localData.byok) {
    state.byok = localData.byok;
  } else {
    // Migrate from sync → local (one-time, for existing installs)
    const oldSync = await chrome.storage.sync.get(['byok']);
    if (oldSync.byok && oldSync.byok.provider) {
      state.byok = oldSync.byok;
      await chrome.storage.local.set({ byok: oldSync.byok });
      await chrome.storage.sync.remove('byok');
    }
  }

  if (localData.preferredModel) state.preferredModel = localData.preferredModel;
  if (localData.credit_tier) state.credit_tier = localData.credit_tier;

  // Get server URL from background.js (single source of truth)
  const bgSettings = await new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'get-settings' }, resolve);
  });
  state.serverUrl = bgSettings?.serverUrl || '';
  if (localData.lastResult) state.lastResult = localData.lastResult;

  // Load debug history, migrate from lastResult if needed
  if (localData.debugHistory && localData.debugHistory.length > 0) {
    state.debugHistory = localData.debugHistory;
  } else if (localData.lastResult) {
    state.debugHistory = [{ ...localData.lastResult, id: Date.now() + '-migrated' }];
  }
}

async function saveState() {
  // User profile syncs across devices; BYOK + model + tier stays local
  await chrome.storage.sync.set({ user: state.user });
  await chrome.storage.local.set({ byok: state.byok, preferredModel: state.preferredModel, credit_tier: state.credit_tier });
}

// =============================================================================
// View Navigation
// =============================================================================

function showView(name) {
  // Hide all views
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));

  // Show target view
  const target = document.getElementById(`view-${name}`);
  if (target) {
    target.classList.remove('hidden');
    // Re-trigger animation
    target.style.animation = 'none';
    target.offsetHeight; // force reflow
    target.style.animation = '';
  }

  // Update icon button active states
  elements.settingsBtn.classList.toggle('active', name === 'settings');
  elements.debugBtn.classList.toggle('active', name === 'debug');

  currentView = name;
}

// =============================================================================
// UI Helpers
// =============================================================================

function showSection(name) {
  elements.authSection.classList.add('hidden');
  elements.mainSection.classList.add('hidden');

  if (name === 'auth') elements.authSection.classList.remove('hidden');
  else if (name === 'main') elements.mainSection.classList.remove('hidden');
}

function hideAllMainContent() {
  elements.selectionMode.classList.add('hidden');
  elements.status.classList.add('hidden');
  elements.noField.classList.add('hidden');
  elements.results.classList.add('hidden');
  elements.errorSection.classList.add('hidden');
}

function showStatus(text) {
  hideAllMainContent();
  showView('home');
  elements.status.classList.remove('hidden');
  elements.statusText.textContent = text;
}

function showNoField() {
  hideAllMainContent();
  showView('home');
  elements.noField.classList.remove('hidden');
}

function showError(message) {
  hideAllMainContent();
  showView('home');
  elements.errorSection.classList.remove('hidden');
  elements.errorMessage.textContent = message;
}

function showSelectionMode(selectedText, fullText, start, end) {
  hideAllMainContent();
  showView('home');
  elements.selectionMode.classList.remove('hidden');

  // Store selection data
  state.selectionData = { fullText, selectedText, start, end };

  // Show preview (truncated)
  const preview = selectedText.length > 50
    ? selectedText.substring(0, 50) + '...'
    : selectedText;
  elements.selectedTextPreview.textContent = `"${preview}"`;

  // Focus the prompt input
  elements.selectionPrompt.focus();
}

function showResults(data) {
  hideAllMainContent();
  showView('home');
  elements.results.classList.remove('hidden');

  // Basic info
  elements.intentDisplay.textContent = data.user_intent || 'Unknown';
  elements.platformDisplay.textContent = data.platform || 'Unknown';
  elements.confidenceDisplay.textContent = data.confidence || 'medium';
  elements.tokenDisplay.textContent = `${data.token_consumption?.total || 0} tokens`;

  // Draft
  elements.draftDisplay.textContent = data.draft || '';

  // Timestamp
  if (data.timestamp) {
    const date = new Date(data.timestamp);
    const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    elements.resultTime.textContent = timeStr;
  } else {
    elements.resultTime.textContent = '';
  }

  // Update debug info
  updateDebugInfo(data);

  state.lastResult = data;
}

function updateDebugInfo(data) {
  // Push into debugHistory live
  const existing = state.debugHistory.find(d => d.request_id === data.request_id);
  if (!existing) {
    state.debugHistory.unshift({ ...data, id: Date.now() + '-' + Math.random().toString(36).substr(2,5) });
    if (state.debugHistory.length > 5) state.debugHistory.length = 5;
  }
  if (currentView === 'debug') renderDebugHistory();
}

function renderExecutionTrace(trace) {
  if (!trace || !trace.length) {
    return '<div class="trace-empty">No trace available</div>';
  }

  return trace.map(step => {
    const statusClass = step.status === 'completed' ? 'success' :
                       step.status === 'error' ? 'error' :
                       step.status === 'used' ? 'info' : 'pending';
    const statusIcon = step.status === 'completed' ? '&#10003;' :
                      step.status === 'error' ? '&#10007;' :
                      step.status === 'used' ? '&#8594;' :
                      step.status === 'started' ? '&#8226;' : '?';
    const duration = step.duration_ms ? ` (${step.duration_ms}ms)` : '';

    return `
      <div class="trace-step ${statusClass}">
        <span class="trace-icon">${statusIcon}</span>
        <div class="trace-info">
          <span class="trace-name">${escapeHtml(step.step || '')}</span>
          ${step.details ? `<span class="trace-details">${escapeHtml(step.details)}</span>` : ''}
          ${duration ? `<span class="trace-duration">${duration}</span>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

function renderDebugHistory() {
  const container = elements.debugHistoryContainer;
  if (!container) return;

  if (!state.debugHistory || state.debugHistory.length === 0) {
    container.innerHTML = '<div class="debug-empty-state">No compose requests yet. Trigger a compose to see debug info here.</div>';
    return;
  }

  const html = state.debugHistory.map((entry, idx) => {
    const isExpanded = idx === 0;
    const time = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '-';
    const date = entry.timestamp ? new Date(entry.timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '';
    const platform = escapeHtml(entry.platform || 'Unknown');
    const provider = escapeHtml(entry.provider_used || 'default');
    const reqId = escapeHtml((entry.request_id || '-').substring(0, 12));
    const draft = entry.draft || '(No reply)';
    const originalDraft = entry.original_draft || '(empty)';
    const traceHtml = renderExecutionTrace(entry.execution_trace);

    return `
      <div class="debug-history-card" data-idx="${idx}">
        <div class="debug-card-header">
          <div class="debug-card-header-left">
            <span class="debug-card-time">${date} ${time}</span>
            <div class="debug-card-badges">
              <span class="badge platform">${platform}</span>
              <span class="badge tokens">${provider}</span>
            </div>
          </div>
          <div class="debug-card-header-right">
            <code class="debug-card-reqid">${reqId}</code>
            <svg class="debug-card-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
          </div>
        </div>
        <div class="debug-card-body">
          <div class="debug-card-section">
            <span class="debug-card-section-label">Generated Reply</span>
            <div class="draft-content small">${escapeHtml(draft)}</div>
            <button class="btn secondary debug-copy-btn" type="button" data-copy="${escapeAttr(draft)}">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="9" y="9" width="13" height="13" rx="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
              Copy
            </button>
          </div>
          <div class="debug-card-section">
            <span class="debug-card-section-label">Original Draft</span>
            <div class="draft-content small">${escapeHtml(originalDraft)}</div>
          </div>
          <div class="debug-card-section">
            <span class="debug-card-section-label">Request Info</span>
            <div class="debug-content">
              <div class="debug-item"><span class="debug-label">Request ID:</span><code>${escapeHtml(entry.request_id || '-')}</code></div>
              <div class="debug-item"><span class="debug-label">URL:</span><code>${escapeHtml(entry.url || '-')}</code></div>
              <div class="debug-item"><span class="debug-label">Provider:</span><code>${provider}</code></div>
              <div class="debug-item"><span class="debug-label">Model:</span><code>${escapeHtml(entry.model_used || '-')}</code></div>
            </div>
          </div>
          <div class="debug-card-section">
            <span class="debug-card-section-label">Execution Trace</span>
            <div class="trace-content">${traceHtml}</div>
          </div>
        </div>
      </div>
    `;
  }).join('');

  container.innerHTML = html;

  // Expand first card by default
  const firstCard = container.querySelector('.debug-history-card');
  if (firstCard) firstCard.classList.add('expanded');

  // Bind card header toggle (expand/collapse)
  container.querySelectorAll('.debug-card-header').forEach(header => {
    header.addEventListener('click', () => {
      header.parentElement.classList.toggle('expanded');
    });
  });

  // Bind copy buttons
  container.querySelectorAll('.debug-copy-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const text = btn.getAttribute('data-copy');
      try {
        await navigator.clipboard.writeText(text);
        const orig = btn.innerHTML;
        btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg> Copied!';
        setTimeout(() => { btn.innerHTML = orig; }, 1500);
      } catch (err) { /* ignore */ }
    });
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function updateModelPlaceholder(provider) {
  const placeholders = {
    gemini: 'e.g. gemini-2.0-flash-exp, gemini-1.5-pro',
    openai: 'e.g. gpt-4o, gpt-4o-mini',
    anthropic: 'e.g. claude-3-5-sonnet-20241022',
    openrouter: 'e.g. anthropic/claude-3.5-sonnet, openai/gpt-4o',
    custom: 'e.g. llama-3-70b, mistral-large'
  };
  elements.byokModel.placeholder = placeholders[provider] || 'Model name';

  // Show/hide base URL field
  if (provider === 'custom') {
    elements.byokBaseUrlGroup.classList.remove('hidden');
  } else {
    elements.byokBaseUrlGroup.classList.add('hidden');
  }
}

function populateSettingsFields() {
  elements.byokProvider.value = state.byok.provider || '';
  elements.byokApikey.value = state.byok.apiKey || '';
  elements.byokModel.value = state.byok.model || '';
  elements.byokBaseUrl.value = state.byok.baseUrl || '';

  const modelSelector = document.getElementById('model-selector');
  const modelGroup = document.getElementById('model-selector-group');

  if (state.byok.provider) {
    elements.byokFields.classList.remove('hidden');
    updateModelPlaceholder(state.byok.provider);
    if (modelGroup) modelGroup.classList.add('hidden');
  } else {
    elements.byokFields.classList.add('hidden');
    elements.byokBaseUrlGroup.classList.add('hidden');
    if (modelGroup) modelGroup.classList.remove('hidden');
  }

  if (modelSelector) modelSelector.value = state.preferredModel || '';
}

function populateDebugInfo() {
  renderDebugHistory();
}

// =============================================================================
// API Calls
// =============================================================================

async function apiCall(endpoint, method = 'GET', body = null) {
  const url = `${state.serverUrl}${endpoint}`;
  const { sessionToken } = await chrome.storage.local.get(['sessionToken']);
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' }
  };
  if (sessionToken) {
    options.headers['Authorization'] = `Bearer ${sessionToken}`;
  }
  if (body) options.body = JSON.stringify(body);

  const response = await fetch(url, options);

  // Handle 401 — session expired
  if (response.status === 401) {
    state.user = null;
    await chrome.storage.local.remove(['sessionToken']);
    showSection('auth');
    return { success: false, error: 'Session expired. Please sign in again.' };
  }

  // User-friendly error messages for server errors
  if (!response.ok) {
    const status = response.status;
    if (status === 429) return { success: false, error: 'Too many requests. Please wait a moment and try again.' };
    if (status === 503) return { success: false, error: 'Server is temporarily unavailable. Please try again later.' };
    if (status >= 500) return { success: false, error: 'Server error. Please try again later.' };
    const text = await response.text().catch(() => '');
    return { success: false, error: `Request failed (${status}): ${text.substring(0, 100)}` };
  }

  return response.json();
}


// =============================================================================
// Compose Workflow
// =============================================================================

async function getWebPageTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  for (const tab of tabs) {
    if (tab.url && (tab.url.startsWith('http://') || tab.url.startsWith('https://'))) {
      return tab;
    }
  }
  const allTabs = await chrome.tabs.query({ active: true });
  for (const tab of allTabs) {
    if (tab.url && (tab.url.startsWith('http://') || tab.url.startsWith('https://'))) {
      return tab;
    }
  }
  return null;
}

async function triggerCompose() {
  if (state.isComposing) return;
  state.isComposing = true;

  showStatus('Capturing context...');

  try {
    const tab = await getWebPageTab();
    if (!tab) {
      showError('No web page tab found. Open a web page and try again.');
      state.isComposing = false;
      return;
    }

    const context = await chrome.tabs.sendMessage(tab.id, { type: 'CAPTURE_CONTEXT' });

    if (!context || !context.hasEditable) {
      showNoField();
      state.isComposing = false;
      return;
    }

    const selection = await chrome.tabs.sendMessage(tab.id, { type: 'GET_SELECTION' });
    if (selection && selection.selectedText && selection.selectedText.length > 0) {
      showSelectionMode(
        selection.selectedText,
        context.draftText,
        selection.start,
        selection.end
      );
      state.isComposing = false;
      return;
    }

    showStatus('Composing...');

    chrome.runtime.sendMessage({ type: 'TRIGGER_COMPOSE' });

  } catch (error) {
    console.error('Compose error:', error);
    showError(error.message || 'Failed to compose');
    state.isComposing = false;
  }
}

async function triggerSelectionRewrite(prompt) {
  if (!state.selectionData) return;
  if (!state.user || !state.user.user_id) {
    showError('Please sign in first.');
    return;
  }

  showStatus('Rewriting selection...');

  try {
    const body = {
      user_id: state.user.user_id,
      full_text: state.selectionData.fullText,
      selected_text: state.selectionData.selectedText,
      selection_start: state.selectionData.start,
      selection_end: state.selectionData.end,
      user_prompt: prompt || 'improve this text'
    };

    const result = await apiCall('/selection', 'POST', body);

    if (!result.success) {
      showError(result.error || 'Selection rewrite failed');
      return;
    }

    showResults({
      success: true,
      request_id: result.request_id,
      user_intent: `Selection rewrite: "${prompt || 'improve'}"`,
      platform: 'Selection Mode',
      draft: result.improved_draft,
      original_draft: state.selectionData.fullText,
      confidence: 'high',
      token_consumption: { total: result.tokens_used || 0 },
      timestamp: Date.now()
    });

    state.lastResult = {
      draft: result.improved_draft,
      rewritten_selection: result.rewritten_selection
    };

  } catch (error) {
    console.error('Selection rewrite error:', error);
    showError(error.message || 'Failed to rewrite selection');
  }
}

// =============================================================================
// Event Handlers
// =============================================================================

// Google Sign-In button
elements.googleSignInBtn.addEventListener('click', async () => {
  elements.googleSignInBtn.disabled = true;
  elements.googleSignInBtn.classList.add('loading');
  elements.authError.classList.add('hidden');

  try {
    const googleResult = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'GOOGLE_SIGN_IN' }, (resp) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (!resp || !resp.success) {
          reject(new Error(resp?.error || 'Google sign-in failed'));
        } else {
          resolve(resp);
        }
      });
    });

    const serverUrl = state.serverUrl;
    const serverResp = await fetch(`${serverUrl}/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: googleResult.token })
    });
    const serverResult = await serverResp.json();

    if (!serverResp.ok || (!serverResult.success && !serverResult.user_id)) {
      throw new Error(serverResult.error || 'Server authentication failed');
    }

    state.user = {
      user_id: serverResult.user_id,
      email: serverResult.email,
      name: serverResult.name || googleResult.profile.name || ''
    };
    state.credit_tier = serverResult.credit_tier || 'free';
    await chrome.storage.local.set({ credit_tier: state.credit_tier });
    updateCreditStatus(state.credit_tier);
    if (serverResult.session_token) {
      await chrome.storage.local.set({ sessionToken: serverResult.session_token });
    }
    await saveState();
    initMainSection();
  } catch (error) {
    console.error('Google sign-in error:', error);
    elements.authError.textContent = error.message || 'Sign-in failed';
    elements.authError.classList.remove('hidden');
  } finally {
    elements.googleSignInBtn.disabled = false;
    elements.googleSignInBtn.classList.remove('loading');
  }
});

// Selection form
elements.selectionForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const prompt = elements.selectionPrompt.value.trim();
  await triggerSelectionRewrite(prompt);
});

// Compose button - trigger compose on the active web page, then close popup
$('compose-btn').addEventListener('click', async () => {
  try {
    const tab = await getWebPageTab();
    if (!tab) {
      showError('No web page tab found. Open a web page and try again.');
      return;
    }
    chrome.runtime.sendMessage({ type: 'TRIGGER_COMPOSE' });
    window.close();
  } catch (e) {
    showError(e.message || 'Failed to compose');
  }
});

// Open Chat button - toggle chat panel on page
$('open-chat-btn').addEventListener('click', async () => {
  try {
    const tab = await getWebPageTab();
    if (!tab) {
      showError('No web page tab found. Open a web page first.');
      return;
    }
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_CHAT' });
    } catch (e) {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content.css'] });
      await new Promise(r => setTimeout(r, 300));
      await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_CHAT' });
    }
    window.close();
  } catch (error) {
    console.error('Chat toggle error:', error);
    showError('Failed to open chat: ' + (error.message || 'Unknown error'));
  }
});

// Settings button — toggle between home and settings
elements.settingsBtn.addEventListener('click', () => {
  if (currentView === 'settings') {
    showView('home');
  } else {
    populateSettingsFields();
    showView('settings');
    updateCreditStatus(state.credit_tier);
    // Fetch live balance from server
    if (state.user) fetchCreditStatus();
  }
});

// Debug button — toggle between home and debug
elements.debugBtn.addEventListener('click', () => {
  if (currentView === 'debug') {
    showView('home');
  } else {
    populateDebugInfo();
    showView('debug');
  }
});

// Provider change
elements.byokProvider.addEventListener('change', (e) => {
  const modelGroup = document.getElementById('model-selector-group');
  if (e.target.value) {
    elements.byokFields.classList.remove('hidden');
    updateModelPlaceholder(e.target.value);
    if (modelGroup) modelGroup.classList.add('hidden');
  } else {
    elements.byokFields.classList.add('hidden');
    elements.byokBaseUrlGroup.classList.add('hidden');
    if (modelGroup) modelGroup.classList.remove('hidden');
  }
});

// Save settings
elements.saveSettingsBtn.addEventListener('click', async () => {
  state.byok = {
    provider: elements.byokProvider.value,
    apiKey: elements.byokApikey.value,
    model: elements.byokModel.value,
    baseUrl: elements.byokBaseUrl.value
  };
  const modelSelector = document.getElementById('model-selector');
  state.preferredModel = modelSelector ? modelSelector.value : '';
  await saveState();
  updateCreditStatus(state.credit_tier);
  const feedback = document.getElementById('save-feedback');
  if (feedback) {
    feedback.classList.add('visible');
    setTimeout(() => feedback.classList.remove('visible'), 2000);
  }
});

// Send Feedback
document.getElementById('send-feedback-btn')?.addEventListener('click', async () => {
  const msgEl = document.getElementById('feedback-message');
  const catEl = document.getElementById('feedback-category');
  const statusEl = document.getElementById('feedback-status');
  const btn = document.getElementById('send-feedback-btn');
  const message = (msgEl?.value || '').trim();
  if (!message) { msgEl?.focus(); return; }
  if (!state.user?.user_id) { alert('Please sign in first.'); return; }
  btn.disabled = true;
  btn.textContent = 'Sending...';
  try {
    const result = await apiCall('/feedback', 'POST', {
      user_id: state.user.user_id,
      category: catEl?.value || 'general',
      message,
      url: '',
      page_title: '',
      extension_version: chrome.runtime.getManifest().version || '',
    });
    if (result?.success) {
      msgEl.value = '';
      if (statusEl) {
        statusEl.classList.add('visible');
        setTimeout(() => statusEl.classList.remove('visible'), 3000);
      }
    } else {
      alert(result?.error || 'Failed to send feedback');
    }
  } catch (e) {
    alert('Error: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send Feedback';
  }
});

// Logout
// Save Note — shared handler for home and settings views
async function handleSaveNote(inputEl, btnEl, feedbackEl) {
  const text = (inputEl?.value || '').trim();
  if (!text) return;
  if (!state.user || !state.user.user_id) {
    alert('Please sign in first.');
    return;
  }
  btnEl.disabled = true;
  btnEl.textContent = 'Saving...';
  try {
    const result = await apiCall('/save-note', 'POST', {
      user_id: state.user.user_id,
      note: text,
    });
    if (result && result.success) {
      inputEl.value = '';
      if (feedbackEl) {
        feedbackEl.classList.add('visible');
        setTimeout(() => feedbackEl.classList.remove('visible'), 2000);
      }
    } else {
      alert(result?.error || 'Failed to save note');
    }
  } catch (e) {
    alert('Error: ' + e.message);
  } finally {
    btnEl.disabled = false;
    btnEl.textContent = 'Save Note';
  }
}

// Home view note
if (elements.saveNoteBtn) {
  elements.saveNoteBtn.addEventListener('click', () =>
    handleSaveNote(elements.noteInput, elements.saveNoteBtn, elements.noteFeedback)
  );
}
// Settings view note
if (elements.saveSettingsNoteBtn) {
  elements.saveSettingsNoteBtn.addEventListener('click', () =>
    handleSaveNote(elements.settingsNoteInput, elements.saveSettingsNoteBtn, elements.settingsNoteFeedback)
  );
}

// Image paste support for note textareas
function addImagePasteHandler(textareaEl) {
  if (!textareaEl) return;
  textareaEl.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file || !state.user?.user_id) return;
        const ext = item.type.split('/')[1] || 'png';
        const reader = new FileReader();
        reader.onload = async () => {
          try {
            const result = await apiCall('/save-note', 'POST', {
              user_id: state.user.user_id,
              note: `[Pasted image: pasted-image.${ext}, ${(file.size / 1024).toFixed(0)}KB]`,
            });
            if (result?.success) {
              textareaEl.value += `\n[Image saved to memory: pasted-image.${ext}]`;
            }
          } catch (err) {
            console.warn('Image paste save failed:', err);
          }
        };
        reader.readAsDataURL(file);
        break;
      }
    }
  });
}
addImagePasteHandler(elements.noteInput);
addImagePasteHandler(elements.settingsNoteInput);

elements.logoutBtn.addEventListener('click', async () => {
  await new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'GOOGLE_SIGN_OUT' }, resolve);
  }).catch(() => {});
  state.user = null;
  await chrome.storage.local.remove(['sessionToken']);
  await saveState();
  showSection('auth');
});

// Copy button
elements.copyBtn.addEventListener('click', async () => {
  if (!state.lastResult?.draft) return;

  try {
    await navigator.clipboard.writeText(state.lastResult.draft);
    const btn = elements.copyBtn;
    const originalHTML = btn.innerHTML;
    btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg> Copied!';
    setTimeout(() => { btn.innerHTML = originalHTML; }, 1500);
  } catch (error) {
    console.error('Copy failed:', error);
  }
});

// Insert button
elements.insertBtn.addEventListener('click', async () => {
  chrome.runtime.sendMessage({ type: 'INSERT_LAST_DRAFT' }, (response) => {
    const btn = elements.insertBtn;
    const originalHTML = btn.innerHTML;

    if (response && response.success) {
      btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg> Inserted!';
    } else {
      btn.innerHTML = 'Failed';
    }
    setTimeout(() => { btn.innerHTML = originalHTML; }, 1500);
  });
});

// Retry buttons
elements.retryBtn.addEventListener('click', () => {
  triggerCompose();
});

elements.retryErrorBtn.addEventListener('click', () => {
  triggerCompose();
});


// =============================================================================
// Listen for updates from background
// =============================================================================

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.lastResult) {
    const newResult = changes.lastResult.newValue;
    if (newResult) {
      state.isComposing = false;
      if (newResult.success === false) {
        showError(newResult.error || 'Composition failed');
      } else {
        showResults(newResult);
      }
    }
  }
  if (area === 'local' && changes.debugHistory) {
    const newHistory = changes.debugHistory.newValue;
    if (newHistory) {
      state.debugHistory = newHistory;
      if (currentView === 'debug') renderDebugHistory();
    }
  }
});

// Listen for auth expiration from background
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'AUTH_EXPIRED') {
    state.user = null;
    showSection('auth');
  }
});

// =============================================================================
// Initialization
// =============================================================================

function initMainSection() {
  elements.userDisplayName.textContent = state.user.name || state.user.email;
  elements.userIdDisplay.textContent = state.user.user_id || '';
  showSection('main');
  showView('home');
  hideAllMainContent();
  checkConnection();
  // Show cached tier immediately, then fetch live balance
  updateCreditStatus(state.credit_tier);
  fetchCreditStatus();
}

async function checkConnection() {
  const dot = document.getElementById('connection-status');
  if (!dot) return;
  try {
    const healthResult = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'health-check' }, (resp) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(resp);
      });
    });

    if (!healthResult || !healthResult.success) {
      dot.classList.add('disconnected');
      dot.classList.remove('connected');
      dot.title = 'Server offline';
      return;
    }

    const { sessionToken } = await chrome.storage.local.get(['sessionToken']);
    if (!sessionToken) {
      dot.classList.add('disconnected');
      dot.classList.remove('connected');
      dot.title = 'Not signed in';
      return;
    }

    if (!state.user?.user_id) {
      dot.classList.add('disconnected');
      dot.classList.remove('connected');
      dot.title = 'Not signed in';
      return;
    }

    const statsResp = await fetch(`${state.serverUrl}/stats/${encodeURIComponent(state.user.user_id)}`, {
      headers: { 'Authorization': `Bearer ${sessionToken}` }
    });

    if (statsResp.status === 401) {
      dot.classList.add('disconnected');
      dot.classList.remove('connected');
      dot.title = 'Session expired';
      state.user = null;
      await chrome.storage.local.remove(['sessionToken']);
      showSection('auth');
      return;
    }

    dot.classList.add('connected');
    dot.classList.remove('disconnected');
    dot.title = 'Connected';
  } catch (e) {
    dot.classList.add('disconnected');
    dot.classList.remove('connected');
    dot.title = 'Server unreachable';
  }
}

async function init() {
  await loadState();

  if (state.user) {
    initMainSection();
    // Handle query param navigation (?view=settings or ?view=debug)
    const params = new URLSearchParams(window.location.search);
    const requestedView = params.get('view');
    if (requestedView === 'settings') {
      populateSettingsFields();
      showView('settings');
    } else if (requestedView === 'debug') {
      populateDebugInfo();
      showView('debug');
    }
  } else {
    showSection('auth');
  }
}

init();
