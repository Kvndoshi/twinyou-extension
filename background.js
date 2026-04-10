/**
 * Compose Assistant - Background Service Worker
 *
 * Handles:
 * - Extension installation
 * - Message routing
 * - Core compose workflow (capture -> API -> insert)
 * - Keyboard shortcut handling
 */

// Server URL — replace at build time for production deployments
// e.g., sed -i 's|http://localhost:8080|https://api.yoursite.com|' background.js
// WARNING: Production MUST use https:// — BYOK API keys are sent in request bodies
const DEFAULT_SERVER_URL = 'https://twinyou-453133317856.us-central1.run.app';

// Runtime safety check: warn if BYOK is used over insecure connection
function _checkTransportSecurity(serverUrl, byok) {
  if (byok && byok.apiKey && serverUrl.startsWith('http://') && !serverUrl.includes('localhost') && !serverUrl.includes('127.0.0.1')) {
    console.warn('[SECURITY] BYOK API key is being sent over HTTP (not HTTPS). This is insecure in production.');
  }
}

// =============================================================================
// State
// =============================================================================

const activeComposes = new Map(); // composeId -> { tabId, url, timestamp, requestId }
const MAX_CONCURRENT_COMPOSES = 3;
let lastComposeTabId = null;
const lastComposeByUrl = new Map(); // url -> { requestId, timestamp } for rewrite tracking

// =============================================================================
// Installation
// =============================================================================

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    // Extension installed

    // BYOK stored in local storage only (API keys should not sync across devices)
    chrome.storage.local.set({
      byok: {
        provider: '',
        apiKey: '',
        model: '',
        baseUrl: ''
      }
    });
  }

  // Create context menu items (on all installs/updates)
  chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: 'compose-settings',
    title: 'Compose Assistant Settings',
    contexts: ['action']
  });
  chrome.contextMenus.create({
    id: 'compose-chat',
    title: 'Open Chat Panel',
    contexts: ['action']
  });
});

// Extension icon left-click → trigger compose on the active tab
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  try {
    await runComposeWorkflow(tab.id);
  } catch (e) {
    console.error('[ACTION] Compose failed:', e);
  }
});

// Handle context menu click
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'compose-settings') {
    // Temporarily set popup so openPopup() shows it below the extension icon
    await chrome.action.setPopup({ popup: 'popup.html' });
    try {
      await chrome.action.openPopup();
    } catch (e) {
      console.warn('[SETTINGS] openPopup failed:', e.message);
    }
    // Clear popup so next left-click triggers action.onClicked (compose)
    setTimeout(() => chrome.action.setPopup({ popup: '' }), 500);
  }
  if (info.menuItemId === 'compose-chat' && tab) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_CHAT' });
    } catch (e) {
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['text_writer.js', 'content.js'] });
        await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content.css'] });
        await new Promise(r => setTimeout(r, 300));
        await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_CHAT' });
      } catch (e2) {
        console.error('Failed to open chat from context menu:', e2);
      }
    }
  }
});

// =============================================================================
// Google OAuth (cross-browser: Chrome + Edge + Firefox)
// =============================================================================

// Read client_id from manifest.json oauth2 config
const OAUTH_CLIENT_ID = chrome.runtime.getManifest().oauth2?.client_id || '';
const OAUTH_SCOPES = (chrome.runtime.getManifest().oauth2?.scopes || []).join(' ');

/**
 * Try Chrome-native getAuthToken first; fall back to launchWebAuthFlow
 * for Edge and other Chromium browsers that don't support getAuthToken.
 */
async function googleSignIn() {
  let token;

  // Strategy 1: chrome.identity.getAuthToken (Chrome only)
  if (typeof chrome.identity.getAuthToken === 'function') {
    try {
      const rawResult = await new Promise((resolve, reject) => {
        chrome.identity.getAuthToken({ interactive: true }, (result) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(result);
          }
        });
      });
      // Chrome 127+ returns { token: string }, older versions return a raw string
      token = typeof rawResult === 'string' ? rawResult : rawResult.token;
    } catch (e) {
      console.warn('[AUTH] getAuthToken failed, falling back to launchWebAuthFlow:', e.message);
      // Fall through to Strategy 2
    }
  }

  // Strategy 2: launchWebAuthFlow (Edge, Firefox, fallback)
  if (!token) {
    token = await googleSignInViaWebAuth();
  }

  const resp = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!resp.ok) {
    throw new Error(`Google userinfo failed: ${resp.status}`);
  }
  const profile = await resp.json();
  return { token, profile };
}

/**
 * OAuth via launchWebAuthFlow — works on Edge, Firefox, and any Chromium browser.
 * Uses the implicit grant flow with the extension's redirect URL.
 */
async function googleSignInViaWebAuth() {
  const redirectUrl = chrome.identity.getRedirectURL();
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', OAUTH_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUrl);
  authUrl.searchParams.set('response_type', 'token');
  authUrl.searchParams.set('scope', OAUTH_SCOPES);
  authUrl.searchParams.set('prompt', 'select_account');

  const responseUrl = await new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(
      { url: authUrl.toString(), interactive: true },
      (callbackUrl) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(callbackUrl);
        }
      }
    );
  });

  // Extract access_token from the redirect URL fragment
  const hashParams = new URLSearchParams(new URL(responseUrl).hash.substring(1));
  const accessToken = hashParams.get('access_token');
  if (!accessToken) {
    throw new Error('No access token in OAuth response');
  }
  return accessToken;
}

// =============================================================================
// API Calls
// =============================================================================

async function getSettings() {
  const syncData = await chrome.storage.sync.get(['user']);
  const localData = await chrome.storage.local.get(['sessionToken', 'byok', 'preferredModel']);

  // Migrate BYOK from sync → local (one-time, for existing installs)
  if (!localData.byok) {
    const oldSync = await chrome.storage.sync.get(['byok']);
    if (oldSync.byok && oldSync.byok.provider) {
      await chrome.storage.local.set({ byok: oldSync.byok });
      await chrome.storage.sync.remove('byok');
      localData.byok = oldSync.byok;
    }
  }

  // Always use hardcoded server URL (never read stale value from storage)
  syncData.serverUrl = DEFAULT_SERVER_URL;
  syncData.sessionToken = localData.sessionToken || null;
  syncData.byok = localData.byok || null;
  syncData.preferredModel = localData.preferredModel || '';
  return syncData;
}

async function apiCall(serverUrl, endpoint, method = 'GET', body = null, timeoutMs = 120000) {
  const url = `${serverUrl}${endpoint}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // Get session token for Authorization header
  const { sessionToken } = await chrome.storage.local.get(['sessionToken']);

  const options = {
    method,
    headers: { 'Content-Type': 'application/json' },
    signal: controller.signal
  };
  if (sessionToken) {
    options.headers['Authorization'] = `Bearer ${sessionToken}`;
  }
  if (body) options.body = JSON.stringify(body);

  try {
    const response = await fetch(url, options);
    clearTimeout(timer);

    // Sliding window: store refreshed token so session stays alive
    // as long as the user is active (expires after 15 days of inactivity).
    const refreshedToken = response.headers.get('X-Refreshed-Token');
    if (refreshedToken) {
      await chrome.storage.local.set({ sessionToken: refreshedToken });
    }

    // Handle 401 — session expired, clear auth state
    if (response.status === 401) {
      console.warn(`[AUTH] 401 on ${endpoint} — session expired, clearing auth`);
      await chrome.storage.local.remove(['sessionToken']);
      await chrome.storage.sync.remove(['user']);
      // Notify any open popups
      chrome.runtime.sendMessage({ type: 'AUTH_EXPIRED' }).catch(() => {});
      return { success: false, error: 'Session expired. Please sign in again.' };
    }

    // Check for other HTTP errors
    if (!response.ok) {
      const status = response.status;
      if (status === 429) throw new Error('Too many requests. Please wait a moment and try again.');
      if (status === 503) throw new Error('Server is temporarily unavailable. Please try again later.');
      if (status >= 500) throw new Error('Server error. Please try again later.');
      const text = await response.text().catch(() => '');
      throw new Error(`Request failed (${status}): ${text.substring(0, 100)}`);
    }

    return response.json();
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new Error(`Request to ${endpoint} timed out after ${timeoutMs / 1000}s`);
    }
    throw err;
  }
}

async function compose(serverUrl, user, byok, containerHtml, draftText, url, pageContext, cursorCluster, focusedFieldContext, composeId) {
  const body = {
    user_id: user.user_id,
    user_name: user.name || '',
    url: url,
    container_html: containerHtml,
    page_context: pageContext,
    draft_text: draftText,
    compose_id: composeId || null,
    client_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
  };

  if (cursorCluster) {
    body.cursor_cluster = cursorCluster;
  }

  if (focusedFieldContext) {
    body.focused_field_context = focusedFieldContext;
  }

  if (byok && byok.provider && byok.apiKey) {
    _checkTransportSecurity(serverUrl, byok);
    body.byok = {
      provider: byok.provider,
      api_key: byok.apiKey,
      model: byok.model || '',
      base_url: byok.baseUrl || ''
    };
  }

  return apiCall(serverUrl, '/compose', 'POST', body);
}

async function logSubmission(serverUrl, userId, requestId, submittedText) {
  return apiCall(serverUrl, '/submission', 'POST', {
    user_id: userId,
    request_id: requestId,
    submitted_text: submittedText
  });
}

async function confirmDraft(serverUrl, userId, result, url, originalDraft, tabId, composeId) {
  /**
   * Confirm that a draft was successfully inserted into the browser.
   * This triggers KG ingestion to store the interaction to Supermemory.
   *
   * Called AFTER the draft is inserted - ensures we only store completed interactions.
   */
  // Track rewrites: if same URL within 60s, mark as replacement
  let replacesRequestId = null;
  const lastForUrl = lastComposeByUrl.get(url);
  if (lastForUrl && (Date.now() - lastForUrl.timestamp) < 60000 && lastForUrl.requestId) {
    replacesRequestId = lastForUrl.requestId;
  }

  // Update tracking
  lastComposeByUrl.set(url, { requestId: result.request_id, timestamp: Date.now() });

  // Prune old entries
  if (lastComposeByUrl.size > 20) {
    const oldest = [...lastComposeByUrl.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
    for (let i = 0; i < lastComposeByUrl.size - 20; i++) lastComposeByUrl.delete(oldest[i][0]);
  }

  // Get user_name from auth state
  const settings = await getSettings();
  const userName = settings.user?.name || '';

  const confirmData = {
    user_id: userId,
    request_id: result.request_id,
    url: url,
    platform: result.platform || '',
    recipient_info: result.recipient_info || null,
    user_intent: result.user_intent || '',
    context_summary: result.context_summary || '',
    message_history: result.message_history || '',
    draft_text: originalDraft || '',
    improved_draft: result.draft || '',
    replaces_request_id: replacesRequestId,
    compose_id: composeId || null,
    user_name: userName,
    user_facts: result.user_facts || [],
    contact_facts: result.contact_facts || [],
    relationship_type: result.relationship_type || '',
    interaction_summary: result.interaction_summary || '',
  };

  // Store to recent memory cache for immediate availability in chat
  addToRecentMemory({
    type: 'compose',
    recipient_info: confirmData.recipient_info,
    user_intent: confirmData.user_intent,
    context_summary: confirmData.context_summary,
    message_history: confirmData.message_history,
    draft_text: confirmData.draft_text,
    improved_draft: confirmData.improved_draft,
    platform: confirmData.platform,
    url: confirmData.url
  });

  const response = await apiCall(serverUrl, '/confirm-draft', 'POST', confirmData);

  // Persona fact confirmation disabled — Supermemory filter handles indexing rules
  // if (response && response.pending_persona_facts && response.pending_persona_facts.length > 0 && tabId) {
  //   ...
  // }

  return response;
}

// =============================================================================
// Recent Memory Cache (bridges Supermemory indexing lag)
// =============================================================================

async function addToRecentMemory(entry) {
  try {
    const data = await chrome.storage.local.get(['recentMemory']);
    let recentMemory = data.recentMemory || [];

    // Auto-prune entries older than 2 minutes
    const twoMinAgo = Date.now() - 120000;
    recentMemory = recentMemory.filter(e => e._timestamp > twoMinAgo);

    // Add new entry with timestamp
    recentMemory.push({ ...entry, _timestamp: Date.now() });

    // Cap at 20 entries
    if (recentMemory.length > 20) {
      recentMemory = recentMemory.slice(-20);
    }

    await chrome.storage.local.set({ recentMemory });
  } catch (e) {
    console.warn('[RecentMemory] Failed to store:', e.message);
  }
}

// =============================================================================
// Core Compose Workflow
// =============================================================================

async function runComposeWorkflow(tabId) {
  lastComposeTabId = tabId;

  try {
    const settings = await getSettings();
    const serverUrl = settings.serverUrl || DEFAULT_SERVER_URL;
    const user = settings.user;
    const byok = settings.byok;

    if (!user || !user.user_id) {
      // User not authenticated — compose requires sign-in
      return;
    }

    const tab = await chrome.tabs.get(tabId);

    // Delegate entire compose workflow to content script.
    // Content script makes the API call directly — avoids Chrome MV3
    // service worker termination during long (30-45s) API calls.
    // Get session token for content script API calls
    const { sessionToken: composeToken } = await chrome.storage.local.get(['sessionToken']);

    // Delegate to content script
    await chrome.tabs.sendMessage(tabId, {
      type: 'RUN_COMPOSE',
      serverUrl,
      user: { user_id: user.user_id, name: user.name || '' },
      byok: (byok && byok.provider && byok.apiKey) ? {
        provider: byok.provider,
        api_key: byok.apiKey,
        model: byok.model || '',
        base_url: byok.baseUrl || ''
      } : null,
      preferredModel: settings.preferredModel || '',
      tabUrl: tab.url,
      sessionToken: composeToken || null
    });
  } catch (error) {
    console.error('[COMPOSE] Failed to start:', error);
    await sendToast(tabId, 'error', { message: error.message || 'Something went wrong' });
  }
}

async function sendToast(tabId, state, data = {}) {
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'SHOW_TOAST',
      state: state,
      data: data
    });
  } catch (error) {
    console.error('Failed to send toast:', error);
  }
}

function attachDebugger(debuggee, version = '1.3') {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(debuggee, version, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

function sendDebuggerCommand(debuggee, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(debuggee, method, params, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result);
    });
  });
}

function detachDebugger(debuggee) {
  return new Promise((resolve) => {
    chrome.debugger.detach(debuggee, () => resolve());
  });
}

/**
 * Pastes from system clipboard into the editor.
 * Uses Ctrl+A to select all then Ctrl+V to paste — editors like
 * Google Docs and Word Online handle these via their own internal models.
 * The caller must write to clipboard BEFORE calling this.
 */
async function trustedPasteReplace(tabId, selectAll, point) {
  const debuggee = { tabId };
  let attached = false;

  try {
    await attachDebugger(debuggee);
    attached = true;
  } catch (error) {
    return { success: false, error: error.message };
  }

  try {
    try {
      await sendDebuggerCommand(debuggee, 'Page.bringToFront');
    } catch (error) { /* non-critical */ }

    // Click to focus the editor area ONLY when doing selectAll.
    // For replaceSelection, we must NOT click — it would destroy the user's selection.
    if (selectAll && point && Number.isFinite(point.x) && Number.isFinite(point.y) && point.x > 0 && point.y > 0) {
      await sendDebuggerCommand(debuggee, 'Input.dispatchMouseEvent', {
        type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1,
      });
      await sendDebuggerCommand(debuggee, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1,
      });
      await wait(150);
    }

    if (selectAll) {
      // Ctrl+A — let the editor handle selectAll via its own event listeners
      await sendDebuggerCommand(debuggee, 'Input.dispatchKeyEvent', {
        type: 'rawKeyDown', code: 'ControlLeft', key: 'Control',
        windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: 2,
      });
      await sendDebuggerCommand(debuggee, 'Input.dispatchKeyEvent', {
        type: 'rawKeyDown', code: 'KeyA', key: 'a',
        windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2,
      });
      await sendDebuggerCommand(debuggee, 'Input.dispatchKeyEvent', {
        type: 'keyUp', code: 'KeyA', key: 'a',
        windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2,
      });
      await sendDebuggerCommand(debuggee, 'Input.dispatchKeyEvent', {
        type: 'keyUp', code: 'ControlLeft', key: 'Control',
        windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17,
      });
      await wait(100);
    }

    // Ctrl+V — editor reads from real system clipboard
    await sendDebuggerCommand(debuggee, 'Input.dispatchKeyEvent', {
      type: 'rawKeyDown', code: 'ControlLeft', key: 'Control',
      windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: 2,
    });
    await sendDebuggerCommand(debuggee, 'Input.dispatchKeyEvent', {
      type: 'rawKeyDown', code: 'KeyV', key: 'v',
      windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86, modifiers: 2,
    });
    await sendDebuggerCommand(debuggee, 'Input.dispatchKeyEvent', {
      type: 'keyUp', code: 'KeyV', key: 'v',
      windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86, modifiers: 2,
    });
    await sendDebuggerCommand(debuggee, 'Input.dispatchKeyEvent', {
      type: 'keyUp', code: 'ControlLeft', key: 'Control',
      windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17,
    });
    await wait(100);

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message || 'Trusted paste failed' };
  } finally {
    if (attached) await detachDebugger(debuggee);
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function captureTrustedReplaceState(debuggee, point, label) {
  const x = Number.isFinite(point?.x) ? point.x : null;
  const y = Number.isFinite(point?.y) ? point.y : null;
  const expression = `(() => {
    const limit = (value, max = 220) => {
      const text = String(value ?? '');
      return text.length > max ? text.slice(0, max) + '...' : text;
    };
    const describe = (node) => {
      if (!node) return null;
      const rawText = 'value' in node ? node.value : (node.textContent || '');
      return {
        tag: node.tagName || node.nodeName || '',
        role: node.getAttribute?.('role') || '',
        contenteditable: node.getAttribute?.('contenteditable') || '',
        dataSlateEditor: node.getAttribute?.('data-slate-editor') || '',
        text: limit(rawText, 220),
      };
    };
    const x = ${x == null ? 'null' : JSON.stringify(x)};
    const y = ${y == null ? 'null' : JSON.stringify(y)};
    const pointNode = x == null || y == null ? null : document.elementFromPoint(x, y);
    const pointTarget = pointNode?.closest?.('[contenteditable="true"], textarea, input, [role="textbox"]') || pointNode;
    const selection = window.getSelection ? window.getSelection() : null;
    return {
      label: ${JSON.stringify(label)},
      active: describe(document.activeElement),
      pointTarget: describe(pointTarget),
      selectionText: limit(selection?.toString?.() || '', 220),
      selectionCollapsed: selection ? !!selection.isCollapsed : null,
      anchorNodeName: selection?.anchorNode?.nodeName || '',
      focusNodeName: selection?.focusNode?.nodeName || '',
    };
  })()`;

  try {
    const result = await sendDebuggerCommand(debuggee, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return result?.result?.value || { label, error: 'No debug value returned' };
  } catch (error) {
    return { label, error: error.message || 'Failed to capture trusted replace state' };
  }
}

async function focusTrustedReplaceTarget(debuggee, point) {
  const x = Number.isFinite(point?.x) ? point.x : null;
  const y = Number.isFinite(point?.y) ? point.y : null;
  const expression = `(() => {
    const x = ${x == null ? 'null' : JSON.stringify(x)};
    const y = ${y == null ? 'null' : JSON.stringify(y)};
    const pointNode = x == null || y == null ? null : document.elementFromPoint(x, y);
    const target = pointNode?.closest?.('[contenteditable="true"], textarea, input, [role="textbox"]') || pointNode || document.activeElement;
    if (target && typeof target.focus === 'function') {
      target.focus({ preventScroll: true });
    }
    return {
      focused: !!target,
      tag: target?.tagName || target?.nodeName || '',
      role: target?.getAttribute?.('role') || '',
      contenteditable: target?.getAttribute?.('contenteditable') || '',
      dataSlateEditor: target?.getAttribute?.('data-slate-editor') || '',
    };
  })()`;

  try {
    const result = await sendDebuggerCommand(debuggee, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return result?.result?.value || { focused: false };
  } catch (error) {
    return { focused: false, error: error.message || 'Failed to focus trusted replace target' };
  }
}

function hasTrustedSelection(state) {
  if (!state || state.error) return false;
  if (state.selectionCollapsed === false) return true;
  return !!String(state.selectionText || '').trim();
}

async function trustedInsertText(tabId, text) {
  const debuggee = { tabId };
  let attached = false;

  try {
    await attachDebugger(debuggee);
    attached = true;
  } catch (error) {
    throw error;
  }

  try {
    try {
      await sendDebuggerCommand(debuggee, 'Page.bringToFront');
    } catch (error) {
      console.warn('[TRUSTED_INSERT] bringToFront failed:', error.message);
    }

    await sendDebuggerCommand(debuggee, 'Input.insertText', { text });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message || 'Trusted insertion failed' };
  } finally {
    if (attached) {
      await detachDebugger(debuggee);
    }
  }
}

async function trustedReplaceText(tabId, text, point) {
  const debuggee = { tabId };
  let attached = false;

  try {
    await attachDebugger(debuggee);
    attached = true;
  } catch (error) {
    throw error;
  }

  try {
    try {
      await sendDebuggerCommand(debuggee, 'Page.bringToFront');
    } catch (error) {
      // Non-critical — page may already be in front
    }

    await focusTrustedReplaceTarget(debuggee, point);

    if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
      await sendDebuggerCommand(debuggee, 'Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: point.x,
        y: point.y,
        button: 'left',
        clickCount: 1,
      });
      await sendDebuggerCommand(debuggee, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: point.x,
        y: point.y,
        button: 'left',
        clickCount: 1,
      });
      await wait(40);
    }

    await sendDebuggerCommand(debuggee, 'Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      code: 'ControlLeft',
      key: 'Control',
      windowsVirtualKeyCode: 17,
      nativeVirtualKeyCode: 17,
      modifiers: 2,
    });
    await sendDebuggerCommand(debuggee, 'Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      code: 'KeyA',
      key: 'a',
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
      modifiers: 2,
      commands: ['selectAll'],
    });
    await sendDebuggerCommand(debuggee, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      code: 'KeyA',
      key: 'a',
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
      modifiers: 2,
    });
    await sendDebuggerCommand(debuggee, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      code: 'ControlLeft',
      key: 'Control',
      windowsVirtualKeyCode: 17,
      nativeVirtualKeyCode: 17,
    });
    await sendDebuggerCommand(debuggee, 'Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      commands: ['selectAll'],
    });
    await sendDebuggerCommand(debuggee, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
    });
    await wait(40);

    const selectionState = await captureTrustedReplaceState(debuggee, point, 'after-select-all');
    if (!hasTrustedSelection(selectionState)) {
      await focusTrustedReplaceTarget(debuggee, point);
      await wait(20);
      await sendDebuggerCommand(debuggee, 'Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        commands: ['selectAll'],
      });
      await sendDebuggerCommand(debuggee, 'Input.dispatchKeyEvent', {
        type: 'keyUp',
      });
      await wait(40);
    }

    await sendDebuggerCommand(debuggee, 'Input.insertText', { text });
    await wait(40);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message || 'Trusted replace failed' };
  } finally {
    if (attached) {
      await detachDebugger(debuggee);
    }
  }
}

// =============================================================================
// Message Handling
// =============================================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Post-processing after content script completes compose workflow
  if (message.type === 'COMPOSE_COMPLETE') {
    (async () => {
      try {
        const settings = await getSettings();
        const serverUrl = settings.serverUrl || DEFAULT_SERVER_URL;
        const userId = settings.user?.user_id;
        const result = message.result;
        const tabId = sender.tab?.id;

        if (!userId || !result) {
          sendResponse({ success: false });
          return;
        }

        // Compose complete — process result

        // Store last result for debug popup
        const resultObj = {
          ...result,
          timestamp: Date.now(),
          tabId,
          url: message.url
        };
        await chrome.storage.local.set({ lastResult: resultObj });

        // Maintain debug history (last 5 requests)
        const stored = await chrome.storage.local.get(['debugHistory']);
        const history = stored.debugHistory || [];
        history.unshift({ ...resultObj, id: Date.now() + '-' + Math.random().toString(36).substr(2,5) });
        if (history.length > 5) history.length = 5;
        await chrome.storage.local.set({ debugHistory: history });

        // Store to recent memory cache
        addToRecentMemory({
          type: 'compose',
          recipient_info: result.recipient_info || null,
          user_intent: result.user_intent || '',
          context_summary: result.context_summary || '',
          message_history: result.message_history || '',
          draft_text: message.draftText || '',
          improved_draft: result.draft || '',
          platform: result.platform || '',
          url: message.url
        });

        // Log submission
        logSubmission(serverUrl, userId, result.request_id, result.draft).catch(console.error);

        // Confirm draft (KG ingestion)
        confirmDraft(serverUrl, userId, result, message.url, message.draftText, tabId, message.composeId)
          .then(kgResult => {
            if (!kgResult?.success) console.warn('[KG] Failed:', kgResult?.error);
          })
          .catch(err => console.warn('[KG] Error:', err.message));

        sendResponse({ success: true });
      } catch (e) {
        console.error('[COMPOSE_COMPLETE] Error:', e.message);
        sendResponse({ success: false });
      }
    })();
    return true;
  }

  if (message.type === 'health-check') {
    (async () => {
      try {
        const response = await fetch(`${DEFAULT_SERVER_URL}/health`);
        const result = await response.json();
        sendResponse({ success: true, ...result });
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
    })();

    return true;
  }

  if (message.type === 'get-settings') {
    (async () => {
      const data = await getSettings();
      sendResponse(data);
    })();
    return true;
  }

  if (message.type === 'get-last-result') {
    chrome.storage.local.get(['lastResult'], (data) => {
      sendResponse(data.lastResult || null);
    });

    return true;
  }

  if (message.type === 'RETRY_COMPOSE') {
    (async () => {
      if (lastComposeTabId) {
        await runComposeWorkflow(lastComposeTabId);
      }
      sendResponse({ success: true });
    })();
    return true;
  }

  if (message.type === 'TRIGGER_COMPOSE') {
    (async () => {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]) {
        await runComposeWorkflow(tabs[0].id);
      }
      sendResponse({ success: true });
    })();
    return true;
  }

  if (message.type === 'INSERT_LAST_DRAFT') {
    chrome.storage.local.get(['lastResult'], async (data) => {
      if (data.lastResult && data.lastResult.draft) {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab) {
          const result = await chrome.tabs.sendMessage(tab.id, {
            type: 'INSERT_DRAFT',
            draft: data.lastResult.draft,
            selector: null
          });
          sendResponse(result);
        } else {
          sendResponse({ success: false, error: 'No active tab' });
        }
      } else {
        sendResponse({ success: false, error: 'No draft available' });
      }
    });
    return true;
  }

  if (message.type === 'TRUSTED_INSERT_TEXT') {
    (async () => {
      try {
        if (!sender.tab?.id) {
          sendResponse({ success: false, error: 'No active tab for trusted insertion' });
          return;
        }
        const result = await trustedInsertText(sender.tab.id, message.text || '');
        sendResponse(result);
      } catch (error) {
        sendResponse({ success: false, error: error.message || 'Trusted insertion failed' });
      }
    })();
    return true;
  }

  if (message.type === 'TRUSTED_REPLACE_TEXT') {
    (async () => {
      try {
        if (!sender.tab?.id) {
          sendResponse({ success: false, error: 'No active tab for trusted replace' });
          return;
        }
        const result = await trustedReplaceText(sender.tab.id, message.text || '', {
          x: Number(message.x),
          y: Number(message.y),
        });
        sendResponse(result);
      } catch (error) {
        sendResponse({ success: false, error: error.message || 'Trusted replace failed' });
      }
    })();
    return true;
  }

  if (message.type === 'TRUSTED_CLICK') {
    (async () => {
      try {
        if (!sender.tab?.id) {
          sendResponse({ success: false, error: 'No active tab' });
          return;
        }
        const x = Number(message.x);
        const y = Number(message.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          sendResponse({ success: false, error: 'Invalid coordinates' });
          return;
        }
        const debuggee = { tabId: sender.tab.id };
        let attached = false;
        try {
          await attachDebugger(debuggee);
          attached = true;
          await sendDebuggerCommand(debuggee, 'Input.dispatchMouseEvent', {
            type: 'mousePressed', x, y, button: 'left', clickCount: 1,
          });
          await sendDebuggerCommand(debuggee, 'Input.dispatchMouseEvent', {
            type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
          });
          sendResponse({ success: true });
        } catch (error) {
          sendResponse({ success: false, error: error.message });
        } finally {
          if (attached) await detachDebugger(debuggee);
        }
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true;
  }

  if (message.type === 'TRUSTED_PASTE_REPLACE') {
    (async () => {
      try {
        if (!sender.tab?.id) {
          sendResponse({ success: false, error: 'No active tab' });
          return;
        }
        const result = await trustedPasteReplace(sender.tab.id, !!message.selectAll, {
          x: Number(message.x),
          y: Number(message.y),
        });
        sendResponse(result);
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true;
  }

  if (message.type === 'EXECUTE_SELECTION_REWRITE') {
    handleSelectionRewrite(sender.tab.id, message.data);
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'CHAT_MESSAGE') {
    handleChatMessage(sender.tab?.id, message.data)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'CAPTURE_PROFILE') {
    handleCaptureProfile(sender.tab?.id)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'SEND_FEEDBACK') {
    (async () => {
      try {
        const settings = await getSettings();
        const serverUrl = settings.serverUrl || DEFAULT_SERVER_URL;
        if (!settings.user || !settings.user.user_id) {
          sendResponse({ success: false, error: 'Not authenticated' });
          return;
        }
        const fbHeaders = { 'Content-Type': 'application/json' };
        if (settings.sessionToken) fbHeaders['Authorization'] = `Bearer ${settings.sessionToken}`;
        const resp = await fetch(`${serverUrl}/feedback`, {
          method: 'POST',
          headers: fbHeaders,
          body: JSON.stringify({
            user_id: settings.user.user_id,
            category: message.data.category || 'general',
            message: message.data.message || '',
            url: message.data.url || '',
            page_title: message.data.page_title || '',
            extension_version: chrome.runtime.getManifest().version || '',
          })
        });
        if (!resp.ok) {
          sendResponse({ success: false, error: `Server error (${resp.status})` });
          return;
        }
        sendResponse(await resp.json());
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  if (message.type === 'GOOGLE_SIGN_IN') {
    googleSignIn()
      .then(result => sendResponse({ success: true, ...result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'GOOGLE_SIGN_OUT') {
    // Revoke cached token so a fresh account-picker appears on next sign-in
    (async () => {
      try {
        // Try Chrome-specific token revocation
        if (typeof chrome.identity.getAuthToken === 'function') {
          try {
            const rawToken = await new Promise((resolve) => {
              chrome.identity.getAuthToken({ interactive: false }, (t) => resolve(t));
            });
            const token = rawToken && (typeof rawToken === 'string' ? rawToken : rawToken.token);
            if (token) {
              await new Promise((resolve) => {
                chrome.identity.removeCachedAuthToken({ token }, resolve);
              });
              await fetch(`https://accounts.google.com/o/oauth2/revoke?token=${token}`).catch(() => {});
            }
          } catch (e) {
            // getAuthToken not available (Edge) — that's fine
          }
        }
        // Clear extension auth state
        await chrome.storage.local.remove(['sessionToken']);
        sendResponse({ success: true });
      } catch (e) {
        sendResponse({ success: true }); // Non-critical — still sign out locally
      }
    })();
    return true;
  }

});

// =============================================================================
// Chat Message Handler
// =============================================================================

async function handleChatMessage(tabId, data) {
  const settings = await getSettings();
  const serverUrl = settings.serverUrl || DEFAULT_SERVER_URL;
  const byok = settings.byok;

  if (!settings.user || !settings.user.user_id) {
    return { success: false, error: 'Not authenticated. Please log in first.' };
  }

  try {
    const body = {
      user_id: settings.user.user_id,
      user_name: settings.user.name || '',
      message: data.message,
      conversation_history: data.conversationHistory || [],
      mode: data.mode || 'chat',
      client_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
    };

    // Relay file upload if present
    if (data.fileUpload) {
      body.file_upload = data.fileUpload;
    }

    // Pass BYOK to chat endpoint
    if (byok && byok.provider && byok.apiKey) {
      _checkTransportSecurity(serverUrl, byok);
      body.byok = {
        provider: byok.provider,
        api_key: byok.apiKey,
        model: byok.model || '',
        base_url: byok.baseUrl || ''
      };
    }

    // Pass preferred model for paid tier users
    if (settings.preferredModel) {
      body.preferred_model = settings.preferredModel;
    }

    // Always include page_url if available (from content script or tab)
    if (data.currentUrl) {
      body.page_url = data.currentUrl;
    }

    // If "with_page" mode, capture page context
    if (data.mode === 'with_page' && tabId) {
      try {
        const tab = await chrome.tabs.get(tabId);
        const context = await chrome.tabs.sendMessage(tabId, { type: 'CAPTURE_CONTEXT' });
        if (context && context.isPdf) {
          // PDF page — DOM is empty, pass URL for server-side extraction
          body.is_pdf = true;
          body.page_url = tab.url;
          body.page_context = context.pageContext || '';
        } else if (context && context.pageContext) {
          body.page_context = context.pageContext;
          body.page_url = tab.url;
        }
      } catch (e) {
        console.warn('Failed to capture page context for chat:', e.message);
      }
    }

    // If "agent" mode, capture page fields with rich context
    if (data.mode === 'agent' && tabId) {
      try {
        const tab = await chrome.tabs.get(tabId);
        const fieldData = await chrome.tabs.sendMessage(tabId, { type: 'CAPTURE_PAGE_FIELDS' });
        if (fieldData && fieldData.fields && fieldData.fields.length > 0) {
          body.page_fields = fieldData.fields;
          body.body_text = fieldData.bodyText || '';
          body.page_context = fieldData.bodyText || '';
          body.page_url = tab.url;
        }
      } catch (e) {
        console.warn('Failed to capture page fields for agent mode:', e.message);
      }
    }

    // Enrich with recent context from lastResult and recentMemory
    try {
      const stored = await chrome.storage.local.get(['lastResult', 'recentMemory']);

      // Last compose result as recent_context
      if (stored.lastResult) {
        body.recent_context = {
          user_intent: stored.lastResult.user_intent || '',
          draft: stored.lastResult.draft || '',
          platform: stored.lastResult.platform || '',
          url: stored.lastResult.url || '',
          timestamp: stored.lastResult.timestamp || 0
        };
      }

      // Recent memory entries (filtered to 2-min window, last 5)
      if (stored.recentMemory && stored.recentMemory.length > 0) {
        const twoMinAgo = Date.now() - 120000;
        const recent = stored.recentMemory
          .filter(e => e._timestamp > twoMinAgo)
          .slice(-5);
        if (recent.length > 0) {
          body.recent_memory = recent;
        }
      }
    } catch (e) {
      // Non-critical, continue without enrichment
    }

    // Include Bearer token for auth
    const chatHeaders = { 'Content-Type': 'application/json' };
    if (settings.sessionToken) {
      chatHeaders['Authorization'] = `Bearer ${settings.sessionToken}`;
    }

    const response = await fetch(`${serverUrl}/chat`, {
      method: 'POST',
      headers: chatHeaders,
      body: JSON.stringify(body)
    });

    // Handle 401
    if (response.status === 401) {
      await chrome.storage.local.remove(['sessionToken']);
      await chrome.storage.sync.remove(['user']);
      return { success: false, error: 'Session expired. Please sign in again.' };
    }

    const result = await response.json();

    // If agent mode returned fill actions, execute them
    if (result.success && result.actions && result.actions.length > 0 && tabId) {
      try {
        for (const action of result.actions) {
          if (action.type === 'fill_fields' && action.fields) {
            const insertResult = await chrome.tabs.sendMessage(tabId, {
              type: 'INSERT_ALL_FIELDS',
              fields: action.fields
            });
            if (insertResult) {
              // Agent filled fields on page
              // Append fill summary to reply
              if (!result.reply) result.reply = '';
              if (insertResult.inserted > 0) {
                result.reply += `\n\n*Filled ${insertResult.inserted} field(s) on the page.*`;
              }
            }
          }
        }
      } catch (e) {
        console.warn('Failed to execute chat agent actions:', e.message);
      }
    }

    // Persona fact confirmation disabled — Supermemory filter handles indexing rules
    // if (result.success && result.pending_persona_facts && ...) { ... }

    return result;
  } catch (error) {
    return { success: false, error: error.message || 'Failed to reach server' };
  }
}

// =============================================================================
// Capture Profile Handler
// =============================================================================

async function handleCaptureProfile(tabId) {
  const settings = await getSettings();
  const serverUrl = settings.serverUrl || DEFAULT_SERVER_URL;

  if (!settings.user || !settings.user.user_id) {
    return { success: false, error: 'Not authenticated' };
  }

  try {
    const tab = await chrome.tabs.get(tabId);
    const context = await chrome.tabs.sendMessage(tabId, { type: 'CAPTURE_CONTEXT' });

    const body = {
      user_id: settings.user.user_id,
      url: tab.url || '',
      page_context: context?.pageContext || '',
      container_html: context?.containerHtml || '',
      is_pdf: context?.isPdf || false
    };

    const captureHeaders = { 'Content-Type': 'application/json' };
    const { sessionToken: capToken } = await chrome.storage.local.get(['sessionToken']);
    if (capToken) captureHeaders['Authorization'] = `Bearer ${capToken}`;

    const response = await fetch(`${serverUrl}/capture-profile`, {
      method: 'POST',
      headers: captureHeaders,
      body: JSON.stringify(body)
    });

    if (response.status === 401) {
      await chrome.storage.local.remove(['sessionToken']);
      return;
    }
    if (!response.ok) {
      console.warn('[CAPTURE_PROFILE] Server error:', response.status);
      return;
    }

    const result = await response.json();

    // Store to recent memory for immediate availability
    if (result.success) {
      addToRecentMemory({
        type: 'profile_capture',
        url: tab.url || '',
        summary: result.summary || '',
        platform: context?.pageContext?.match(/\[Platform\]:\s*(\w+)/)?.[1] || ''
      });
    }

    return result;
  } catch (error) {
    return { success: false, error: error.message || 'Capture failed' };
  }
}

// =============================================================================
// Keyboard Shortcut
// =============================================================================

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'compose') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;

    // Check if user is authenticated
    const settings = await getSettings();
    if (!settings.user || !settings.user.user_id) {
      // Not authenticated — user should click the extension icon to sign in
      return;
    }

    // Check for text selection first (same logic as icon click)
    try {
      const selection = await chrome.tabs.sendMessage(tab.id, { type: 'GET_SELECTION' });
      if (selection && selection.selectedText && selection.selectedText.length > 0) {
        // Selection mode: show popover
        await chrome.tabs.sendMessage(tab.id, {
          type: 'SHOW_SELECTION_PROMPT',
          data: selection
        });
        return;
      }
    } catch (e) {
      // Content script may not be loaded, fall through to compose
    }

    // No selection -- compose mode
    await runComposeWorkflow(tab.id);
  }

  if (command === 'toggle-chat') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;

    // Try sending message, with injection + retry on failure
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_CHAT' });
        return; // Success
      } catch (e) {
        if (attempt === 0) {
          // First failure - inject content script and retry
          try {
            await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              files: ['text_writer.js', 'content.js']
            });
            await chrome.scripting.insertCSS({
              target: { tabId: tab.id },
              files: ['content.css']
            });
            await new Promise(r => setTimeout(r, 300));
          } catch (e2) {
            console.error('Failed to inject content script for chat:', e2);
            return;
          }
        } else {
          console.error('Failed to toggle chat after retry:', e);
        }
      }
    }
  }
});

// Extension icon left-click fires action.onClicked (no default_popup in manifest).
// Compose can also be triggered via popup "Compose" button or Alt+Q shortcut.

// =============================================================================
// Selection Rewrite Workflow
// =============================================================================

async function handleSelectionRewrite(tabId, data) {
  const settings = await getSettings();
  const serverUrl = settings.serverUrl || DEFAULT_SERVER_URL;
  const byok = settings.byok;

  if (!settings.user || !settings.user.user_id) {
    await sendToast(tabId, 'error', { message: 'Please sign in first' });
    return;
  }

  try {
    // Show rewriting toast
    await sendToast(tabId, 'composing', { message: 'Rewriting...' });

    // Get tab URL for platform context
    let tabUrl = '';
    try {
      const tab = await chrome.tabs.get(tabId);
      tabUrl = tab?.url || '';
    } catch (e) { /* ignore */ }

    const selectionBody = {
      user_id: settings.user.user_id,
      user_name: settings.user.name || '',
      full_text: data.fullText,
      selected_text: data.selectedText,
      selection_start: data.start,
      selection_end: data.end,
      user_prompt: data.userPrompt,
      url: tabUrl
    };

    // Pass BYOK to selection endpoint
    if (byok && byok.provider && byok.apiKey) {
      _checkTransportSecurity(serverUrl, byok);
      selectionBody.byok = {
        provider: byok.provider,
        api_key: byok.apiKey,
        model: byok.model || '',
        base_url: byok.baseUrl || ''
      };
    }

    // Pass preferred model for paid tier users
    if (settings.preferredModel) {
      selectionBody.preferred_model = settings.preferredModel;
    }

    const selHeaders = { 'Content-Type': 'application/json' };
    const { sessionToken: selToken } = await chrome.storage.local.get(['sessionToken']);
    if (selToken) selHeaders['Authorization'] = `Bearer ${selToken}`;

    const response = await fetch(`${serverUrl}/selection`, {
      method: 'POST',
      headers: selHeaders,
      body: JSON.stringify(selectionBody)
    });

    if (response.status === 401) {
      await chrome.storage.local.remove(['sessionToken']);
      await sendToast(tabId, 'error', { message: 'Session expired. Please sign in again.' });
      return;
    }
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      await sendToast(tabId, 'error', { message: `Server error (${response.status}): ${errText.substring(0, 80)}` });
      return;
    }

    const result = await response.json();

    if (result.success) {
      // Send rewritten selection back to content.js for insertion
      await chrome.tabs.sendMessage(tabId, {
        type: 'INSERT_SELECTION_RESULT',
        rewrittenSelection: result.rewritten_selection,
        start: data.start,
        end: data.end
      });
      await sendToast(tabId, 'success', { message: 'Done!' });
    } else {
      await sendToast(tabId, 'error', { message: result.error || 'Rewrite failed' });
    }
  } catch (error) {
    console.error('Selection rewrite error:', error);
    await sendToast(tabId, 'error', { message: error.message || 'Something went wrong' });
  }
}
