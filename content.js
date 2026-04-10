/**
 * Compose Assistant - Content Script
 *
 * Injected into all pages to:
 * 1. Show floating toast notifications
 * 2. Capture page context
 * 3. Insert generated drafts
 *
 * Communicates with background.js via chrome.runtime messages
 */

// Debug logging — set to true during development only
const _DEBUG = false;
function _log(...args) { if (_DEBUG) console.log(...args); }
const textWriter = globalThis.ComposeTextWriter || {};

// =============================================================================
// Toast UI
// =============================================================================

const TOAST_ID = 'compose-assistant-toast';
const SELECTION_POPOVER_ID = 'compose-selection-popover';
let hideTimeout = null;
let selectionData = null;

// =============================================================================
// Persistent Selection Storage (survives focus loss from toolbar icon click)
// =============================================================================

let storedSelection = null;
// Preserved across selectionchange/hideSelectionPopover so replaceSelection() can find the target
let pendingSelectionEl = null;
let selectionLocked = false;

document.addEventListener('selectionchange', () => {
  if (selectionLocked) return; // Don't clear during active selection rewrite

  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.toString().trim()) {
    // Selection was cleared — discard stored selection so popup doesn't enter selection mode
    storedSelection = null;
    return;
  }

  // Don't store selections inside our own UI elements
  try {
    const anchorEl = sel.anchorNode?.parentElement;
    if (anchorEl && anchorEl.closest(
      '#compose-assistant-toast, #compose-selection-popover, #compose-assistant-chat, #compose-assistant-chat-host'
    )) return;
  } catch (e) { /* ignore */ }

  try {
    const range = sel.getRangeAt(0).cloneRange();
    const text = sel.toString();

    // Find the editable element that contains this selection
    let editableEl = null;
    let node = sel.anchorNode;
    while (node) {
      if (node.nodeType === 1 && isEditable(node)) {
        editableEl = node;
        break;
      }
      node = node.parentElement;
    }

    // Compute offsets relative to the editable element
    let start = null;
    let end = null;
    if (editableEl && (editableEl.isContentEditable || editableEl.getAttribute('contenteditable') === 'true')) {
      const preRange = document.createRange();
      preRange.selectNodeContents(editableEl);
      preRange.setEnd(range.startContainer, range.startOffset);
      start = preRange.toString().length;
      end = start + text.length;
    } else if (editableEl && (editableEl.tagName === 'TEXTAREA' || editableEl.tagName === 'INPUT')) {
      start = editableEl.selectionStart;
      end = editableEl.selectionEnd;
    }

    // Capture surrounding context for stronger string-search fallback
    const fullText = editableEl ? getElementValue(editableEl) : '';
    let contextBefore = '';
    let contextAfter = '';
    if (start !== null && fullText) {
      contextBefore = fullText.substring(Math.max(0, start - 50), start);
      contextAfter = fullText.substring(end, end + 50);
    }

    storedSelection = {
      text,
      range,
      start,
      end,
      editableEl,
      fullText,
      contextBefore,
      contextAfter,
      timestamp: Date.now()
    };
  } catch (e) {
    // Ignore errors from cross-origin or detached nodes
  }
});

// =============================================================================
// Last Focused Editable Tracking (survives focus loss from clicking extension icon)
// =============================================================================

let lastFocusedEditable = null;
let lastFocusedTimestamp = 0;
let lastCaretInfo = null;
let lastFocusedLocators = [];

// =============================================================================
// Concurrent Compose Tracking
// =============================================================================

const pendingComposes = new Map(); // composeId -> { element, locators, mode, timestamp }
const MAX_CONCURRENT = 3;

function generateComposeId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = 'cmp_';
  for (let i = 0; i < 8; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function cleanupStaleComposes() {
  const now = Date.now();
  for (const [id, entry] of pendingComposes) {
    if (now - entry.timestamp > 60000) pendingComposes.delete(id);
  }
}

/**
 * Build multiple robust selectors for an element (Playwright-style locator strategy).
 * Returns an array of selectors ordered by reliability. At INSERT_DRAFT time,
 * we try each in order until one matches a valid editable element.
 */
function buildRobustLocators(el) {
  if (!el) return [];
  const locators = [];

  // 1. By ID (most reliable if present)
  if (el.id) locators.push({ type: 'id', selector: `#${CSS.escape(el.id)}` });

  // 2. By name attribute (form fields)
  if (el.name) locators.push({ type: 'name', selector: `[name="${CSS.escape(el.name)}"]` });

  // 3. By aria-label
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) locators.push({ type: 'aria', selector: `[aria-label="${CSS.escape(ariaLabel)}"]` });

  // 4. By placeholder
  const placeholder = el.getAttribute('placeholder');
  if (placeholder) locators.push({ type: 'placeholder', selector: `[placeholder="${CSS.escape(placeholder)}"]` });

  // 5. By role + position (for contenteditable divs)
  const role = el.getAttribute('role');
  if (role === 'textbox') {
    const allTextboxes = [...document.querySelectorAll('[role="textbox"]')];
    const idx = allTextboxes.indexOf(el);
    if (idx >= 0) locators.push({ type: 'role-nth', selector: `[role="textbox"]:nth(${idx})`, index: idx });
  }

  // 6. Computed CSS selector path (tag + classes + nth-child up 3 levels)
  const pathParts = [];
  let cur = el;
  for (let i = 0; i < 3 && cur && cur !== document.body; i++) {
    let part = cur.tagName.toLowerCase();
    if (cur.classList.length > 0) {
      part += '.' + [...cur.classList].slice(0, 2).map(c => CSS.escape(c)).join('.');
    }
    if (cur.parentElement) {
      const siblings = [...cur.parentElement.children].filter(c => c.tagName === cur.tagName);
      if (siblings.length > 1) part += `:nth-child(${[...cur.parentElement.children].indexOf(cur) + 1})`;
    }
    pathParts.unshift(part);
    cur = cur.parentElement;
  }
  if (pathParts.length > 0) locators.push({ type: 'path', selector: pathParts.join(' > ') });

  return locators;
}

/**
 * Re-find an element using stored robust locators. Tries each in order.
 */
function resolveLocators(locators) {
  for (const loc of locators) {
    try {
      let el = null;
      if (loc.type === 'role-nth') {
        const all = document.querySelectorAll('[role="textbox"]');
        if (all[loc.index] && isEditable(all[loc.index])) el = all[loc.index];
      } else {
        const found = document.querySelector(loc.selector);
        if (found && isEditable(found) && document.body.contains(found)) el = found;
      }
      if (el) {
        if (isSearchField(el)) continue;
        return el;
      }
    } catch (e) { /* selector parse error, try next */ }
  }
  return null;
}

document.addEventListener('focusin', (e) => {
  // Exclude chat panel (shadow host) and selection popover from editable tracking
  if (e.target.closest && (e.target.closest('#compose-assistant-chat') || e.target.closest('#compose-assistant-chat-host'))) return;
  if (e.target.closest && e.target.closest('#compose-selection-popover')) return;
  const docAdapter = globalThis.ComposeDocumentAdapterRegistry?.getAdapter();
  if (docAdapter) {
    const editorEl = docAdapter.getEditorElement();
    if (editorEl && !editorEl.contains(e.target)) return; // Skip title/ribbon focus
  }
  if (isEditable(e.target) && !isSearchField(e.target)) {
    lastFocusedEditable = e.target;
    lastFocusedTimestamp = Date.now();
    lastFocusedLocators = buildRobustLocators(e.target);
  }
}, true);

// Store caret position on focusout (before focus moves to extension UI)
document.addEventListener('focusout', (e) => {
  if (e.target.closest?.('#compose-assistant-chat') || e.target.closest?.('#compose-assistant-chat-host')) return;
  if (e.target.closest?.('#compose-selection-popover')) return;
  if (!isEditable(e.target)) return;

  const tag = e.target.tagName?.toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'INPUT') {
    lastCaretInfo = {
      el: e.target,
      start: e.target.selectionStart,
      end: e.target.selectionEnd,
      timestamp: Date.now()
    };
  } else if (e.target.isContentEditable || e.target.getAttribute?.('contenteditable') === 'true') {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      lastCaretInfo = {
        el: e.target,
        range: sel.getRangeAt(0).cloneRange(),
        timestamp: Date.now()
      };
    }
  }
}, true);

// =============================================================================
// Keyboard Shortcuts: Alt+Q = Compose, Alt+W = Chat
// =============================================================================

document.addEventListener('keydown', (e) => {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;

  // Alt+W toggles chat — works even when focused inside the chat panel
  if (e.key === 'w' || e.key === 'W') {
    e.preventDefault();
    e.stopPropagation();
    toggleChatBar();
    return;
  }

  // Other shortcuts: ignore if inside chat panel (shadow host) or selection popover
  if (e.target.closest && (e.target.closest('#compose-assistant-chat') || e.target.closest('#compose-assistant-chat-host'))) return;
  if (e.target.closest && e.target.closest('#compose-selection-popover')) return;

  if (e.key === 'q' || e.key === 'Q') {
    e.preventDefault();
    e.stopPropagation();
    const selInfo = getSelectionInfo();
    if (selInfo && selInfo.selectedText && selInfo.selectedText.length > 0) {
      showSelectionPopover(selInfo);
    } else {
      chrome.runtime.sendMessage({ type: 'TRIGGER_COMPOSE' });
    }
  }
}, true);

function createToast() {
  let toast = document.getElementById(TOAST_ID);
  if (toast) return toast;

  toast = document.createElement('div');
  toast.id = TOAST_ID;
  toast.innerHTML = `
    <div class="toast-content">
      <div class="toast-icon"></div>
      <div class="toast-message"></div>
    </div>
  `;
  document.body.appendChild(toast);
  return toast;
}

function showToast(state, data = {}) {
  const toast = createToast();
  const icon = toast.querySelector('.toast-icon');
  const message = toast.querySelector('.toast-message');

  // Clear any pending hide timeout
  if (hideTimeout) {
    clearTimeout(hideTimeout);
    hideTimeout = null;
  }

  // Clear stale click handler from previous error state
  toast.onclick = null;

  // Remove all state classes
  toast.classList.remove('hidden', 'composing', 'success', 'error', 'no-field');

  switch (state) {
    case 'composing':
      toast.classList.add('composing');
      icon.innerHTML = `<div class="spinner"></div>`;
      if (data.activeComposes && data.activeComposes > 1) {
        message.textContent = `Composing (${data.activeComposes} active)...`;
      } else {
        message.textContent = 'Composing...';
      }
      // Safety: auto-dismiss if server never responds (e.g., service worker restart)
      hideTimeout = setTimeout(() => {
        showToast('error', { message: 'Request timed out — try again' });
      }, 60000);
      break;

    case 'capturing':
      toast.classList.add('composing');
      icon.innerHTML = `<div class="spinner"></div>`;
      message.textContent = 'Capturing context...';
      break;

    case 'inserting':
      toast.classList.add('composing');
      icon.innerHTML = `<div class="spinner"></div>`;
      message.textContent = 'Inserting draft...';
      break;

    case 'success':
      toast.classList.add('success');
      icon.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
      let statusMsg = '';
      if (data.credit_tier === 'free') statusMsg = ' (Free Model)';
      else if (data.credit_tier === 'byok') statusMsg = ' (Your Key)';
      message.textContent = (data.message || 'Done!') + statusMsg;
      // Auto-hide after 3 seconds
      hideTimeout = setTimeout(() => hideToast(), 3000);
      break;

    case 'error':
      toast.classList.add('error');
      icon.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>`;
      message.textContent = data.message || 'Failed - Click to retry';
      toast.onclick = () => {
        chrome.runtime.sendMessage({ type: 'RETRY_COMPOSE' });
      };
      hideTimeout = setTimeout(() => hideToast(), 8000);
      break;

    case 'no-field':
      toast.classList.add('error');
      icon.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`;
      message.textContent = 'No text field found';
      hideTimeout = setTimeout(() => hideToast(), 4000);
      break;

    case 'hidden':
      hideToast();
      return;
  }

  // Show toast with animation
  toast.classList.remove('hidden');
  requestAnimationFrame(() => {
    toast.classList.add('visible');
  });
}

function hideToast() {
  const toast = document.getElementById(TOAST_ID);
  if (toast) {
    toast.classList.remove('visible');
    toast.classList.add('hidden');
  }
}

// =============================================================================
// Selection Popover UI (Fixed - Like AIcomposer)
// =============================================================================

// Global element references (avoid querySelector issues)
let selectionPopoverEl = null;
let selectionInputEl = null;
let selectionSubmitBtn = null;

function createSelectionPopover() {
  if (selectionPopoverEl) return selectionPopoverEl;

  // Create popover container
  selectionPopoverEl = document.createElement('div');
  selectionPopoverEl.id = SELECTION_POPOVER_ID;

  // Create content wrapper
  const content = document.createElement('div');
  content.className = 'selection-popover-content';

  // Create input (programmatically, not innerHTML)
  selectionInputEl = document.createElement('input');
  selectionInputEl.type = 'text';
  selectionInputEl.id = 'selection-prompt-input';
  selectionInputEl.placeholder = 'rewrite';
  selectionInputEl.value = 'rewrite';

  // Create submit button
  selectionSubmitBtn = document.createElement('button');
  selectionSubmitBtn.id = 'selection-submit-btn';
  selectionSubmitBtn.className = 'selection-submit-btn';
  selectionSubmitBtn.title = 'Rewrite selection';
  selectionSubmitBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M2 21l21-9L2 3v7l15 2-15 2v7z"/></svg>`;

  // Assemble DOM
  content.appendChild(selectionInputEl);
  content.appendChild(selectionSubmitBtn);
  selectionPopoverEl.appendChild(content);
  document.body.appendChild(selectionPopoverEl);

  // Attach event listeners ONCE at creation (directly to element references)
  selectionInputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      executeSelectionRewrite();
    } else if (e.key === 'Escape') {
      hideSelectionPopover();
    }
  });

  selectionSubmitBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    executeSelectionRewrite();
  });

  // Prevent clicks inside popover from bubbling (would close it)
  selectionPopoverEl.addEventListener('mousedown', (e) => {
    e.stopPropagation();
  });

  // Close on click outside (using document mousedown)
  document.addEventListener('mousedown', (e) => {
    if (selectionPopoverEl && selectionPopoverEl.classList.contains('visible')) {
      if (!selectionPopoverEl.contains(e.target)) {
        hideSelectionPopover();
      }
    }
  });

  return selectionPopoverEl;
}

function getSelectionRect() {
  // Try to get selection rectangle for positioning
  const selection = window.getSelection();
  if (selection && selection.rangeCount > 0) {
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (rect.width > 0 || rect.height > 0) {
      return rect;
    }
  }

  // Fallback: try to get cursor position from active element
  const el = getDeepActiveElement();
  if (el) {
    const rect = el.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      bottom: rect.bottom,
      right: rect.right
    };
  }

  // Default to center of viewport
  return {
    left: window.innerWidth / 2 - 100,
    top: window.innerHeight / 2,
    bottom: window.innerHeight / 2,
    right: window.innerWidth / 2 + 100
  };
}

function showSelectionPopover(data) {
  selectionLocked = true;
  // Prefer storedSelection data over freshly queried data for consistency
  const fullText = (storedSelection && storedSelection.fullText) ? storedSelection.fullText
    : (() => { const editable = findEditableElement(); return editable ? getElementValue(editable) : ''; })();

  selectionData = {
    ...data,
    selectedText: (storedSelection && storedSelection.text) || data.selectedText,
    start: (storedSelection && storedSelection.start !== null) ? storedSelection.start : data.start,
    end: (storedSelection && storedSelection.end !== null) ? storedSelection.end : data.end,
    fullText: fullText
  };

  // Capture selection rect BEFORE creating popover (focus shifts selection)
  const rect = getSelectionRect();

  const popover = createSelectionPopover();

  // Position using fixed positioning (simpler than absolute + scroll)
  popover.style.left = `${Math.max(10, rect.left)}px`;
  popover.style.top = `${rect.bottom + 8}px`;

  popover.classList.add('visible');

  // Ensure stays in viewport (after visible to get correct dimensions)
  requestAnimationFrame(() => {
    const popoverRect = popover.getBoundingClientRect();
    if (popoverRect.right > window.innerWidth - 10) {
      popover.style.left = `${window.innerWidth - popoverRect.width - 10}px`;
    }
    if (popoverRect.bottom > window.innerHeight - 10) {
      popover.style.top = `${rect.top - popoverRect.height - 8}px`;
    }
  });

  // Reset input and focus (using element reference, not querySelector)
  selectionInputEl.value = 'rewrite';
  requestAnimationFrame(() => {
    selectionInputEl.focus({ preventScroll: true });
    selectionInputEl.select();
  });
}

function hideSelectionPopover() {
  selectionLocked = false;
  if (selectionPopoverEl) {
    selectionPopoverEl.classList.remove('visible');
  }
  selectionData = null;
  // Clear browser selection so GET_SELECTION won't re-route to selection mode
  window.getSelection().removeAllRanges();
}

function executeSelectionRewrite() {
  const prompt = selectionInputEl ? (selectionInputEl.value.trim() || 'rewrite') : 'rewrite';

  // Save data BEFORE hiding (hideSelectionPopover nulls selectionData)
  const data = selectionData;

  if (!data) {
    showToast('error', { message: 'No selection data' });
    hideSelectionPopover();
    return;
  }

  // Save element ref before hideSelectionPopover() → removeAllRanges() → selectionchange
  // clears storedSelection. replaceSelection() uses pendingSelectionEl as fallback.
  pendingSelectionEl = storedSelection?.editableEl || null;

  chrome.runtime.sendMessage({
    type: 'EXECUTE_SELECTION_REWRITE',
    data: { ...data, userPrompt: prompt }
  });

  hideSelectionPopover();
}

function replaceSelection(newText, start, end) {
  // Use stored selection target (captured before popover interaction)
  // This is the element where the user originally made their selection
  let actualEl = storedSelection?.editableEl || pendingSelectionEl;
  pendingSelectionEl = null;
  if (!actualEl || !document.body.contains(actualEl)) {
    const el = findEditableElement();
    if (!el) return false;
    actualEl = el.iframe ? el.element : el;
  }

  // Find the contenteditable root (walk up from actualEl)
  // On sites like LinkedIn, the editable might be a nested <p> inside a [contenteditable]
  let rootEl = actualEl;
  let node = actualEl;
  while (node && node !== document.body) {
    if (node.getAttribute && node.getAttribute('contenteditable') === 'true') {
      rootEl = node;
    }
    node = node.parentElement;
  }

  const tag = actualEl.tagName?.toUpperCase();

  // === INPUT / TEXTAREA ===
  if (tag === 'TEXTAREA' || tag === 'INPUT') {
    actualEl.focus();
    if (typeof actualEl.setRangeText === 'function' && start !== null && end !== null) {
      try {
        actualEl.setSelectionRange(start, end);
        actualEl.setRangeText(newText);
      } catch (e) {
        const before = actualEl.value.substring(0, start);
        const after = actualEl.value.substring(end);
        actualEl.value = before + newText + after;
      }
    } else {
      const before = actualEl.value.substring(0, start);
      const after = actualEl.value.substring(end);
      actualEl.value = before + newText + after;
    }

    const newCursorPos = start + newText.length;
    actualEl.setSelectionRange(newCursorPos, newCursorPos);
    actualEl.dispatchEvent(new Event('input', { bubbles: true }));
    actualEl.dispatchEvent(new Event('change', { bubbles: true }));
    flashElement(actualEl);
    storedSelection = null;
    selectionLocked = false;
    return true;
  }

  // === CONTENTEDITABLE ===
  if (rootEl.isContentEditable || rootEl.getAttribute('contenteditable') === 'true') {
    const sel = window.getSelection();
    const rangeToUse = storedSelection?.range;

    // Step 1: Restore the stored range BEFORE focusing (focus can trigger re-renders)
    let rangeRestored = false;
    if (rangeToUse) {
      try {
        sel.removeAllRanges();
        sel.addRange(rangeToUse);
        rangeRestored = true;
      } catch (e) {
        // Range invalid (DOM re-rendered) — fall through to offset strategies
      }
    }

    // Step 2: Focus the contenteditable root AFTER restoring range
    rootEl.focus();

    // Step 3: Verify the restored range still selects the right text
    if (rangeRestored && storedSelection?.text) {
      const currentSelected = sel.toString();
      if (currentSelected !== storedSelection.text) {
        rangeRestored = false;
      }
    }

    // Step 4: If range restoration failed, rebuild from character offsets
    if (!rangeRestored && start !== null && end !== null) {
      rangeRestored = _selectByOffsets(rootEl, sel, start, end);
    }

    // Step 5: If offsets failed, find the original text by string search (compound match first)
    if (!rangeRestored && storedSelection?.text) {
      const elementText = rootEl.innerText || rootEl.textContent || '';
      let idx = -1;
      // Try compound match with surrounding context first
      if (storedSelection.contextBefore || storedSelection.contextAfter) {
        const compound = (storedSelection.contextBefore || '') + storedSelection.text + (storedSelection.contextAfter || '');
        const compoundIdx = elementText.indexOf(compound);
        if (compoundIdx !== -1) {
          idx = compoundIdx + (storedSelection.contextBefore || '').length;
        }
      }
      // Fall back to simple indexOf
      if (idx === -1) {
        idx = elementText.indexOf(storedSelection.text);
      }
      if (idx !== -1) {
        rangeRestored = _selectByOffsets(rootEl, sel, idx, idx + storedSelection.text.length);
      }
    }

    // Step 6: Replace the selected text
    let success = false;
    if (rangeRestored) {
      success = document.execCommand('insertText', false, newText);
    }

    if (!success && rangeRestored && rangeToUse) {
      // Fallback: manual range manipulation (like AIcomposer)
      try {
        const activeRange = sel.getRangeAt(0);
        activeRange.deleteContents();
        activeRange.insertNode(document.createTextNode(newText));
        sel.collapseToEnd();
        success = true;
      } catch (e) { /* fall through */ }
    }

    if (!success && start !== null && end !== null) {
      // Last resort: splice by string offsets
      const fullText = rootEl.innerText || rootEl.textContent || '';
      const before = fullText.substring(0, start);
      const after = fullText.substring(end);
      rootEl.textContent = before + newText + after;
    }

    rootEl.dispatchEvent(new Event('input', { bubbles: true }));
    rootEl.dispatchEvent(new Event('change', { bubbles: true }));
    flashElement(rootEl);
    storedSelection = null;
    selectionLocked = false;
    return true;
  }

  selectionLocked = false;
  return false;
}

// Helper: select text in an element by character offsets via TreeWalker
function _selectByOffsets(el, sel, startOffset, endOffset) {
  try {
    const range = document.createRange();
    let charCount = 0;
    let startNode = null, sOffset = 0;
    let endNode = null, eOffset = 0;

    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let tNode;
    while (tNode = walker.nextNode()) {
      const nodeLen = tNode.textContent.length;
      if (!startNode && charCount + nodeLen > startOffset) {
        startNode = tNode;
        sOffset = startOffset - charCount;
      }
      if (!endNode && charCount + nodeLen >= endOffset) {
        endNode = tNode;
        eOffset = endOffset - charCount;
        break;
      }
      charCount += nodeLen;
    }

    if (startNode && endNode) {
      range.setStart(startNode, sOffset);
      range.setEnd(endNode, eOffset);
      sel.removeAllRanges();
      sel.addRange(range);
      return true;
    }
  } catch (e) { /* ignore */ }
  return false;
}

function flashElement(el) {
  const originalOutline = el.style.outline;
  const originalTransition = el.style.transition;

  el.style.transition = 'outline 0.3s ease';
  el.style.outline = '2px solid #7C3AED';

  setTimeout(() => {
    el.style.outline = originalOutline;
    setTimeout(() => {
      el.style.transition = originalTransition;
    }, 300);
  }, 500);
}

// =============================================================================
// Page Context Extraction
// =============================================================================

function getDeepActiveElement() {
  let active = document.activeElement;
  while (active && active.shadowRoot && active.shadowRoot.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  return active;
}

function isEditable(el) {
  if (!el) return false;
  const tag = el.tagName?.toUpperCase();
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT' && ['text', 'email', 'search', 'url', ''].includes(el.type || '')) return true;
  if (el.isContentEditable) return true;
  if (el.getAttribute('role') === 'textbox') return true;
  if (el.getAttribute('contenteditable') === 'true') return true;
  return false;
}

function isSearchField(el) {
  if (!el) return false;
  const elType = (el.getAttribute('type') || '').toLowerCase();
  const elRole = (el.getAttribute('role') || '').toLowerCase();
  if (elType === 'search' || elRole === 'combobox' || elRole === 'searchbox') return true;
  const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
  if (ariaLabel.includes('search')) return true;
  if (el.closest?.('[role="search"]')) return true;
  return false;
}

function findEditableElement() {
  // Helper: skip our own chat panel elements (may be in shadow DOM)
  function isChatPanel(el) {
    return el && el.closest && (el.closest('#compose-assistant-chat') || el.closest('#compose-assistant-chat-host'));
  }

  // 1. Try deep active element
  let el = getDeepActiveElement();
  if (isEditable(el) && !isChatPanel(el)) return el;

  // 1.5 Try last focused editable (survives focus loss from clicking extension icon)
  if (lastFocusedEditable && (Date.now() - lastFocusedTimestamp < 30000)) {
    if (document.body.contains(lastFocusedEditable) && isEditable(lastFocusedEditable) && !isSearchField(lastFocusedEditable)) {
      const rect = lastFocusedEditable.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return lastFocusedEditable;
    }
  }

  // 2. Try document selection
  const selection = document.getSelection();
  if (selection && selection.anchorNode) {
    let node = selection.anchorNode;
    while (node) {
      if (node.nodeType === 1 && isEditable(node)) return node;
      node = node.parentElement;
    }
  }

  // 3. Search for visible editable elements
  const selectors = [
    '.msg-form__contenteditable',
    'textarea',
    'input[type="text"]',
    'input:not([type])',
    '[contenteditable="true"]',
    '[role="textbox"]',
    '.editable',
    '.compose-input',
    '.message-input',
    '.DraftEditor-root',
    '.ql-editor'
  ];

  for (const selector of selectors) {
    const elements = document.querySelectorAll(selector);
    for (const el of elements) {
      if (isChatPanel(el)) continue;  // skip our own chat textarea
      if (el.offsetWidth > 0 && el.offsetHeight > 0) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 50 && rect.height > 20) {
          return el;
        }
      }
    }
  }

  // 4. Check iframes
  const iframes = document.querySelectorAll('iframe');
  for (const iframe of iframes) {
    try {
      const iframeDoc = iframe.contentDocument;
      if (iframeDoc) {
        const iframeActive = iframeDoc.activeElement;
        if (isEditable(iframeActive)) return { iframe, element: iframeActive };
      }
    } catch (e) { /* cross-origin */ }
  }

  return null;
}

function findAllEditableElements() {
  const results = [];
  const seen = new Set();

  const selectors = [
    'textarea',
    'input[type="text"]',
    'input[type="email"]',
    'input[type="search"]',
    'input[type="url"]',
    'input:not([type])',
    '[contenteditable="true"]',
    '[role="textbox"]'
  ];

  for (const selector of selectors) {
    const elements = document.querySelectorAll(selector);
    for (const el of elements) {
      if (seen.has(el)) continue;
      seen.add(el);

      // Skip elements inside our extension UI
      if (el.closest('#compose-assistant-toast, #compose-selection-popover, #compose-assistant-chat, #compose-assistant-chat-host')) continue;

      // Skip hidden elements
      if (el.offsetWidth === 0 && el.offsetHeight === 0) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 50 || rect.height < 20) continue;

      // Determine field type
      const tag = el.tagName?.toUpperCase();
      let fieldType = 'unknown';
      if (tag === 'TEXTAREA') fieldType = 'textarea';
      else if (tag === 'INPUT') fieldType = 'input-' + (el.type || 'text');
      else if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') fieldType = 'contenteditable';
      else if (el.getAttribute('role') === 'textbox') fieldType = 'textbox';

      // Find label
      let label = '';
      if (el.id) {
        const labelEl = document.querySelector(`label[for="${el.id}"]`);
        if (labelEl) label = labelEl.textContent.trim();
      }
      if (!label && el.parentElement) {
        const parentLabel = el.parentElement.closest('label');
        if (parentLabel) label = parentLabel.textContent.trim();
      }
      if (!label) {
        // Check preceding sibling or nearby label
        const prev = el.previousElementSibling;
        if (prev && (prev.tagName === 'LABEL' || prev.tagName === 'SPAN' || prev.tagName === 'DIV')) {
          const txt = prev.textContent.trim();
          if (txt.length < 100) label = txt;
        }
      }
      if (!label && el.getAttribute('aria-label')) {
        label = el.getAttribute('aria-label');
      }

      const selectorStr = getElementSelector(el);

      results.push({
        element: el,
        selector: selectorStr,
        label: label || '',
        placeholder: el.placeholder || el.getAttribute('placeholder') || '',
        fieldType,
        currentValue: getElementValue(el)
      });
    }
  }

  return results;
}

function getElementValue(el) {
  if (!el) return '';
  if (el.iframe && el.element) el = el.element;

  const tag = el.tagName?.toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'INPUT') {
    return el.value || '';
  }
  return el.innerText || el.textContent || '';
}

function cssEscapeId(id) {
  // Escape special CSS characters in IDs (e.g., Gmail's ":1gp" -> "\\:1gp")
  return id.replace(/([^\w-])/g, '\\$1');
}

function getElementSelector(el) {
  if (!el || !el.tagName) return null;
  if (el.iframe && el.element) {
    return { iframe: true, selector: getElementSelector(el.element) };
  }

  const parts = [];
  let current = el;

  while (current && current.tagName) {
    let selector = current.tagName.toLowerCase();

    if (current.id) {
      selector += '#' + cssEscapeId(current.id);
      parts.unshift(selector);
      break;
    }

    if (current.className && typeof current.className === 'string') {
      const classes = current.className.trim().split(/\s+/).slice(0, 2);
      if (classes.length) {
        selector += '.' + classes.join('.');
      }
    }

    parts.unshift(selector);
    current = current.parentElement;

    if (parts.length > 5) break;
  }

  return parts.join(' > ');
}

function getContainerHtml(el, maxSize = 150000) {
  if (!el) return '';
  if (el.iframe && el.element) el = el.element;

  let container = el;
  let chatContainer = null;

  const chatSelectors = [
    '.msg-convo-wrapper',
    '.msg-overlay-conversation-bubble',
    '[role="log"]',
    '[role="feed"]',
    '.conversation',
    '.chat-container',
    '.message-list',
    '.thread',
    '[data-testid="conversation"]',
    '.AO',
    '.nH.bkK',
  ];

  let searchEl = el;
  for (let i = 0; i < 15 && searchEl; i++) {
    for (const selector of chatSelectors) {
      const match = searchEl.closest(selector);
      if (match) {
        chatContainer = match;
        break;
      }
    }
    if (chatContainer) break;

    const classes = (searchEl.className || '').toLowerCase();
    const role = (searchEl.getAttribute('role') || '').toLowerCase();
    if (/convo|conversation|chat|thread|message-list|mail-list/i.test(classes) ||
        role === 'log' || role === 'feed') {
      chatContainer = searchEl;
      break;
    }

    searchEl = searchEl.parentElement;
  }

  if (chatContainer) {
    container = chatContainer;
  } else {
    const stopTags = ['body', 'html'];
    for (let i = 0; i < 15 && container.parentElement; i++) {
      const parent = container.parentElement;
      const tag = parent.tagName.toLowerCase();

      if (stopTags.includes(tag)) break;

      const classes = parent.className || '';
      if (/compose|message|mail|editor|chat|reply|comment|conversation|thread/i.test(classes)) {
        container = parent;
      } else {
        container = parent;
      }

      if (container.innerHTML.length > maxSize * 0.8) break;
    }
  }

  let html = container.outerHTML || '';

  // Remove heavy content
  html = html.replace(/src="data:[^"]+"/gi, 'src=""');
  html = html.replace(/<img[^>]*>/gi, '');
  html = html.replace(/<video[^>]*>.*?<\/video>/gis, '');
  html = html.replace(/<audio[^>]*>.*?<\/audio>/gis, '');
  html = html.replace(/<svg[^>]*>.*?<\/svg>/gis, '');
  html = html.replace(/<style[^>]*>.*?<\/style>/gis, '');

  if (html.length > maxSize) {
    html = html.substring(0, maxSize) + '...(truncated)';
  }

  return html;
}

function isPdfPage() {
  const url = window.location.href.toLowerCase();
  // URL ends with .pdf (with optional query/hash)
  if (/\.pdf(\?|#|$)/i.test(url)) return true;
  // Chrome's built-in PDF viewer uses an <embed> with type application/pdf
  const embed = document.querySelector('embed[type="application/pdf"]');
  if (embed) return true;
  // Firefox/other viewers may use <object>
  const obj = document.querySelector('object[type="application/pdf"]');
  if (obj) return true;
  return false;
}

function captureVisiblePageContext(maxSize = 5000) {
  const contextParts = [];

  if (document.title) {
    contextParts.push(`[Page Title]: ${document.title}`);
  }

  contextParts.push(`[URL]: ${window.location.href}`);

  const headings = document.querySelectorAll('h1, h2');
  const visibleHeadings = [];
  headings.forEach(h => {
    if (h.offsetParent !== null && h.innerText.trim()) {
      const text = h.innerText.trim().substring(0, 100);
      if (!visibleHeadings.includes(text)) {
        visibleHeadings.push(text);
      }
    }
  });
  if (visibleHeadings.length > 0) {
    contextParts.push(`[Main Headings]: ${visibleHeadings.slice(0, 5).join(' | ')}`);
  }

  const profileSelectors = [
    '.text-heading-xlarge',
    '.text-body-medium',
    '.pv-text-details__left-panel h1',
    '.msg-overlay-bubble-header__title',
    '.go',
    '[data-hovercard-id]',
    '[data-testid="UserName"]',
    '.profile-name',
    '.user-name',
    '.recipient-name',
    '[data-field="name"]',
    '[aria-label*="profile"]'
  ];

  const profileInfo = new Set();
  profileSelectors.forEach(selector => {
    try {
      const elements = document.querySelectorAll(selector);
      elements.forEach(el => {
        if (el.offsetParent !== null) {
          const text = (el.innerText || el.textContent || '').trim();
          if (text && text.length < 200 && text.length > 1) {
            profileInfo.add(text.substring(0, 100));
          }
        }
      });
    } catch (e) {}
  });

  if (profileInfo.size > 0) {
    contextParts.push(`[Recipient/Profile Info]: ${Array.from(profileInfo).slice(0, 5).join(' | ')}`);
  }

  const hostname = window.location.hostname;
  let platform = 'Unknown';
  if (hostname.includes('linkedin')) platform = 'LinkedIn';
  else if (hostname.includes('gmail') || hostname.includes('mail.google')) platform = 'Gmail';
  else if (hostname.includes('twitter') || hostname.includes('x.com')) platform = 'Twitter/X';
  else if (hostname.includes('facebook')) platform = 'Facebook';
  else if (hostname.includes('reddit')) platform = 'Reddit';
  else if (hostname.includes('slack')) platform = 'Slack';
  else if (hostname.includes('discord')) platform = 'Discord';
  else if (hostname.includes('outlook')) platform = 'Outlook';
  else if (hostname.includes('officeapps.live.com') || (hostname.includes('office.com') && window.location.href.toLowerCase().includes('word'))) platform = 'Word Online';
  else if (hostname.includes('docs.google.com')) platform = 'Google Docs';

  contextParts.push(`[Platform]: ${platform}`);

  let result = contextParts.join('\n');
  if (result.length > maxSize) {
    result = result.substring(0, maxSize) + '...(truncated)';
  }

  return result;
}

// =============================================================================
// Cursor Cluster Gathering (raw DOM data for server-side extraction)
// =============================================================================

function gatherCursorCluster(editableEl, maxHtmlPerElement = 100000) {
  if (!editableEl) return null;

  const el = (editableEl.iframe && editableEl.element) ? editableEl.element : editableEl;

  // --- Caret position ---
  let caretRect = {};
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0) {
    const range = sel.getRangeAt(0);
    const rects = range.getClientRects();
    if (rects.length > 0) {
      const r = rects[0];
      caretRect = { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
    }
  }
  if (!caretRect.left && el.getBoundingClientRect) {
    const r = el.getBoundingClientRect();
    caretRect = { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
  }

  // --- Viewport ---
  const viewport = {
    scrollX: Math.round(window.scrollX || window.pageXOffset || 0),
    scrollY: Math.round(window.scrollY || window.pageYOffset || 0),
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight
  };

  // Helper: capture element data with size-limited HTML
  function captureElement(element) {
    if (!element || !element.tagName) return null;
    try {
      const rect = element.getBoundingClientRect();
      let html = element.outerHTML || '';
      // Strip heavy content before size check
      html = html.replace(/src="data:[^"]+"/gi, 'src=""');
      html = html.replace(/<img[^>]*>/gi, '');
      html = html.replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, '');
      html = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
      if (html.length > maxHtmlPerElement) {
        html = html.substring(0, maxHtmlPerElement) + '...(truncated)';
      }
      return {
        outerHTML: html,
        tag: element.tagName.toLowerCase(),
        bbox: {
          left: Math.round(rect.left),
          top: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        },
        selector: getElementSelector(element)
      };
    } catch (e) {
      return null;
    }
  }

  // --- Ancestors (walk up from editable element) ---
  const ancestors = [];
  let current = el.parentElement;
  for (let i = 0; i < 15 && current && current.tagName.toLowerCase() !== 'html'; i++) {
    const data = captureElement(current);
    if (data && data.outerHTML.length > 50) {
      ancestors.push(data);
    }
    current = current.parentElement;
  }

  // --- Candidates (siblings + nearby elements) ---
  const candidates = [];
  const seen = new Set();

  // Add the editable element itself
  const selfData = captureElement(el);
  if (selfData) {
    seen.add(el);
    candidates.push(selfData);
  }

  // Add siblings of the editable and its parent
  const parentsToCheck = [el.parentElement, el.parentElement?.parentElement].filter(Boolean);
  for (const parent of parentsToCheck) {
    for (const child of parent.children) {
      if (seen.has(child)) continue;
      seen.add(child);
      const data = captureElement(child);
      if (data && data.outerHTML.length > 50) {
        candidates.push(data);
      }
      if (candidates.length >= 20) break;
    }
    if (candidates.length >= 20) break;
  }

  // --- containerCapture (document-wide search for known compose containers) ---
  let containerCapture = null;
  const knownSelectors = [
    // Gmail compose dialog
    { selector: 'div.AD[role="dialog"]', source: 'gmail_AD' },
    { selector: 'div.AD', source: 'gmail_AD' },
    // LinkedIn message overlay
    { selector: '.msg-overlay-conversation-bubble', source: 'linkedin_msg' },
    { selector: '.msg-convo-wrapper', source: 'linkedin_msg' },
    { selector: '.msg-form', source: 'linkedin_msg' },
    // Generic compose/dialog
    { selector: '[role="dialog"]', source: 'dialog_role' },
    { selector: '.compose-form', source: 'compose' },
    { selector: '.message-container', source: 'compose' },
    { selector: '.chat-container', source: 'compose' },
  ];

  for (const { selector, source } of knownSelectors) {
    try {
      const match = el.closest(selector) || document.querySelector(selector);
      if (match) {
        const data = captureElement(match);
        if (data && data.outerHTML.length > 100) {
          containerCapture = {
            html: data.outerHTML,
            selector: data.selector,
            bbox: data.bbox,
            source: source
          };
          break;
        }
      }
    } catch (e) {}
  }

  return {
    candidates,
    ancestors,
    caretRect,
    viewport,
    containerCapture,
    candidates_count: candidates.length
  };
}

// Get the question/label text surrounding the focused editable field
function getFocusedFieldContext(el) {
  if (!el) return '';
  const element = (el.iframe && el.element) ? el.element : el;
  let context = '';

  // 1. Check aria-label or placeholder first (most reliable)
  const ariaLabel = element.getAttribute('aria-label');
  const placeholder = element.getAttribute('placeholder');
  if (ariaLabel) context = 'aria-label: ' + ariaLabel;
  if (placeholder) context = (context ? context + ' | ' : '') + 'placeholder: ' + placeholder;
  if (context) return context.substring(0, 400);

  // 2. Check for associated <label> via 'for' attribute
  const id = element.getAttribute('id');
  if (id) {
    const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
    if (label) {
      const text = label.textContent?.trim();
      if (text && text.length > 3) return text.substring(0, 400);
    }
  }

  // 3. Check if element is inside a wrapping <label>
  const wrappingLabel = element.closest('label');
  if (wrappingLabel) {
    // Get only the label's own text, excluding the input's content
    let labelText = '';
    for (const child of wrappingLabel.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const t = child.textContent?.trim();
        if (t && t.length > 3) labelText += (labelText ? ' ' : '') + t;
      } else if (child !== element && child.tagName !== 'TEXTAREA' && child.tagName !== 'INPUT'
        && !child.querySelector('textarea, input, [contenteditable]')) {
        const t = child.textContent?.trim();
        if (t && t.length > 3 && t.length < 200) labelText += (labelText ? ' ' : '') + t;
      }
    }
    if (labelText) return labelText.substring(0, 400);
  }

  // 4. Look at the immediate preceding sibling(s) only — stop at the first match
  //    This prevents walking too far up and grabbing labels from other fields.
  let current = element;
  for (let depth = 0; depth < 3 && current && current !== document.body; depth++) {
    // Check immediate preceding sibling
    let prev = current.previousElementSibling;
    if (prev) {
      // Skip utility elements (counters, hidden divs, etc.)
      for (let j = 0; j < 2 && prev; j++) {
        const text = prev.textContent?.trim();
        if (text && text.length > 3 && text.length < 300) {
          // Check this isn't another field's textarea/input content
          const hasInput = prev.querySelector('textarea, input, [contenteditable]');
          if (!hasInput) {
            context = text;
            break;
          }
        }
        prev = prev.previousElementSibling;
      }
      if (context) break;
    }

    // Check parent's direct text nodes (not children's text)
    const parent = current.parentElement;
    if (parent && parent !== document.body) {
      let parentDirectText = '';
      for (const child of parent.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          const t = child.textContent?.trim();
          if (t && t.length > 3) parentDirectText += (parentDirectText ? ' ' : '') + t;
        }
      }
      if (parentDirectText) {
        context = parentDirectText;
        break;
      }
    }

    current = current.parentElement;
  }

  return context.substring(0, 400);
}

function extractPageContext() {
  const docAdapter = globalThis.ComposeDocumentAdapterRegistry?.getAdapter();
  if (docAdapter) {
    const hasSelection = docAdapter.hasSelection();
    const selectedText = hasSelection ? docAdapter.readSelection() : null;
    const fullContent = docAdapter.readFullContent();
    const cursorCtx = docAdapter.getCursorContext();
    return {
      hasEditable: true,
      draftText: hasSelection ? selectedText : fullContent,
      containerHtml: '',
      pageContext: captureVisiblePageContext(),
      selector: null, cursorCluster: null,
      focusedFieldContext: '', multipleFields: false, fieldCount: 1,
      // New document-mode fields
      documentMode: true,
      documentTitle: docAdapter.getDocumentTitle(),
      selectionMode: hasSelection ? 'selection' : 'full_document',
      cursorContext: cursorCtx,
      fullDocumentText: hasSelection ? fullContent : null
    };
  }
  const editable = findEditableElement();

  if (!editable) {
    return { hasEditable: false, draftText: '', containerHtml: '', pageContext: '', selector: null, cursorCluster: null };
  }

  const draftText = getElementValue(editable);
  const containerHtml = getContainerHtml(editable);
  const pageContext = captureVisiblePageContext();
  const selector = getElementSelector(editable);
  const cursorCluster = gatherCursorCluster(editable);
  const focusedFieldContext = getFocusedFieldContext(editable);

  // Check for multiple editable fields on the page
  const allEditables = findAllEditableElements();
  const multipleFields = allEditables.length >= 2;

  return {
    hasEditable: true,
    draftText,
    containerHtml,
    pageContext,
    selector,
    isIframe: !!(editable.iframe),
    cursorCluster,
    focusedFieldContext,
    multipleFields,
    fieldCount: allEditables.length
  };
}

// =============================================================================
// LinkedIn Placeholder Fix
// =============================================================================

function hideSlatePlaceholder(node) {
  if (!node || !node.style) return;
  node.style.setProperty('display', 'none', 'important');
  node.style.setProperty('visibility', 'hidden', 'important');
  node.style.setProperty('pointer-events', 'none', 'important');
  node.setAttribute('aria-hidden', 'true');
}

function clearLinkedInPlaceholders(el) {
  // Clear placeholder attributes/classes used by various frameworks:
  // LinkedIn: [data-placeholder] on <p> children (CSS ::before pseudo-element)
  // Discord/Slate: [data-slate-placeholder] overlay elements
  // Quill: .ql-blank class
  // Generic: [aria-placeholder], [placeholder]
  if (!el) return;

  const placeholderAttrs = ['data-placeholder', 'aria-placeholder'];
  const placeholderClasses = ['ql-blank'];
  const slatePlaceholderNodes = Array.from(el.querySelectorAll('[data-slate-placeholder]'));

  function clearEl(target) {
    if (!target || !target.hasAttribute) return;
    for (const attr of placeholderAttrs) {
      if (target.hasAttribute(attr)) target.removeAttribute(attr);
    }
    if (target.classList) {
      for (const cls of placeholderClasses) {
        target.classList.remove(cls);
      }
    }
  }

  // Clear on the element itself
  clearEl(el);

  // Clear on all child elements
  el.querySelectorAll('[data-placeholder], [aria-placeholder], .ql-blank').forEach(clearEl);

  slatePlaceholderNodes.forEach(hideSlatePlaceholder);

  // Also check parent - some platforms put placeholder on the wrapper
  if (el.parentElement) {
    clearEl(el.parentElement);
    // Check siblings with placeholder attributes (separate placeholder elements)
    el.parentElement.querySelectorAll('[data-placeholder], [data-slate-placeholder]').forEach(sib => {
      if (sib !== el) {
        clearEl(sib);
        if (sib.hasAttribute('data-slate-placeholder')) {
          hideSlatePlaceholder(sib);
        } else {
          sib.style.display = 'none';
        }
      }
    });
  }
}

function watchForPlaceholderReappearance(el, durationMs = 2000) {
  // Frameworks (LinkedIn, Discord/Slate, Quill) can re-add placeholder elements
  // after a re-render. Watch with a MutationObserver and suppress for a short window.
  if (!el) return;

  function suppressPlaceholder(node) {
    if (!node || node.nodeType !== 1) return;
    if (node.hasAttribute('data-placeholder')) node.removeAttribute('data-placeholder');
    if (node.hasAttribute('data-slate-placeholder')) {
      hideSlatePlaceholder(node);
    }
    if (node.classList && node.classList.contains('ql-blank')) {
      node.classList.remove('ql-blank');
    }
    if (node.querySelectorAll) {
      node.querySelectorAll('[data-placeholder], [data-slate-placeholder], .ql-blank').forEach(child => {
        if (child.hasAttribute('data-placeholder')) child.removeAttribute('data-placeholder');
        if (child.hasAttribute('data-slate-placeholder')) hideSlatePlaceholder(child);
        if (child.classList.contains('ql-blank')) child.classList.remove('ql-blank');
      });
    }
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'attributes') {
        suppressPlaceholder(mutation.target);
      }
      if (mutation.type === 'childList') {
        mutation.addedNodes.forEach(suppressPlaceholder);
      }
    }
  });

  // Observe the element and its parent subtree
  const observeTarget = el.parentElement || el;
  observer.observe(observeTarget, {
    attributes: true,
    attributeFilter: ['data-placeholder', 'data-slate-placeholder', 'class', 'style'],
    childList: true,
    subtree: true
  });

  // Disconnect after the window expires
  setTimeout(() => observer.disconnect(), durationMs);
}

// =============================================================================
// Draft Insertion
// =============================================================================

// =============================================================================
// Write Value to Element (shared by insertDraft and INSERT_ALL_FIELDS)
// =============================================================================
//
// Universal strategy: use ONLY native execCommand('insertText') which works
// with every framework (React, Quill, Lexical, Draft.js, ProseMirror, etc.)
// because it fires trusted beforeinput/input events the framework recognises.
// Zero direct DOM mutation — the browser (and framework) handle the change.

function checkTextReplaceOutcome(beforeText, afterText, text) {
  const draft = String(text ?? '').trim();
  if (!afterText || beforeText === afterText) return 'unchanged';
  if (!draft) return 'changed';
  if (afterText.includes(draft)) {
    if (beforeText && afterText.includes(beforeText)) return 'appended';
    return 'replaced';
  }
  return 'changed';
}

function trustedReplaceText(target, text) {
  return new Promise((resolve) => {
    try {
      const rect = target.getBoundingClientRect();
      chrome.runtime.sendMessage({
        type: 'TRUSTED_REPLACE_TEXT',
        text,
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
      }, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ success: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { success: false, error: 'Trusted replace returned no response' });
      });
    } catch (error) {
      resolve({ success: false, error: error.message || 'Trusted replace failed' });
    }
  });
}

async function writeValueToElement(el, text) {
  if (!el) return false;

  // Normalize literal escape sequences (e.g. backslash-n) to real characters
  const normalizeWriteText = textWriter.normalizeWriteText ||
    ((value) => String(value ?? '').replace(/\\n/g, '\n').replace(/\\t/g, '\t'));
  text = normalizeWriteText(text);

  const tag = el.tagName?.toUpperCase();

  if (tag === 'TEXTAREA' || tag === 'INPUT') {
    el.focus();
    el.select();
    // Belt-and-suspenders: setSelectionRange is more reliable than select()
    // on some frameworks (LinkedIn React) that intercept focus/selection
    try { el.setSelectionRange(0, el.value.length); } catch (e) { /* type="email" etc. */ }

    const cmdOk = document.execCommand('insertText', false, text);

    // Verify REPLACEMENT — check value equals new text, not just "includes".
    // If select() failed silently, insertText appends at cursor instead of replacing,
    // and both old + new text are present. A simple "includes" check misses this.
    const correctlyReplaced = cmdOk && el.value === text;

    if (!correctlyReplaced) {
      const proto = tag === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (nativeSetter) {
        nativeSetter.call(el, text);
      } else {
        el.value = text;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      _log('[WRITE] execCommand did not replace cleanly, used native setter fallback');
    } else {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    flashElement(el);
    return true;
  }

  if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') {
    // Walk up to the contenteditable root — on LinkedIn, focusin may capture
    // a child <p data-placeholder="…"> inside the [contenteditable] div.
    if (el.isContentEditable && el.getAttribute('contenteditable') !== 'true') {
      let node = el.parentElement;
      while (node && node !== document.body) {
        if (node.getAttribute('contenteditable') === 'true') {
          el = node;
          break;
        }
        node = node.parentElement;
      }
    }

    const isDiscord = window.location.hostname.includes('discord');
    const selection = window.getSelection();
    let beforeText = null;

    if (isDiscord) {
      const trustedTarget = textWriter.getSlateEditorTarget?.(el) || el;
      beforeText = getElementValue(trustedTarget) || '';

      if (typeof trustedTarget.focus === 'function') {
        trustedTarget.focus();
      }
      await new Promise(resolve => setTimeout(resolve, 0));

      const trustedResult = await trustedReplaceText(trustedTarget, text);
      await new Promise(resolve => setTimeout(resolve, 0));

      const afterText = getElementValue(trustedTarget) || '';
      const outcome = checkTextReplaceOutcome(beforeText, afterText, text);

      if (trustedResult?.success && outcome === 'replaced') {
        clearLinkedInPlaceholders(trustedTarget);
        watchForPlaceholderReappearance(trustedTarget);
        flashElement(trustedTarget);
        return true;
      }
    }

    let replaceResult = null;
    if (typeof textWriter.replaceContentEditableText === 'function') {
      replaceResult = textWriter.replaceContentEditableText(el, text, {
        documentRef: document,
        selection,
        slateMode: isDiscord ? 'manual-model' : undefined,
      });
      if (replaceResult?.target) {
        el = replaceResult.target;
      }
    }

    let replaceStrategy = replaceResult?.strategy || '';
    let cmdOk = !!replaceResult?.ok;
    const isSlate = typeof textWriter.isSlateEditor === 'function' ? textWriter.isSlateEditor(el) : false;

    if (isDiscord && isSlate && (
      replaceStrategy === 'slate-manual-beforeinput'
      || replaceStrategy === 'slate-manual-paste'
    ) && beforeText !== null) {
      await new Promise(resolve => setTimeout(resolve, 0));
      const afterSlateText = getElementValue(el) || '';
      const slateOutcome = checkTextReplaceOutcome(beforeText, afterSlateText, text);
      if (slateOutcome !== 'replaced' && slateOutcome !== 'appended' && typeof textWriter.replaceContentEditableText === 'function') {
        replaceResult = textWriter.replaceContentEditableText(el, text, {
          documentRef: document,
          selection,
          slateMode: 'prefer-model',
        });
        if (replaceResult?.target) {
          el = replaceResult.target;
        }
        replaceStrategy = replaceResult?.strategy || replaceStrategy;
        cmdOk = !!replaceResult?.ok;
      }
    }

    if (!cmdOk && !isSlate) {
      el.focus();
      document.execCommand('selectAll', false, null);
      cmdOk = document.execCommand('insertText', false, text);
    }

    const textPresent = !!(getElementValue(el) && getElementValue(el).includes(text.substring(0, Math.min(20, text.length))));

    if ((!cmdOk || !textPresent) && !isSlate) {
      _log('[WRITE] contenteditable: execCommand failed, using DOM fallback');
      while (el.firstChild) el.removeChild(el.firstChild);
      const paragraphs = text.split(/\n\n+/);
      for (const para of paragraphs) {
        const p = document.createElement('p');
        const lines = para.split('\n');
        lines.forEach((line, i) => {
          if (i > 0) p.appendChild(document.createElement('br'));
          p.appendChild(document.createTextNode(line));
        });
        el.appendChild(p);
      }
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }

    clearLinkedInPlaceholders(el);
    watchForPlaceholderReappearance(el);
    flashElement(el);

    if (isDiscord && beforeText !== null) {
      await new Promise(resolve => setTimeout(resolve, 0));
      const finalText = getElementValue(el) || '';
      const finalOutcome = checkTextReplaceOutcome(beforeText, finalText, text);
      return finalOutcome === 'replaced';
    }
    return isSlate ? (cmdOk && textPresent) : (cmdOk || textPresent || !isSlate);
  }

  return false;
}

async function insertTextIntoTarget(el, text) {
  if (!el) return false;
  return await writeValueToElement(el, text);
}

async function insertDraft(text, selector) {
  function findElement(selector) {
    if (!selector) return null;
    if (typeof selector === 'string') {
      try {
        return document.querySelector(selector);
      } catch (e) {}
    }
    return null;
  }

  // Try multiple strategies - prioritize the actual field the user was typing in
  let target = null;

  // 1. Try last focused editable (most reliable - tracks the exact field user was in)
  // 120s window: compose can take 30-40s on remote server + network latency
  if (lastFocusedEditable && (Date.now() - lastFocusedTimestamp < 120000)) {
    if (document.body.contains(lastFocusedEditable) && isEditable(lastFocusedEditable) && !isSearchField(lastFocusedEditable)) {
      target = lastFocusedEditable;
    }
  }

  // 2. Try stored locators (survives SPA re-renders that detach the element)
  if (!target && lastFocusedLocators.length > 0 && (Date.now() - lastFocusedTimestamp < 120000)) {
    target = resolveLocators(lastFocusedLocators);
  }

  // 3. Try active element (but never our own chat panel or search bars)
  if (!target) {
    target = getDeepActiveElement();
    if (!isEditable(target) || isSearchField(target) || (target.closest && (target.closest('#compose-assistant-chat') || target.closest('#compose-assistant-chat-host')))) target = null;
  }

  // 4. Try the provided selector (may match wrong element if ambiguous)
  if (!target) {
    target = findElement(selector);
  }

  // 4. Search for editable
  if (!target) {
    target = findEditableElement();
    if (target && target.iframe) target = target.element;
  }

  if (target) {
    // Clipboard backup — fire-and-forget so user can paste if insertion fails
    try { navigator.clipboard.writeText(text).catch(() => {}); } catch (e) {}
    return await writeValueToElement(target, text);
  }

  return false;
}

// =============================================================================
// Selection Detection
// =============================================================================

function getSelectionInfo() {
  const docAdapter = globalThis.ComposeDocumentAdapterRegistry?.getAdapter();
  if (docAdapter && docAdapter.hasSelection()) {
    const selected = docAdapter.readSelection();
    if (selected) return { selectedText: selected, start: null, end: null, documentMode: true };
  }
  // First, try to get live selection (works if page still has focus)
  const editable = findEditableElement();
  if (editable) {
    const el = editable.iframe ? editable.element : editable;
    const tag = el.tagName?.toUpperCase();

    // For input/textarea elements
    if (tag === 'TEXTAREA' || tag === 'INPUT') {
      const start = el.selectionStart;
      const end = el.selectionEnd;
      if (start !== end) {
        const selectedText = el.value.substring(start, end);
        return { selectedText, start, end };
      }
    }

    // For contenteditable elements
    if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') {
      const selection = window.getSelection();
      if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
        const selectedText = selection.toString();
        if (selectedText) {
          const range = selection.getRangeAt(0);
          const preRange = document.createRange();
          preRange.selectNodeContents(el);
          preRange.setEnd(range.startContainer, range.startOffset);
          const start = preRange.toString().length;
          const end = start + selectedText.length;
          return { selectedText, start, end };
        }
      }
    }
  }

  // Fallback: use stored selection captured before focus was lost (120 second TTL)
  if (storedSelection && storedSelection.text && (Date.now() - storedSelection.timestamp < 120000)) {
    return {
      selectedText: storedSelection.text,
      start: storedSelection.start,
      end: storedSelection.end
    };
  }

  return { selectedText: '', start: null, end: null };
}

// =============================================================================
// Chat Panel
// =============================================================================

const CHAT_PANEL_ID = 'compose-assistant-chat';
const CHAT_STORAGE_KEY = 'composeAssistantChatData';
const CHAT_OLD_STORAGE_KEY = 'composeAssistantChatHistory'; // migration
const MAX_CHAT_SESSIONS = 20;
let chatPanelEl = null;
let chatShadowHost = null;
let chatShadowRoot = null;
let chatInputEl = null;
let chatMessagesEl = null;
let chatState = 'minimized'; // 'minimized', 'collapsed', 'expanded'
let chatConversationHistory = [];
let currentChatId = generateChatId();
let chatSessions = []; // archived chats: [{id, title, messages, createdAt}]
let chatMode = 'chat'; // 'chat' or 'with_page'
let pendingFileUpload = null;
let chatFileChipContainer = null;
let chatFileInput = null;

function getChatStyles() {
  const mainStyle = document.getElementById('compose-assistant-styles');
  if (!mainStyle) return '';
  const full = mainStyle.textContent || '';
  const chatStart = full.indexOf('/* Floating Chat Bar */');
  if (chatStart === -1) return '';
  return '#compose-assistant-chat { pointer-events: auto; }\n' + full.substring(chatStart);
}

function createChatBar() {
  if (chatPanelEl) return chatPanelEl;

  // Shadow DOM host — hides chat from page DOM queries and focus traps.
  // 'closed' mode prevents page scripts from accessing shadowRoot at all.
  chatShadowHost = document.createElement('div');
  chatShadowHost.id = 'compose-assistant-chat-host';
  chatShadowHost.style.cssText = 'all:initial; position:fixed; inset:0; z-index:2147483646; pointer-events:none;';
  chatShadowRoot = chatShadowHost.attachShadow({ mode: 'closed' });

  chatPanelEl = document.createElement('div');
  chatPanelEl.id = CHAT_PANEL_ID;
  chatPanelEl.className = 'minimized';

  // Toggle button (FAB - visible when minimized)
  const toggleBtn = document.createElement('button');
  toggleBtn.className = 'chat-bar-toggle';
  toggleBtn.title = 'Open Chat (Alt+W)';
  toggleBtn.innerHTML = `<div class="chat-fab-ring"></div><svg width="22" height="22" viewBox="0 0 24 24" fill="white" stroke="none"><line x1="8" y1="16" x2="17" y2="7" stroke="white" stroke-width="2.2" stroke-linecap="round"/><path d="M7.3 15.3 L8.7 16.7 L5.5 18.5Z"/><path d="M19 1.5L19.7 3.3 21.5 4 19.7 4.7 19 6.5 18.3 4.7 16.5 4 18.3 3.3Z"/></svg>`;

  // Container (hidden when minimized)
  const container = document.createElement('div');
  container.className = 'chat-bar-container';

  // Header — two rows: title row + toolbar row
  const header = document.createElement('div');
  header.className = 'chat-bar-header';

  // Title row
  const titleRow = document.createElement('div');
  titleRow.className = 'chat-header-title-row';

  const titleLeft = document.createElement('div');
  titleLeft.className = 'chat-header-left';

  const logoIcon = document.createElement('span');
  logoIcon.className = 'chat-logo-icon';
  logoIcon.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="white" stroke="none"><line x1="8" y1="16" x2="17" y2="7" stroke="white" stroke-width="2.2" stroke-linecap="round"/><path d="M7.3 15.3 L8.7 16.7 L5.5 18.5Z" fill="white"/><path d="M19 1.5L19.7 3.3 21.5 4 19.7 4.7 19 6.5 18.3 4.7 16.5 4 18.3 3.3Z" fill="white"/></svg>';

  const titleGroup = document.createElement('div');
  titleGroup.className = 'chat-title-group';

  const title = document.createElement('span');
  title.className = 'chat-title';
  title.textContent = 'Compose';

  const hostDisplay = document.createElement('span');
  hostDisplay.className = 'chat-host-display';
  try {
    hostDisplay.textContent = new URL(window.location.href).hostname;
  } catch (e) {
    hostDisplay.textContent = '';
  }

  titleGroup.appendChild(title);
  titleGroup.appendChild(hostDisplay);
  titleLeft.appendChild(logoIcon);
  titleLeft.appendChild(titleGroup);

  const titleActions = document.createElement('div');
  titleActions.className = 'chat-header-actions';

  const newChatBtn = document.createElement('button');
  newChatBtn.className = 'chat-action-btn';
  newChatBtn.title = 'New Chat';
  newChatBtn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>`;

  const closeBtn = document.createElement('button');
  closeBtn.className = 'chat-action-btn';
  closeBtn.title = 'Close (Alt+W)';
  closeBtn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;

  titleActions.appendChild(newChatBtn);
  titleActions.appendChild(closeBtn);

  titleRow.appendChild(titleLeft);
  titleRow.appendChild(titleActions);

  // Toolbar row — mode tabs + action buttons
  const toolbarRow = document.createElement('div');
  toolbarRow.className = 'chat-header-toolbar';

  // Segmented mode control (pill tabs instead of <select>)
  const modeSegment = document.createElement('div');
  modeSegment.className = 'chat-mode-segment';

  const modes = [
    { value: 'chat', label: 'Knowledge', icon: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><path d="M12 16v-4"></path><path d="M12 8h.01"></path></svg>' },
    { value: 'with_page', label: 'Page', icon: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>' },
    { value: 'agent', label: 'Agent', icon: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a4 4 0 0 0-4 4v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2h-2V6a4 4 0 0 0-4-4z"></path></svg>' }
  ];

  // Hidden <select> for form compat (sendChatMessage reads chatMode)
  const modeSelect = document.createElement('select');
  modeSelect.className = 'chat-mode-select';
  modeSelect.style.display = 'none';
  modes.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m.value;
    opt.textContent = m.label;
    modeSelect.appendChild(opt);
  });

  modes.forEach((m, i) => {
    const tab = document.createElement('button');
    tab.className = 'chat-mode-tab' + (i === 0 ? ' active' : '');
    tab.dataset.mode = m.value;
    tab.title = m.label;
    tab.innerHTML = `${m.icon}<span>${m.label}</span>`;
    tab.addEventListener('click', () => {
      modeSegment.querySelectorAll('.chat-mode-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      chatMode = m.value;
      modeSelect.value = m.value;
    });
    modeSegment.appendChild(tab);
  });

  const toolbarActions = document.createElement('div');
  toolbarActions.className = 'chat-toolbar-actions';

  const captureBtn = document.createElement('button');
  captureBtn.className = 'chat-action-btn';
  captureBtn.title = 'Capture page profile';
  captureBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"></path><circle cx="12" cy="13" r="4"></circle></svg>`;

  const historyBtn = document.createElement('button');
  historyBtn.className = 'chat-action-btn';
  historyBtn.title = 'Chat History';
  historyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>`;

  const feedbackBtn = document.createElement('button');
  feedbackBtn.className = 'chat-action-btn';
  feedbackBtn.title = 'Send Feedback';
  feedbackBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"></path></svg>`;

  toolbarActions.appendChild(captureBtn);
  toolbarActions.appendChild(historyBtn);
  toolbarActions.appendChild(feedbackBtn);

  toolbarRow.appendChild(modeSegment);
  toolbarRow.appendChild(modeSelect);
  toolbarRow.appendChild(toolbarActions);

  // History dropdown (hidden by default)
  const historyDropdown = document.createElement('div');
  historyDropdown.className = 'chat-history-dropdown';

  header.appendChild(titleRow);
  header.appendChild(toolbarRow);

  // Messages area (shown only in expanded state)
  chatMessagesEl = document.createElement('div');
  chatMessagesEl.className = 'chat-bar-messages';

  // Welcome message
  const welcomeEl = document.createElement('div');
  welcomeEl.className = 'chat-welcome';
  welcomeEl.innerHTML = `<div class="chat-welcome-icon">
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
      <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"></path>
    </svg>
  </div>
  <div class="chat-welcome-title">How can I help?</div>
  <div class="chat-welcome-text">Ask anything about your knowledge base, switch to <strong>Page</strong> mode to discuss the current page, or use <strong>Agent</strong> to fill forms.</div>`;

  // Input area (always visible in collapsed/expanded)
  const inputArea = document.createElement('div');
  inputArea.className = 'chat-bar-input-area';

  // Use about:blank iframe for true focus isolation — focus inside iframe
  // does NOT trigger focusout on parent document elements (LinkedIn post editor).
  // Textarea is created programmatically (no inline scripts = no CSP issues).
  const chatIframe = document.createElement('iframe');
  chatIframe.className = 'chat-input';
  chatIframe.style.cssText = 'padding:0; height:40px; max-height:120px; overflow:hidden;';
  chatIframe.scrolling = 'no';
  chatIframe.src = 'about:blank';

  let _iframeTextarea = null;

  // Proxy so existing code (chatInputEl.value, .focus()) works before and after iframe loads
  chatInputEl = {
    _iframe: chatIframe,
    get value() { return _iframeTextarea ? _iframeTextarea.value : ''; },
    set value(v) {
      if (_iframeTextarea) _iframeTextarea.value = v || '';
    },
    focus() {
      if (_iframeTextarea) _iframeTextarea.focus();
      else try { chatIframe.contentWindow?.focus(); } catch(e) {}
    },
    style: chatIframe.style,
    tagName: 'TEXTAREA',
    className: 'chat-input',
    addEventListener: () => {},  // handlers added directly on _iframeTextarea in load
  };

  chatIframe.addEventListener('load', () => {
    const doc = chatIframe.contentDocument;
    if (!doc) return;

    // Inject styles (no <script> — purely CSS)
    const style = doc.createElement('style');
    style.textContent = `*{margin:0;padding:0;box-sizing:border-box}
html,body{background:transparent;overflow:hidden;height:auto}
textarea{width:100%;border:none;outline:none;resize:none;font-size:13px;
font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
padding:10px 14px;background:transparent;color:#0F172A;line-height:1.4;
overflow-y:hidden}
textarea::placeholder{color:#94A3B8}`;
    doc.head.appendChild(style);

    const ta = doc.createElement('textarea');
    ta.placeholder = 'Ask anything...';
    ta.rows = 1;
    doc.body.appendChild(ta);
    _iframeTextarea = ta;

    function resize() {
      ta.style.height = 'auto';
      const h = ta.scrollHeight;
      ta.style.height = h + 'px';
      chatIframe.style.height = Math.min(h, 120) + 'px';
    }

    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendChatMessage();
        ta.value = '';
        resize();
      }
      if (e.key === 'Escape') {
        setChatState('minimized');
      }
    });
    ta.addEventListener('input', resize);
    ta.addEventListener('paste', (e) => {
      const items = e.clipboardData?.items;
      if (items) {
        for (const item of items) {
          if (item.type.startsWith('image/')) {
            e.preventDefault();
            const file = item.getAsFile();
            if (!file) continue;
            const ext = item.type.split('/')[1] || 'png';
            const reader = new FileReader();
            reader.onload = () => {
              pendingFileUpload = {
                name: `pasted-image.${ext}`,
                type: item.type,
                size: file.size,
                base64Data: reader.result,
              };
              if (chatFileChipContainer) {
                chatFileChipContainer.innerHTML = '';
                const chipDiv = document.createElement('div');
                chipDiv.className = 'chat-file-chip';
                const chipSpan = document.createElement('span');
                chipSpan.textContent = `pasted-image.${ext}`;
                const chipRemoveBtn = document.createElement('button');
                chipRemoveBtn.className = 'chat-file-chip-remove';
                chipRemoveBtn.title = 'Remove';
                chipRemoveBtn.textContent = '\u00d7';
                chipDiv.appendChild(chipSpan);
                chipDiv.appendChild(chipRemoveBtn);
                chatFileChipContainer.appendChild(chipDiv);
                chatFileChipContainer.style.display = 'flex';
                chipRemoveBtn.addEventListener('click', (ev) => {
                  ev.stopPropagation();
                  pendingFileUpload = null;
                  chatFileChipContainer.style.display = 'none';
                  chatFileChipContainer.innerHTML = '';
                });
              }
            };
            reader.readAsDataURL(file);
            break;
          }
        }
      }
    });
    ta.addEventListener('focus', () => {
      chatIframe.style.background = '#FFFFFF';
      chatIframe.style.borderColor = '#7C3AED';
      chatIframe.style.boxShadow = '0 0 0 3px rgba(124,58,237,0.1)';
      if (chatState === 'collapsed' && chatConversationHistory.length > 0) {
        setChatState('expanded');
      }
    });
    ta.addEventListener('blur', () => {
      chatIframe.style.background = '';
      chatIframe.style.borderColor = '';
      chatIframe.style.boxShadow = '';
    });
  });

  // File upload button + hidden input
  chatFileInput = document.createElement('input');
  chatFileInput.type = 'file';
  chatFileInput.accept = '.txt,.pdf,.csv,.doc,.docx,.png,.jpg,.jpeg,.gif,.webp,image/*';
  chatFileInput.style.display = 'none';
  chatFileInput.id = 'chat-file-input';

  const uploadBtn = document.createElement('button');
  uploadBtn.className = 'chat-upload-btn';
  uploadBtn.title = 'Upload file (txt, pdf, csv, doc)';
  uploadBtn.type = 'button';
  uploadBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"></path></svg>`;

  // File chip container (shown below input when file selected)
  chatFileChipContainer = document.createElement('div');
  chatFileChipContainer.className = 'chat-file-chip-container';
  chatFileChipContainer.style.display = 'none';

  uploadBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    chatFileInput.click();
  });

  chatFileInput.addEventListener('change', () => {
    const file = chatFileInput.files?.[0];
    if (!file) return;
    // Validate size (5MB)
    if (file.size > 5 * 1024 * 1024) {
      appendChatMessage('system', 'File too large. Maximum size is 5MB.');
      chatFileInput.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      pendingFileUpload = {
        name: file.name,
        type: file.type,
        size: file.size,
        base64Data: reader.result,
      };
      // Show file chip
      chatFileChipContainer.innerHTML = '';
      const chipDiv = document.createElement('div');
      chipDiv.className = 'chat-file-chip';
      const chipSpan = document.createElement('span');
      chipSpan.textContent = file.name;
      const chipRemoveBtn = document.createElement('button');
      chipRemoveBtn.className = 'chat-file-chip-remove';
      chipRemoveBtn.title = 'Remove';
      chipRemoveBtn.textContent = '\u00d7';
      chipDiv.appendChild(chipSpan);
      chipDiv.appendChild(chipRemoveBtn);
      chatFileChipContainer.appendChild(chipDiv);
      chatFileChipContainer.style.display = 'flex';
      chipRemoveBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        pendingFileUpload = null;
        chatFileChipContainer.style.display = 'none';
        chatFileChipContainer.innerHTML = '';
        chatFileInput.value = '';
      });
    };
    reader.readAsDataURL(file);
  });

  const sendBtn = document.createElement('button');
  sendBtn.className = 'chat-send-btn';
  sendBtn.title = 'Send';
  sendBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>`;

  inputArea.appendChild(chatIframe);
  inputArea.appendChild(uploadBtn);
  inputArea.appendChild(chatFileInput);
  inputArea.appendChild(sendBtn);

  // Resize handle
  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'chat-bar-resize-handle';

  // Copy handler: strip HTML styling so pasted text is visible in light-themed fields
  chatMessagesEl.addEventListener('copy', (e) => {
    const selection = window.getSelection();
    if (selection) {
      e.preventDefault();
      e.clipboardData.setData('text/plain', selection.toString());
    }
  });

  container.appendChild(header);
  container.appendChild(historyDropdown);
  container.appendChild(chatMessagesEl);
  chatMessagesEl.appendChild(welcomeEl);
  container.appendChild(chatFileChipContainer);
  container.appendChild(inputArea);
  container.appendChild(resizeHandle);

  chatPanelEl.appendChild(toggleBtn);
  chatPanelEl.appendChild(container);

  // Inject chat CSS into shadow root (page styles don't cross shadow boundary)
  const chatStyle = document.createElement('style');
  chatStyle.textContent = getChatStyles();
  chatShadowRoot.appendChild(chatStyle);
  chatShadowRoot.appendChild(chatPanelEl);
  document.body.appendChild(chatShadowHost);

  // PDF pages: ensure the chat panel renders above Chrome's PDF viewer embed.
  if (isPdfPage()) {
    chatShadowHost.style.cssText += ';z-index:2147483647 !important;';
  }

  // Event listeners
  modeSelect.addEventListener('change', (e) => {
    chatMode = e.target.value;
  });

  toggleBtn.addEventListener('click', () => {
    // Ignore click if user was dragging the bubble
    if (didDrag) { didDrag = false; return; }
    setChatState(chatConversationHistory.length > 0 ? 'expanded' : 'collapsed');
  });

  closeBtn.addEventListener('click', () => setChatState('minimized'));

  newChatBtn.addEventListener('click', () => {
    startNewChat();
    historyDropdown.style.display = 'none';
  });

  historyBtn.addEventListener('click', () => {
    const isOpen = historyDropdown.style.display === 'block';
    if (isOpen) {
      historyDropdown.style.display = 'none';
    } else {
      renderHistoryDropdown(historyDropdown);
      historyDropdown.style.display = 'block';
    }
  });

  // Close history dropdown when clicking outside (composedPath for shadow DOM)
  document.addEventListener('click', (e) => {
    const path = e.composedPath();
    if (historyDropdown.style.display === 'block' &&
        !path.includes(historyDropdown) &&
        !path.includes(historyBtn)) {
      historyDropdown.style.display = 'none';
    }
  });

  sendBtn.addEventListener('click', () => sendChatMessage());

  captureBtn.addEventListener('click', async () => {
    try {
      captureBtn.disabled = true;
      appendChatMessage('system', 'Capturing page profile...');
      const result = await chrome.runtime.sendMessage({ type: 'CAPTURE_PROFILE' });
      if (result && result.success) {
        appendChatMessage('system', 'Profile captured and saved to memory.');
      } else {
        appendChatMessage('system', result?.error || 'Capture failed.');
      }
    } catch (e) {
      appendChatMessage('system', 'Capture error: ' + e.message);
    } finally {
      captureBtn.disabled = false;
    }
  });

  feedbackBtn.addEventListener('click', () => {
    const existing = chatMessagesEl.querySelector('.feedback-form-panel');
    if (existing) { existing.remove(); return; }

    const panel = document.createElement('div');
    panel.className = 'feedback-form-panel';
    panel.innerHTML = `
      <div class="feedback-form-header">Send Feedback</div>
      <select class="feedback-category">
        <option value="general">General</option>
        <option value="bug">Bug Report</option>
        <option value="feature">Feature Request</option>
        <option value="praise">Praise</option>
      </select>
      <textarea class="feedback-message" placeholder="Tell us what you think..." rows="4"></textarea>
      <div class="feedback-actions">
        <button class="feedback-cancel">Cancel</button>
        <button class="feedback-submit">Send</button>
      </div>
      <div class="feedback-status" style="display:none"></div>
    `;

    ['keydown', 'keyup', 'keypress'].forEach((evt) => {
      panel.addEventListener(evt, (e) => e.stopPropagation());
    });

    panel.querySelector('.feedback-cancel').addEventListener('click', () => panel.remove());
    panel.querySelector('.feedback-submit').addEventListener('click', async () => {
      const msg = panel.querySelector('.feedback-message').value.trim();
      if (!msg) return;
      const cat = panel.querySelector('.feedback-category').value;
      const statusEl = panel.querySelector('.feedback-status');
      const submitBtn = panel.querySelector('.feedback-submit');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Sending...';
      try {
        const result = await chrome.runtime.sendMessage({
          type: 'SEND_FEEDBACK',
          data: {
            category: cat,
            message: msg,
            url: window.location.href,
            page_title: document.title,
          }
        });
        if (result && result.success) {
          statusEl.textContent = 'Feedback sent! Thank you.';
          statusEl.style.display = 'block';
          statusEl.style.color = '#22c55e';
          setTimeout(() => panel.remove(), 1500);
        } else {
          statusEl.textContent = result?.error || 'Failed to send';
          statusEl.style.display = 'block';
          statusEl.style.color = '#ef4444';
          submitBtn.disabled = false;
          submitBtn.textContent = 'Send';
        }
      } catch (e) {
        statusEl.textContent = 'Error: ' + e.message;
        statusEl.style.display = 'block';
        statusEl.style.color = '#ef4444';
        submitBtn.disabled = false;
        submitBtn.textContent = 'Send';
      }
    });

    chatMessagesEl.appendChild(panel);
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
    panel.querySelector('.feedback-message').focus();
  });

  // Prevent clicks inside chat bar from propagating to page scripts.
  chatPanelEl.addEventListener('mousedown', (e) => {
    e.stopPropagation();
  });

  // Block page scripts from intercepting keyboard/input events.
  // Use BUBBLE phase so descendant handlers (Enter-to-send, etc.) fire first.
  const bubbleBlockEvents = ['keydown', 'keyup', 'keypress', 'beforeinput', 'input',
    'compositionstart', 'compositionend', 'paste', 'cut'];
  for (const eventName of bubbleBlockEvents) {
    chatPanelEl.addEventListener(eventName, (e) => {
      e.stopPropagation();
    });
  }

  // Block focus events from propagating to LinkedIn (prevents focus stealing)
  chatPanelEl.addEventListener('focusin', (e) => {
    e.stopPropagation();
  }, true);
  chatPanelEl.addEventListener('focusout', (e) => {
    e.stopPropagation();
  }, true);

  // Also block events on the shadow HOST in the main DOM.
  // Composed events (keyboard, focus) cross the shadow boundary — stop them
  // at the host so LinkedIn's document-level handlers never see them.
  const hostBlockEvents = ['keydown', 'keyup', 'keypress', 'beforeinput', 'input',
    'compositionstart', 'compositionend', 'paste', 'cut',
    'focusin', 'focusout', 'mousedown', 'click'];
  for (const eventName of hostBlockEvents) {
    chatShadowHost.addEventListener(eventName, (e) => {
      e.stopPropagation();
    });
  }

  // --- Drag support (drag by header or toggle bubble) ---
  let isDragging = false;
  let didDrag = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;

  header.style.cursor = 'grab';
  toggleBtn.style.cursor = 'grab';

  header.addEventListener('mousedown', (e) => {
    // Don't drag when clicking buttons/select inside header
    if (e.target.closest('button, select')) return;
    isDragging = true;
    didDrag = false;
    header.style.cursor = 'grabbing';
    const rect = chatPanelEl.getBoundingClientRect();
    dragOffsetX = e.clientX - rect.left;
    dragOffsetY = e.clientY - rect.top;
    e.preventDefault();
  });

  toggleBtn.addEventListener('mousedown', (e) => {
    isDragging = true;
    didDrag = false;
    toggleBtn.style.cursor = 'grabbing';
    const rect = chatPanelEl.getBoundingClientRect();
    dragOffsetX = e.clientX - rect.left;
    dragOffsetY = e.clientY - rect.top;
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    didDrag = true;
    const newLeft = e.clientX - dragOffsetX;
    const newTop = e.clientY - dragOffsetY;

    // Clamp to viewport
    const maxLeft = window.innerWidth - 60;
    const maxTop = window.innerHeight - 60;
    chatPanelEl.style.left = Math.max(0, Math.min(newLeft, maxLeft)) + 'px';
    chatPanelEl.style.top = Math.max(0, Math.min(newTop, maxTop)) + 'px';
    // Clear right/bottom so left/top take precedence
    chatPanelEl.style.right = 'auto';
    chatPanelEl.style.bottom = 'auto';
  });

  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      header.style.cursor = 'grab';
      toggleBtn.style.cursor = 'grab';
    }
  });

  // --- Resize support (drag resize handle at bottom-right of container) ---
  let isResizing = false;
  let resizeStartX = 0;
  let resizeStartY = 0;
  let resizeStartW = 0;
  let resizeStartH = 0;

  resizeHandle.addEventListener('mousedown', (e) => {
    isResizing = true;
    resizeStartX = e.clientX;
    resizeStartY = e.clientY;
    resizeStartW = container.offsetWidth;
    resizeStartH = container.offsetHeight;
    e.preventDefault();
    e.stopPropagation();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    const dw = e.clientX - resizeStartX;
    const dh = e.clientY - resizeStartY;
    const newW = Math.max(280, Math.min(resizeStartW + dw, window.innerWidth - 40));
    const newH = Math.max(200, Math.min(resizeStartH + dh, window.innerHeight - 80));
    container.style.width = newW + 'px';
    container.style.height = newH + 'px';
    // When user resizes, let messages area fill the extra space
    chatMessagesEl.style.maxHeight = 'none';
    chatMessagesEl.style.flex = '1';
  });

  document.addEventListener('mouseup', () => {
    isResizing = false;
  });

  // Load saved conversation
  loadChatHistory();

  return chatPanelEl;
}

function setChatState(newState) {
  chatState = newState;
  if (!chatPanelEl) return;
  chatPanelEl.className = newState; // 'minimized', 'collapsed', or 'expanded'

  if (newState !== 'minimized') {
    setTimeout(() => {
      chatInputEl.focus();
      // Retry focus in case LinkedIn steals it
      setTimeout(() => chatInputEl.focus(), 300);
      setTimeout(() => chatInputEl.focus(), 600);
    }, 100);
  }
}

function toggleChatBar(forceState) {
  createChatBar();
  if (forceState !== undefined) {
    setChatState(forceState ? (chatConversationHistory.length > 0 ? 'expanded' : 'collapsed') : 'minimized');
  } else {
    // Toggle: minimized <-> collapsed/expanded
    if (chatState === 'minimized') {
      setChatState(chatConversationHistory.length > 0 ? 'expanded' : 'collapsed');
    } else {
      setChatState('minimized');
    }
  }
}

function appendChatMessage(role, content) {
  if (!chatMessagesEl) return;

  // Remove welcome message if it exists and we're adding a real message
  const welcome = chatMessagesEl.querySelector('.chat-welcome');
  if (welcome) welcome.remove();

  const msgEl = document.createElement('div');
  msgEl.className = `chat-message chat-message-${role}`;

  if (role === 'assistant') {
    msgEl.innerHTML = renderChatMarkdown(content);
  } else if (role === 'system') {
    msgEl.textContent = content;
  } else {
    // User messages: preserve newlines by escaping HTML and converting \n to <br>
    const escaped = content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    msgEl.innerHTML = escaped.replace(/\n/g, '<br>');
  }

  chatMessagesEl.appendChild(msgEl);
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;

  // Auto-expand to show messages if in collapsed state
  if (chatState === 'collapsed') {
    setChatState('expanded');
  }
}

function sanitizeHref(url) {
  // Validate URL before inserting into href attribute
  try { new URL(url); } catch { return '#'; }
  if (!/^https?:\/\//i.test(url)) return '#';
  return url.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderChatMarkdown(text) {
  // Extract links from raw text BEFORE HTML-encoding (avoids &quot; bypass)
  const linkMap = new Map();
  let linkIdx = 0;
  const rawWithPlaceholders = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
    const key = `\x00LINK${linkIdx++}\x00`;
    linkMap.set(key, { label, url });
    return key;
  });

  let html = rawWithPlaceholders
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  // Code blocks (must be before inline code)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Italic
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // Restore links with sanitized hrefs
  for (const [key, { label, url }] of linkMap) {
    const safeUrl = sanitizeHref(url);
    const safeLabel = label.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    if (safeUrl !== '#') {
      html = html.replace(key, `<a href="${safeUrl}" target="_blank" rel="noopener">${safeLabel}</a>`);
    } else {
      html = html.replace(key, `${safeLabel}`);
    }
  }
  // Headers (### before ##)
  html = html.replace(/^### (.+)$/gm, '<strong style="font-size:13px">$1</strong>');
  html = html.replace(/^## (.+)$/gm, '<strong style="font-size:14px">$1</strong>');
  // Bullet lists (- item or * item, but not already-processed italic/bold)
  html = html.replace(/^[\-] (.+)$/gm, '&nbsp;&nbsp;\u2022 $1');
  // Numbered lists (1. item)
  html = html.replace(/^(\d+\.) (.+)$/gm, '&nbsp;&nbsp;$1 $2');
  // Line breaks
  html = html.replace(/\n/g, '<br>');

  return html;
}

async function sendChatMessage() {
  const message = chatInputEl.value.trim();
  if (!message) return;

  // Show user message
  appendChatMessage('user', message);
  chatInputEl.value = '';
  if (chatInputEl._iframe) chatInputEl._iframe.style.height = '40px';
  else if (chatInputEl.style) chatInputEl.style.height = '40px';

  // Add to history
  chatConversationHistory.push({ role: 'user', content: message });
  saveChatHistory();

  // Show typing indicator
  const typingEl = document.createElement('div');
  typingEl.className = 'chat-message chat-message-assistant chat-typing';
  typingEl.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';
  chatMessagesEl.appendChild(typingEl);
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;

  try {
    const msgData = {
      message,
      conversationHistory: chatConversationHistory.slice(-10),
      mode: chatMode,
      currentUrl: window.location.href,
    };
    // Attach file upload if pending
    if (pendingFileUpload) {
      msgData.fileUpload = pendingFileUpload;
      appendChatMessage('system', `Uploading file: ${pendingFileUpload.name}`);
      pendingFileUpload = null;
      if (chatFileChipContainer) {
        chatFileChipContainer.style.display = 'none';
        chatFileChipContainer.innerHTML = '';
      }
      if (chatFileInput) chatFileInput.value = '';
    }
    let timeoutId;
    const chatTimeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('Request timed out. Please try again.')), 60000);
    });
    const response = await Promise.race([
      chrome.runtime.sendMessage({ type: 'CHAT_MESSAGE', data: msgData }),
      chatTimeout,
    ]);
    clearTimeout(timeoutId);

    // Remove typing indicator
    if (typingEl.parentNode) typingEl.remove();

    if (!response) {
      appendChatMessage('system', 'No response from server. Extension may need reload.');
    } else if (response.success) {
      appendChatMessage('assistant', response.reply);
      chatConversationHistory.push({ role: 'assistant', content: response.reply });

      // Show sources if available
      if (response.sources && response.sources.length > 0) {
        const sourcesText = response.sources
          .map((s, i) => `[${i + 1}] ${s.content}`)
          .join('\n');
        // Only show sources indicator, not full content
        const srcEl = document.createElement('div');
        srcEl.className = 'chat-sources';
        srcEl.textContent = `${response.sources.length} memory source(s) used`;
        chatMessagesEl.appendChild(srcEl);
        chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
      }

      saveChatHistory();
    } else {
      appendChatMessage('system', response?.error || 'Failed to get response');
    }
  } catch (error) {
    if (typingEl.parentNode) typingEl.remove();
    appendChatMessage('system', 'Connection error: ' + error.message);
  }
}

function generateChatId() {
  return 'chat_' + Date.now();
}

function getChatTitle(messages) {
  const firstUser = messages.find(m => m.role === 'user');
  if (firstUser) return firstUser.content.slice(0, 40).replace(/\n/g, ' ');
  return 'New Chat';
}

function formatRelativeTime(timestamp) {
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  const date = new Date(timestamp);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function archiveCurrentChat() {
  if (chatConversationHistory.length === 0) return;

  // Update existing session or create new one
  const existing = chatSessions.findIndex(s => s.id === currentChatId);
  const session = {
    id: currentChatId,
    title: getChatTitle(chatConversationHistory),
    messages: chatConversationHistory.slice(-50),
    createdAt: existing >= 0 ? chatSessions[existing].createdAt : Date.now(),
  };

  if (existing >= 0) {
    chatSessions[existing] = session;
  } else {
    chatSessions.unshift(session);
  }

  // Prune oldest sessions beyond max
  if (chatSessions.length > MAX_CHAT_SESSIONS) {
    chatSessions = chatSessions.slice(0, MAX_CHAT_SESSIONS);
  }
}

function startNewChat() {
  archiveCurrentChat();
  chatConversationHistory = [];
  currentChatId = generateChatId();
  if (chatMessagesEl) {
    chatMessagesEl.innerHTML = '';
    const welcomeEl = document.createElement('div');
    welcomeEl.className = 'chat-welcome';
    welcomeEl.innerHTML = `<div class="chat-welcome-icon">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"></path>
      </svg>
    </div>
    <div class="chat-welcome-text">Ask anything about your knowledge base, or switch to "Page" mode to discuss the current page.</div>`;
    chatMessagesEl.appendChild(welcomeEl);
  }
  saveChatHistory();
}

function loadChat(chatId) {
  // Save current chat first
  archiveCurrentChat();

  const session = chatSessions.find(s => s.id === chatId);
  if (!session) return;

  // Remove from sessions list (it becomes the active chat)
  chatSessions = chatSessions.filter(s => s.id !== chatId);

  currentChatId = session.id;
  chatConversationHistory = [...session.messages];

  // Render messages
  if (chatMessagesEl) {
    chatMessagesEl.innerHTML = '';
    chatConversationHistory.forEach(msg => appendChatMessage(msg.role, msg.content));
  }
  saveChatHistory();
}

function deleteChat(chatId) {
  chatSessions = chatSessions.filter(s => s.id !== chatId);
  saveChatHistory();
}

function renderHistoryDropdown(dropdown) {
  dropdown.innerHTML = '';

  if (chatSessions.length === 0) {
    const emptyEl = document.createElement('div');
    emptyEl.className = 'chat-history-empty';
    emptyEl.textContent = 'No past chats';
    dropdown.appendChild(emptyEl);
    return;
  }

  chatSessions.forEach(session => {
    const item = document.createElement('div');
    item.className = 'chat-history-item';

    const titleEl = document.createElement('span');
    titleEl.className = 'chat-history-item-title';
    titleEl.textContent = session.title;

    const dateEl = document.createElement('span');
    dateEl.className = 'chat-history-item-date';
    dateEl.textContent = formatRelativeTime(session.createdAt);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'chat-history-item-delete';
    deleteBtn.innerHTML = '&times;';
    deleteBtn.title = 'Delete';
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteChat(session.id);
      renderHistoryDropdown(dropdown);
    });

    item.appendChild(titleEl);
    item.appendChild(dateEl);
    item.appendChild(deleteBtn);

    item.addEventListener('click', () => {
      loadChat(session.id);
      dropdown.style.display = 'none';
      if (chatState !== 'expanded') setChatState('expanded');
    });

    dropdown.appendChild(item);
  });
}

function saveChatHistory() {
  try {
    const data = {
      currentChatId,
      currentMessages: chatConversationHistory.slice(-50),
      chats: chatSessions,
    };
    chrome.storage.local.set({ [CHAT_STORAGE_KEY]: data });
  } catch (e) { /* ignore */ }
}

function loadChatHistory() {
  try {
    chrome.storage.local.get([CHAT_STORAGE_KEY, CHAT_OLD_STORAGE_KEY], (result) => {
      const data = result[CHAT_STORAGE_KEY];
      const oldHistory = result[CHAT_OLD_STORAGE_KEY];

      if (data && typeof data === 'object' && !Array.isArray(data)) {
        // New format: load sessions, then archive the previous active chat and start fresh
        chatSessions = Array.isArray(data.chats) ? data.chats : [];

        if (Array.isArray(data.currentMessages) && data.currentMessages.length > 0) {
          // Archive the previous active chat (from the closed tab)
          const prevId = data.currentChatId || generateChatId();
          const existing = chatSessions.findIndex(s => s.id === prevId);
          const session = {
            id: prevId,
            title: getChatTitle(data.currentMessages),
            messages: data.currentMessages.slice(-50),
            createdAt: existing >= 0 ? chatSessions[existing].createdAt : Date.now(),
          };
          if (existing >= 0) {
            chatSessions[existing] = session;
          } else {
            chatSessions.unshift(session);
          }
          if (chatSessions.length > MAX_CHAT_SESSIONS) {
            chatSessions = chatSessions.slice(0, MAX_CHAT_SESSIONS);
          }
        }

        // Start fresh chat on this page
        currentChatId = generateChatId();
        chatConversationHistory = [];
        saveChatHistory();

      } else if (Array.isArray(oldHistory) && oldHistory.length > 0) {
        // Migration from old format: archive old history as one chat, start fresh
        chatSessions = [{
          id: generateChatId(),
          title: getChatTitle(oldHistory),
          messages: oldHistory.slice(-50),
          createdAt: Date.now(),
        }];
        currentChatId = generateChatId();
        chatConversationHistory = [];
        chrome.storage.local.remove(CHAT_OLD_STORAGE_KEY);
        saveChatHistory();

      } else {
        // No history at all: start fresh
        currentChatId = generateChatId();
        chatConversationHistory = [];
      }
    });
  } catch (e) { /* ignore */ }
}

// =============================================================================
// Message Handling
// =============================================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'SHOW_TOAST':
      showToast(message.state, message.data || {});
      sendResponse({ success: true });
      break;

    case 'HIDE_TOAST':
      hideToast();
      sendResponse({ success: true });
      break;

    case 'RUN_COMPOSE': {
      // Full compose workflow runs in content script to avoid service worker death
      (async () => {
        const { serverUrl, user, byok, preferredModel, tabUrl, sessionToken } = message;
        let composeId = null;
        try {
          // 1. Capture context
          cleanupStaleComposes();
          const context = extractPageContext();
          console.log('[RUN_COMPOSE] context: documentMode=' + (context && context.documentMode) + ', hasEditable=' + (context && context.hasEditable) + ', selectionMode=' + (context && context.selectionMode) + ', frame=' + (window === window.top ? 'TOP' : 'IFRAME'));
          if (!context || !context.hasEditable) {
            // In document editor pages, the editor may live in another frame.
            // If URL matches an adapter pattern but detect() failed, silently defer.
            const registry = globalThis.ComposeDocumentAdapterRegistry;
            if (registry && typeof registry.hasUrlMatch === 'function' && registry.hasUrlMatch()) {
              console.log('[RUN_COMPOSE] URL matches adapter pattern but no editor found in this frame — deferring to other frames');
              sendResponse({ success: false });
              return;
            }
            // Sub-frames without editables should stay silent
            if (window !== window.top) {
              console.log('[RUN_COMPOSE] Sub-frame with no editable — silently skipping');
              sendResponse({ success: false });
              return;
            }
            // Top frame with iframes present — editor may be in an iframe.
            // Silently defer instead of showing error toast.
            try {
              if (document.querySelectorAll('iframe').length > 0) {
                console.log('[RUN_COMPOSE] Top frame has ' + document.querySelectorAll('iframe').length + ' iframes but no editable — deferring');
                sendResponse({ success: false });
                return;
              }
            } catch (e) {}
            showToast('no-field');
            sendResponse({ success: false });
            return;
          }

          // Only show capturing toast once we know this frame owns the editor
          showToast('capturing');

          composeId = generateComposeId();
          const elementRef = lastFocusedEditable && document.body.contains(lastFocusedEditable)
            ? lastFocusedEditable : null;
          pendingComposes.set(composeId, {
            element: elementRef,
            locators: buildRobustLocators(elementRef),
            selector: context.selector,
            mode: 'compose',
            timestamp: Date.now()
          });
          _log(`[RUN_COMPOSE] composeId=${composeId}, element=${elementRef ? elementRef.tagName + '#' + (elementRef.id || '') + '(' + (elementRef.name || '') + ')' : 'NULL'}`);

          // 2. Show composing toast
          showToast('composing');

          // 3. Build request body
          const body = {
            user_id: user.user_id,
            user_name: user.name || '',
            url: tabUrl,
            container_html: context.containerHtml,
            page_context: context.pageContext,
            draft_text: context.draftText,
            compose_id: composeId,
            client_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
          };
          if (context.cursorCluster) body.cursor_cluster = context.cursorCluster;
          if (context.focusedFieldContext) body.focused_field_context = context.focusedFieldContext;
          if (byok) body.byok = byok;
          if (preferredModel) body.preferred_model = preferredModel;
          if (context.documentMode) {
            body.document_mode = true;
            body.document_title = context.documentTitle || '';
            body.selection_mode = context.selectionMode || 'full_document';
            if (context.cursorContext) body.cursor_context = context.cursorContext;
            if (context.fullDocumentText) body.full_document_text = context.fullDocumentText;
          }
          if (context.documentMode) {
            let docCtxStr = `[Document Editor Mode: ${context.selectionMode}]\n`;
            docCtxStr += `[Document Title]: ${context.documentTitle || 'Untitled'}\n`;
            if (context.selectionMode === 'selection' && context.cursorContext) {
              docCtxStr += `[Text Before Selection]: ...${(context.cursorContext.before || '').slice(-300)}\n`;
              docCtxStr += `[Text After Selection]: ${(context.cursorContext.after || '').slice(0, 300)}...\n`;
            }
            if (context.fullDocumentText) {
              docCtxStr += `[Full Document (for context)]: ${context.fullDocumentText.slice(0, 3000)}\n`;
            }
            body.page_context = docCtxStr + '\n' + (body.page_context || '');
          }

          // 4. API call — runs in content script, immune to service worker death
          _log(`[RUN_COMPOSE] Fetching ${serverUrl}/compose ...`);
          const fetchStart = Date.now();
          const composeHeaders = { 'Content-Type': 'application/json' };
          if (sessionToken) composeHeaders['Authorization'] = `Bearer ${sessionToken}`;
          const composeController = new AbortController();
          const composeTimer = setTimeout(() => composeController.abort(), 120000);
          let response;
          try {
            response = await fetch(`${serverUrl}/compose`, {
              method: 'POST',
              headers: composeHeaders,
              body: JSON.stringify(body),
              signal: composeController.signal
            });
          } catch (fetchErr) {
            clearTimeout(composeTimer);
            if (fetchErr.name === 'AbortError') {
              showToast('error', { message: 'Request timed out (2 min). Try again.' });
            } else {
              showToast('error', { message: fetchErr.message || 'Network error' });
            }
            pendingComposes.delete(composeId);
            sendResponse({ success: false });
            return;
          }
          clearTimeout(composeTimer);
          // Handle 401 — session expired
          if (response.status === 401) {
            showToast('error', { message: 'Session expired. Please sign in again.' });
            pendingComposes.delete(composeId);
            sendResponse({ success: false });
            return;
          }

          const result = await response.json();
          _log(`[RUN_COMPOSE] API returned in ${((Date.now() - fetchStart) / 1000).toFixed(1)}s, success=${result.success}`);

          if (!result.success) {
            showToast('error', { message: result.error || 'Composition failed' });
            pendingComposes.delete(composeId);
            sendResponse({ success: false });
            return;
          }

          // 5. Insert draft directly (no message passing needed)
          showToast('inserting');
          const entry = pendingComposes.get(composeId);
          let target = null;
          let insertSuccess = false;
          let fallback = null;
          let skipLegacyFallback = false;

          if (context.documentMode) {
            const docAdapter = globalThis.ComposeDocumentAdapterRegistry?.getAdapter();
            if (docAdapter) {
              const strategy = docAdapter.getWriteStrategy(context.selectionMode === 'selection');
              console.log('[RUN_COMPOSE] Document adapter write: strategy=' + strategy);
              if (strategy === 'replaceSelection') insertSuccess = await docAdapter.replaceSelection(result.draft);
              else if (strategy === 'writeAtCursor') insertSuccess = await docAdapter.writeAtCursor(result.draft);
              else insertSuccess = await docAdapter.replaceAll(result.draft);
              fallback = 'document-adapter';
              console.log('[RUN_COMPOSE] Document adapter write result: ' + insertSuccess);
            } else {
              console.warn('[RUN_COMPOSE] documentMode=true but no adapter found on re-check!');
            }
          }

          // Only run existing strategies if adapter didn't handle it
          if (!insertSuccess && !context.documentMode) {
          if (entry) {
            // Strategy 1: Direct element ref (skip search bars)
            if (entry.element && document.body.contains(entry.element) && isEditable(entry.element) && !isSearchField(entry.element)) {
              target = entry.element;
              _log(`[RUN_COMPOSE] Insert strategy 1 (direct ref): ${target.tagName}#${target.id || ''}`);
            }
            // Strategy 2: Robust locators
            if (!target && entry.locators && entry.locators.length > 0) {
              target = resolveLocators(entry.locators);
              if (target) { fallback = 'locator'; _log('[RUN_COMPOSE] Insert strategy 2 (locator)'); }
            }
            // Strategy 3: CSS selector
            if (!target && entry.selector) {
              try { target = document.querySelector(entry.selector); } catch (e) {}
              if (target && !isEditable(target)) target = null;
              if (target) { fallback = 'selector'; _log('[RUN_COMPOSE] Insert strategy 3 (selector)'); }
            }
            // Strategy 4: LinkedIn re-discovery
            if (!target && window.location.hostname.includes('linkedin')) {
              for (const sel of ['.msg-form__contenteditable [contenteditable="true"]', '.msg-form__contenteditable[contenteditable="true"]', '.msg-form [role="textbox"]', '.msg-form__contenteditable']) {
                try { const el = document.querySelector(sel); if (el && isEditable(el) && document.body.contains(el)) { target = el; fallback = 'linkedin'; break; } } catch (e) {}
              }
            }
          }
          } // end !insertSuccess && !context.documentMode

          if (target) {
            try { navigator.clipboard.writeText(result.draft).catch(() => {}); } catch (e) {}
            skipLegacyFallback = !!(
              target.isContentEditable ||
              target.getAttribute?.('contenteditable') === 'true' ||
              target.getAttribute?.('role') === 'textbox'
            );
            insertSuccess = await insertTextIntoTarget(target, result.draft);
            if (insertSuccess && skipLegacyFallback) fallback = 'trusted-input';
            _log(`[RUN_COMPOSE] insertTextIntoTarget: ${insertSuccess}`);
          }

          // Strategy 5: Legacy fallback
          if (!insertSuccess && !skipLegacyFallback && !context.documentMode) {
            insertSuccess = await insertDraft(result.draft, context.selector);
            if (insertSuccess) fallback = 'legacy';
            _log(`[RUN_COMPOSE] Legacy fallback: ${insertSuccess}`);
          }

          // Last resort: clipboard
          if (!insertSuccess && result.draft) {
            try { navigator.clipboard.writeText(result.draft).catch(() => {}); } catch (e) {}
            fallback = 'clipboard';
          }

          pendingComposes.delete(composeId);

          if (insertSuccess) {
            showToast('success', { message: 'Done!', credit_tier: result.credit_tier });
          } else {
            showToast('success', { message: 'Copied to clipboard — paste with Ctrl+V', credit_tier: result.credit_tier });
          }

          // Show one-time toast when credits just got exhausted
          if (result.credits_exhausted) {
            setTimeout(() => {
              showToast('error', { message: 'Your free $5 credits have been used up. You\'re now using free models. Add your own API key in Settings for premium models.' });
            }, 3500); // Show after success toast auto-hides
          }

          _log(`[RUN_COMPOSE] DONE: success=${insertSuccess}, fallback=${fallback}`);

          // 6. Notify background for post-processing (KG, logging, storage)
          // This is a new message event so background wakes up fresh
          try {
            chrome.runtime.sendMessage({
              type: 'COMPOSE_COMPLETE',
              result,
              url: tabUrl,
              draftText: context.draftText,
              composeId
            });
          } catch (e) {
            console.warn('[RUN_COMPOSE] Failed to notify background:', e.message);
          }

          sendResponse({ success: insertSuccess });
        } catch (error) {
          console.error('[RUN_COMPOSE] Error:', error);
          showToast('error', { message: error.message || 'Something went wrong' });
          if (composeId) pendingComposes.delete(composeId);
          sendResponse({ success: false, error: error.message });
        }
      })();
      return true; // async
    }

    case 'CAPTURE_CONTEXT': {
      cleanupStaleComposes();
      const context = extractPageContext();
      // Detect PDF pages — DOM is empty, server must handle via URL
      context.isPdf = isPdfPage();
      if (context.isPdf) {
        context.pdfUrl = window.location.href;
        _log('[CAPTURE_CONTEXT] PDF detected:', context.pdfUrl);
      }
      if (context.hasEditable) {
        const composeId = generateComposeId();
        const elementRef = lastFocusedEditable && document.body.contains(lastFocusedEditable)
          ? lastFocusedEditable : null;
        const locators = buildRobustLocators(elementRef);
        pendingComposes.set(composeId, {
          element: elementRef,
          locators: locators,
          selector: context.selector,
          mode: 'compose',
          timestamp: Date.now()
        });
        context.composeId = composeId;
        context.activeComposes = pendingComposes.size;
        _log(`[CAPTURE_CONTEXT] composeId=${composeId}, element=${elementRef ? elementRef.tagName + '#' + (elementRef.id || '') + '(' + (elementRef.name || '') + ')' : 'NULL'}, locators=${locators.length}, selector=${context.selector}`);
      } else {
        _log('[CAPTURE_CONTEXT] No editable found');
      }
      sendResponse(context);
      break;
    }

    case 'GET_SELECTION':
      const selectionInfo = getSelectionInfo();
      sendResponse(selectionInfo);
      break;

    case 'INSERT_DRAFT': {
      (async () => {
        try {
          _log(`[INSERT_DRAFT] Received! composeId=${message.composeId}, draft=${message.draft ? message.draft.substring(0, 60) + '...' : 'EMPTY'}, selector=${message.selector}`);
          let insertSuccess = false;
          let fallback = null;
          let skipLegacyFallback = false;
          const entry = message.composeId ? pendingComposes.get(message.composeId) : null;

          _log(`[INSERT_DRAFT] pendingComposes has ${pendingComposes.size} entries, entry found: ${!!entry}`);
          if (entry) {
            const age = Date.now() - entry.timestamp;
            _log(`[INSERT_DRAFT] Entry age: ${(age/1000).toFixed(1)}s, element: ${!!entry.element}, locators: ${entry.locators?.length || 0}, selector: ${entry.selector}`);

            let target = null;

            if (entry.element && document.body.contains(entry.element) && isEditable(entry.element)) {
              target = entry.element;
              _log(`[INSERT_DRAFT] Strategy 1 (direct ref): found ${target.tagName}#${target.id || ''}.${target.className || ''}`);
            } else if (entry.element) {
              _log(`[INSERT_DRAFT] Strategy 1 FAILED: inDOM=${document.body.contains(entry.element)}, editable=${isEditable(entry.element)}`);
            }

            if (!target && entry.locators && entry.locators.length > 0) {
              target = resolveLocators(entry.locators);
              if (target) {
                fallback = 'locator';
                _log(`[INSERT_DRAFT] Strategy 2 (locator): found ${target.tagName}#${target.id || ''}`);
              } else {
                _log(`[INSERT_DRAFT] Strategy 2 FAILED: tried ${entry.locators.length} locators`);
              }
            }

            if (!target && entry.selector) {
              try { target = document.querySelector(entry.selector); } catch (e) {}
              if (target && !isEditable(target)) target = null;
              if (target) {
                fallback = 'selector';
                _log(`[INSERT_DRAFT] Strategy 3 (selector): found via ${entry.selector}`);
              } else {
                _log(`[INSERT_DRAFT] Strategy 3 FAILED: selector=${entry.selector}`);
              }
            }

            if (!target && window.location.hostname.includes('linkedin')) {
              const linkedinSelectors = [
                '.msg-form__contenteditable [contenteditable="true"]',
                '.msg-form__contenteditable[contenteditable="true"]',
                '.msg-form [role="textbox"]',
                '.msg-form__contenteditable',
              ];
              for (const sel of linkedinSelectors) {
                try {
                  const el = document.querySelector(sel);
                  if (el && isEditable(el) && document.body.contains(el)) {
                    target = el;
                    fallback = 'linkedin-rediscovery';
                    break;
                  }
                } catch (e) {}
              }
            }

            if (target) {
              _log(`[INSERT_DRAFT] Writing to ${target.tagName}#${target.id || ''} (${target.name || 'no-name'}), fallback=${fallback || 'direct'}`);
              try { navigator.clipboard.writeText(message.draft).catch(() => {}); } catch (e) {}
              skipLegacyFallback = !!(
                target.isContentEditable ||
                target.getAttribute?.('contenteditable') === 'true' ||
                target.getAttribute?.('role') === 'textbox'
              );
              insertSuccess = await insertTextIntoTarget(target, message.draft);
              if (insertSuccess && skipLegacyFallback) fallback = 'trusted-input';
              _log(`[INSERT_DRAFT] insertTextIntoTarget returned: ${insertSuccess}`);
            } else {
              _log('[INSERT_DRAFT] All entry strategies failed, trying legacy fallback');
            }

            if (!insertSuccess && !skipLegacyFallback) {
              _log(`[INSERT_DRAFT] Strategy 5 (legacy): lastFocused=${!!lastFocusedEditable}, age=${lastFocusedEditable ? ((Date.now() - lastFocusedTimestamp)/1000).toFixed(1) + 's' : 'N/A'}`);
              insertSuccess = await insertDraft(message.draft, message.selector);
              if (insertSuccess) fallback = 'legacy-fallback';
              _log(`[INSERT_DRAFT] Strategy 5 result: ${insertSuccess}`);
            }
          } else {
            _log(`[INSERT_DRAFT] No entry for composeId=${message.composeId}, using legacy. pendingComposes keys: [${[...pendingComposes.keys()].join(', ')}]`);
            insertSuccess = await insertDraft(message.draft, message.selector);
            fallback = 'legacy';
          }

          if (!insertSuccess && message.draft) {
            try { navigator.clipboard.writeText(message.draft).catch(() => {}); } catch (e) {}
            fallback = 'clipboard';
          }

          _log(`[INSERT_DRAFT] FINAL: success=${insertSuccess}, fallback=${fallback}`);
          if (message.composeId) pendingComposes.delete(message.composeId);
          sendResponse({ success: insertSuccess, fallback });
        } catch (err) {
          console.error('[INSERT_DRAFT] Uncaught error:', err);
          try { navigator.clipboard.writeText(message.draft).catch(() => {}); } catch (e) {}
          if (message.composeId) pendingComposes.delete(message.composeId);
          sendResponse({ success: false, fallback: 'clipboard', error: err.message });
        }
      })();
      return true;
    }

    case 'SHOW_SELECTION_PROMPT':
      showSelectionPopover(message.data);
      sendResponse({ success: true });
      break;

    case 'INSERT_SELECTION_RESULT':
      const replaced = replaceSelection(message.rewrittenSelection, message.start, message.end);
      sendResponse({ success: replaced });
      break;

    case 'TOGGLE_CHAT':
      toggleChatBar();
      sendResponse({ success: true });
      break;

    case 'CAPTURE_PAGE_FIELDS': {
      // Richer field capture for agent mode — includes surrounding context
      const pageFields = findAllEditableElements();
      const richFields = pageFields.map(f => {
        // Walk up DOM to gather surrounding text context
        let surroundingText = '';
        let node = f.element;
        for (let i = 0; i < 4 && node && node !== document.body; i++) {
          node = node.parentElement;
          if (node) {
            const text = node.innerText || node.textContent || '';
            if (text.length > surroundingText.length && text.length < 2000) {
              surroundingText = text.trim();
            }
          }
        }
        return {
          selector: f.selector,
          label: f.label,
          placeholder: f.placeholder,
          fieldType: f.fieldType,
          currentValue: f.currentValue,
          surroundingText: surroundingText.substring(0, 300)
        };
      });
      sendResponse({
        fields: richFields,
        pageTitle: document.title,
        pageUrl: window.location.href,
        bodyText: (document.body.innerText || '').substring(0, 8000)
      });
      break;
    }

    case 'INSERT_ALL_FIELDS': {
      (async () => {
        let inserted = 0;
        let failed = 0;
        const fields = message.fields || [];
        for (const field of fields) {
          try {
            let el = null;
            if (field.selector) {
              try { el = document.querySelector(field.selector); } catch (e) {}
              if (!el) {
                const idMatch = field.selector.match(/#([^\s>.[\]]+)/) ||
                                field.selector.match(/#(.+)$/);
                if (idMatch) {
                  const rawId = idMatch[1].replace(/\\/g, '');
                  el = document.getElementById(rawId);
                }
              }
            }
            if (el && await insertTextIntoTarget(el, field.value)) {
              inserted++;
            } else {
              failed++;
            }
          } catch (e) {
            failed++;
          }
        }
        sendResponse({ success: true, inserted, failed });
      })();
      return true;
    }

    default:
      sendResponse({ error: 'Unknown message type' });
  }

  return true; // Keep channel open for async response
});

// =============================================================================
// Initialization
// =============================================================================

// Inject styles for toast (in case CSS file doesn't load)
const styleId = 'compose-assistant-styles';
if (!document.getElementById(styleId)) {
  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = `
    /* Toast */
    #compose-assistant-toast {
      position: fixed; bottom: 20px; right: 20px; padding: 12px 20px;
      background: rgba(255,255,255,0.88); backdrop-filter: blur(16px) saturate(180%);
      -webkit-backdrop-filter: blur(16px) saturate(180%); color: #0F172A;
      border-radius: 12px; border: 1px solid rgba(124,58,237,0.12);
      box-shadow: 0 4px 24px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04);
      z-index: 2147483647; font-family: 'Inter',-apple-system,BlinkMacSystemFont,system-ui,sans-serif;
      font-size: 14px; font-weight: 500; opacity: 0;
      transform: translateY(20px) scale(0.95);
      transition: opacity 0.3s cubic-bezier(0.16,1,0.3,1), transform 0.3s cubic-bezier(0.16,1,0.3,1);
      pointer-events: none; min-width: 140px;
    }
    #compose-assistant-toast.visible { opacity: 1; transform: translateY(0) scale(1); pointer-events: auto; }
    #compose-assistant-toast.hidden { opacity: 0; transform: translateY(20px) scale(0.95); pointer-events: none; }
    #compose-assistant-toast .toast-content { display: flex; align-items: center; gap: 10px; }
    #compose-assistant-toast .toast-icon { display: flex; align-items: center; justify-content: center; width: 20px; height: 20px; flex-shrink: 0; }
    #compose-assistant-toast .toast-icon svg { width: 16px; height: 16px; }
    #compose-assistant-toast .toast-message { white-space: nowrap; }
    #compose-assistant-toast.composing { border-left: 3px solid #7C3AED; }
    #compose-assistant-toast.success { border-left: 3px solid #059669; animation: ca-success-pulse 0.5s ease-out; }
    #compose-assistant-toast.success .toast-icon svg { stroke: #059669; }
    @keyframes ca-success-pulse {
      0% { box-shadow: 0 4px 24px rgba(0,0,0,0.06), 0 0 0 0 rgba(5,150,105,0.3); }
      50% { box-shadow: 0 4px 24px rgba(0,0,0,0.06), 0 0 0 8px rgba(5,150,105,0); }
      100% { box-shadow: 0 4px 24px rgba(0,0,0,0.06), 0 0 0 0 rgba(5,150,105,0); }
    }
    #compose-assistant-toast.error { border-left: 3px solid #DC2626; cursor: pointer; }
    #compose-assistant-toast.error:hover { background: rgba(255,255,255,0.95); }
    #compose-assistant-toast.error .toast-icon svg { stroke: #DC2626; }
    #compose-assistant-toast .spinner {
      width: 16px; height: 16px; border: 2px solid rgba(124,58,237,0.15);
      border-top-color: #7C3AED; border-radius: 50%; animation: compose-spin 0.8s linear infinite;
    }
    @keyframes compose-spin { to { transform: rotate(360deg); } }

    /* Selection Popover */
    #compose-selection-popover {
      position: fixed; z-index: 2147483647; min-width: 200px; max-width: 280px;
      background: rgba(255,255,255,0.92); backdrop-filter: blur(20px) saturate(180%);
      -webkit-backdrop-filter: blur(20px) saturate(180%);
      border: 1px solid rgba(124,58,237,0.12); border-radius: 12px; padding: 8px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.08), 0 2px 8px rgba(124,58,237,0.06);
      display: none; flex-direction: row; align-items: center; gap: 6px;
      font-family: 'Inter',-apple-system,BlinkMacSystemFont,system-ui,sans-serif;
    }
    #compose-selection-popover.visible { display: flex; }
    .selection-popover-content { display: flex; gap: 6px; align-items: center; width: 100%; }
    #selection-prompt-input {
      flex: 1; background: #FFFFFF; color: #0F172A; border: 1px solid #E2E8F0;
      border-radius: 8px; padding: 8px 12px; font-size: 13px;
      font-family: 'Inter',-apple-system,BlinkMacSystemFont,system-ui,sans-serif;
      outline: none; transition: border-color 0.15s, box-shadow 0.15s;
    }
    #selection-prompt-input:focus { border-color: #7C3AED; box-shadow: 0 0 0 3px rgba(124,58,237,0.12); }
    #selection-prompt-input::placeholder { color: #94A3B8; }
    .selection-submit-btn, #selection-submit-btn {
      width: 34px; height: 34px; background: linear-gradient(135deg,#7C3AED,#6D28D9);
      border: none; border-radius: 10px; display: flex; align-items: center; justify-content: center;
      cursor: pointer; flex-shrink: 0; transition: transform 0.15s, box-shadow 0.15s;
      box-shadow: 0 2px 8px rgba(124,58,237,0.25);
    }
    .selection-submit-btn:hover, #selection-submit-btn:hover {
      transform: scale(1.06); box-shadow: 0 4px 12px rgba(124,58,237,0.35);
    }
    .selection-submit-btn svg, #selection-submit-btn svg { width: 14px; height: 14px; fill: white; }

    /* Floating Chat Bar */
    #compose-assistant-chat {
      position: fixed; top: 60px; right: 20px; z-index: 2147483646;
      font-family: 'Inter',-apple-system,BlinkMacSystemFont,system-ui,sans-serif;
      font-size: 14px; color: #0F172A; -webkit-font-smoothing: antialiased;
    }

    /* FAB Toggle */
    #compose-assistant-chat .chat-bar-toggle {
      width: 52px; height: 52px; border-radius: 16px;
      background: linear-gradient(135deg,#7C3AED 0%,#5B21B6 100%);
      border: none; cursor: pointer; display: flex; align-items: center; justify-content: center;
      box-shadow: 0 4px 20px rgba(124,58,237,0.35), 0 0 0 0 rgba(124,58,237,0);
      transition: transform 0.2s cubic-bezier(0.16,1,0.3,1), box-shadow 0.3s ease;
      position: relative; overflow: hidden;
    }
    #compose-assistant-chat .chat-bar-toggle:hover {
      transform: scale(1.08);
      box-shadow: 0 6px 24px rgba(124,58,237,0.45), 0 0 0 4px rgba(124,58,237,0.1);
    }
    #compose-assistant-chat .chat-bar-toggle:active { transform: scale(0.95); }
    #compose-assistant-chat .chat-fab-ring {
      position: absolute; inset: -3px; border-radius: 19px;
      border: 2px solid rgba(255,255,255,0.2);
      animation: ca-fab-pulse 3s ease-in-out infinite; pointer-events: none;
    }
    @keyframes ca-fab-pulse {
      0%, 100% { opacity: 0; transform: scale(0.95); }
      50% { opacity: 1; transform: scale(1.05); }
    }
    #compose-assistant-chat.minimized .chat-bar-toggle { display: flex; }
    #compose-assistant-chat:not(.minimized) .chat-bar-toggle { display: none; }

    /* Container */
    #compose-assistant-chat .chat-bar-container {
      position: relative; width: 380px;
      background: rgba(255,255,255,0.92); backdrop-filter: blur(20px) saturate(180%);
      -webkit-backdrop-filter: blur(20px) saturate(180%);
      border-radius: 16px; border: 1px solid rgba(124,58,237,0.1);
      box-shadow: 0 8px 40px rgba(0,0,0,0.08), 0 2px 8px rgba(0,0,0,0.04),
                  0 0 0 1px rgba(255,255,255,0.6) inset;
      overflow: hidden; display: flex; flex-direction: column;
      max-height: calc(100vh - 100px);
    }
    #compose-assistant-chat.minimized .chat-bar-container { display: none; }

    /* Header */
    #compose-assistant-chat .chat-bar-header {
      display: flex; flex-direction: column; gap: 0; padding: 0; flex-shrink: 0;
      background: rgba(255,255,255,0.7); border-bottom: 1px solid rgba(124,58,237,0.08);
    }

    /* Title row */
    #compose-assistant-chat .chat-header-title-row {
      display: flex; align-items: center; justify-content: space-between; padding: 12px 14px 8px;
    }
    #compose-assistant-chat .chat-header-left { display: flex; align-items: center; gap: 10px; min-width: 0; }
    #compose-assistant-chat .chat-logo-icon {
      width: 28px; height: 28px; background: linear-gradient(135deg,#7C3AED,#5B21B6);
      border-radius: 8px; display: flex; align-items: center; justify-content: center;
      color: white; font-weight: 700; font-size: 10px; letter-spacing: 0.3px;
      flex-shrink: 0; box-shadow: 0 2px 6px rgba(124,58,237,0.25);
    }
    #compose-assistant-chat .chat-title-group { display: flex; flex-direction: column; min-width: 0; }
    #compose-assistant-chat .chat-title {
      font-weight: 700; font-size: 14px; color: #0F172A; white-space: nowrap;
      letter-spacing: -0.3px; line-height: 1.2;
    }
    #compose-assistant-chat .chat-host-display {
      font-size: 11px; color: #94A3B8; white-space: nowrap; overflow: hidden;
      text-overflow: ellipsis; max-width: 160px; line-height: 1.3;
    }

    /* Header action buttons */
    #compose-assistant-chat .chat-header-actions { display: flex; gap: 2px; }
    #compose-assistant-chat .chat-action-btn {
      width: 30px; height: 30px; display: flex; align-items: center; justify-content: center;
      background: transparent; border: none; border-radius: 8px; cursor: pointer;
      color: #94A3B8; transition: all 0.15s ease; flex-shrink: 0;
    }
    #compose-assistant-chat .chat-action-btn:hover { background: rgba(124,58,237,0.06); color: #7C3AED; }
    #compose-assistant-chat .chat-action-btn:active { transform: scale(0.9); }
    #compose-assistant-chat .chat-action-btn:disabled { opacity: 0.35; cursor: not-allowed; }
    #compose-assistant-chat .chat-action-btn svg { width: 15px; height: 15px; }

    /* Toolbar row */
    #compose-assistant-chat .chat-header-toolbar {
      display: flex; align-items: center; justify-content: space-between;
      padding: 0 10px 10px; gap: 8px;
    }

    /* Mode Segment Control */
    #compose-assistant-chat .chat-mode-segment {
      display: flex; background: #F1F5F9; border-radius: 10px; padding: 3px; gap: 2px; flex: 1;
    }
    #compose-assistant-chat .chat-mode-tab {
      display: flex; align-items: center; justify-content: center; gap: 5px; flex: 1;
      padding: 5px 8px; border: none; border-radius: 8px; background: transparent;
      color: #64748B; font-family: inherit; font-size: 11px; font-weight: 500;
      cursor: pointer; transition: all 0.2s cubic-bezier(0.16,1,0.3,1);
      white-space: nowrap; line-height: 1;
    }
    #compose-assistant-chat .chat-mode-tab:hover { color: #475569; background: rgba(255,255,255,0.5); }
    #compose-assistant-chat .chat-mode-tab.active {
      background: #FFFFFF; color: #7C3AED; font-weight: 600;
      box-shadow: 0 1px 3px rgba(0,0,0,0.06), 0 0 0 1px rgba(124,58,237,0.08);
    }
    #compose-assistant-chat .chat-mode-tab svg { flex-shrink: 0; }
    #compose-assistant-chat .chat-mode-tab.active svg { stroke: #7C3AED; }

    /* Toolbar action buttons */
    #compose-assistant-chat .chat-toolbar-actions { display: flex; gap: 1px; }

    /* Legacy compat for old class names */
    #compose-assistant-chat .chat-close-btn,
    #compose-assistant-chat .chat-clear-btn,
    #compose-assistant-chat .chat-capture-btn,
    #compose-assistant-chat .chat-memories-btn,
    #compose-assistant-chat .chat-history-btn {
      width: 30px; height: 30px; display: flex; align-items: center; justify-content: center;
      background: transparent; border: none; border-radius: 8px; cursor: pointer;
      color: #94A3B8; transition: all 0.15s ease; flex-shrink: 0;
    }
    #compose-assistant-chat .chat-close-btn:hover,
    #compose-assistant-chat .chat-clear-btn:hover,
    #compose-assistant-chat .chat-capture-btn:hover,
    #compose-assistant-chat .chat-memories-btn:hover,
    #compose-assistant-chat .chat-history-btn:hover { background: rgba(124,58,237,0.06); color: #7C3AED; }
    #compose-assistant-chat .chat-close-btn svg,
    #compose-assistant-chat .chat-clear-btn svg,
    #compose-assistant-chat .chat-capture-btn svg,
    #compose-assistant-chat .chat-memories-btn svg,
    #compose-assistant-chat .chat-history-btn svg { width: 14px; height: 14px; stroke: currentColor; }
    #compose-assistant-chat .chat-capture-btn:disabled { opacity: 0.35; cursor: not-allowed; }

    /* Hidden select for mode compat */
    #compose-assistant-chat .chat-mode-select { display: none; }
    #compose-assistant-chat .chat-mode-wrapper { display: none; }

    /* Messages area */
    #compose-assistant-chat .chat-bar-messages {
      overflow-y: auto; padding: 16px 14px; display: flex; flex-direction: column; gap: 10px;
      background: linear-gradient(180deg, rgba(247,243,253,0.3) 0%, rgba(255,255,255,0) 100%);
    }
    #compose-assistant-chat.collapsed .chat-bar-messages { display: none; }
    #compose-assistant-chat.expanded .chat-bar-messages { max-height: 340px; display: flex; flex-shrink: 1; min-height: 60px; }

    /* Welcome */
    #compose-assistant-chat .chat-welcome {
      display: flex; flex-direction: column; align-items: center; gap: 8px;
      padding: 24px 20px; text-align: center;
    }
    #compose-assistant-chat .chat-welcome-icon {
      width: 48px; height: 48px;
      background: linear-gradient(135deg, rgba(124,58,237,0.08), rgba(124,58,237,0.02));
      border-radius: 14px; display: flex; align-items: center; justify-content: center;
    }
    #compose-assistant-chat .chat-welcome-icon svg { stroke: #7C3AED; opacity: 0.7; }
    #compose-assistant-chat .chat-welcome-title {
      font-size: 15px; font-weight: 600; color: #0F172A; letter-spacing: -0.3px;
    }
    #compose-assistant-chat .chat-welcome-text { font-size: 12px; line-height: 1.5; color: #64748B; max-width: 260px; }
    #compose-assistant-chat .chat-welcome-text strong { color: #7C3AED; font-weight: 600; }

    /* Message bubbles */
    #compose-assistant-chat .chat-message {
      padding: 10px 14px; border-radius: 14px; max-width: 88%;
      line-height: 1.5; word-wrap: break-word; overflow-wrap: break-word;
      font-size: 13px; animation: ca-msg-in 0.25s cubic-bezier(0.16,1,0.3,1);
    }
    @keyframes ca-msg-in {
      from { opacity: 0; transform: translateY(6px) scale(0.97); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    #compose-assistant-chat .chat-message-user {
      background: linear-gradient(135deg,#7C3AED,#6D28D9); color: white;
      align-self: flex-end; border-bottom-right-radius: 6px;
      box-shadow: 0 2px 8px rgba(124,58,237,0.2);
    }
    #compose-assistant-chat .chat-message-assistant {
      background: #FFFFFF; color: #1E293B; align-self: flex-start; border-bottom-left-radius: 6px;
      border: 1px solid rgba(124,58,237,0.08); box-shadow: 0 1px 3px rgba(0,0,0,0.04);
    }
    #compose-assistant-chat .chat-message-system {
      background: rgba(220,38,38,0.04); color: #DC2626; font-size: 11px; font-weight: 500;
      text-align: center; align-self: center; padding: 4px 12px; border-radius: 20px;
      border: 1px solid rgba(220,38,38,0.08);
    }
    #compose-assistant-chat .chat-message pre {
      background: #F8FAFC; padding: 8px 10px; border-radius: 8px; overflow-x: auto;
      margin: 6px 0; font-size: 12px; border: 1px solid #E2E8F0;
    }
    #compose-assistant-chat .chat-message code {
      background: rgba(124,58,237,0.06); padding: 2px 5px; border-radius: 4px;
      font-size: 12px; font-family: 'SF Mono','Cascadia Code','Fira Code',Consolas,monospace; color: #6D28D9;
    }
    #compose-assistant-chat .chat-message pre code { background: none; padding: 0; color: #334155; }
    #compose-assistant-chat .chat-message a { color: #7C3AED; text-decoration: underline; text-underline-offset: 2px; }
    #compose-assistant-chat .chat-message strong { font-weight: 600; color: #0F172A; }
    #compose-assistant-chat .chat-sources {
      font-size: 10px; color: #7C3AED; padding: 2px 8px; align-self: flex-start; opacity: 0.7; font-weight: 500;
    }

    /* Input area */
    #compose-assistant-chat .chat-bar-input-area {
      display: flex; align-items: flex-end; gap: 8px; padding: 12px 14px;
      border-top: 1px solid rgba(124,58,237,0.06); flex-shrink: 0;
      background: rgba(255,255,255,0.8);
    }
    #compose-assistant-chat .chat-input {
      flex: 1; min-width: 0; background: #F8FAFC; border: 1px solid #E2E8F0;
      border-radius: 12px; min-height: 40px; max-height: 120px;
      outline: none; overflow: hidden;
      transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
    }
    #compose-assistant-chat .chat-send-btn {
      width: 36px; height: 36px; background: linear-gradient(135deg,#7C3AED,#5B21B6);
      border: none; border-radius: 10px; display: flex; align-items: center; justify-content: center;
      cursor: pointer; flex-shrink: 0; transition: transform 0.15s, box-shadow 0.15s;
      box-shadow: 0 2px 8px rgba(124,58,237,0.2);
    }
    #compose-assistant-chat .chat-send-btn:hover {
      transform: scale(1.06); box-shadow: 0 4px 12px rgba(124,58,237,0.3);
    }
    #compose-assistant-chat .chat-send-btn:active { transform: scale(0.95); }
    #compose-assistant-chat .chat-send-btn svg { width: 15px; height: 15px; stroke: white; fill: none; }

    /* Upload button */
    #compose-assistant-chat .chat-upload-btn {
      width: 36px; height: 36px; min-width: 36px; background: transparent; border: 1px solid #E2E8F0;
      border-radius: 10px; display: flex; align-items: center; justify-content: center;
      cursor: pointer !important; flex-shrink: 0; transition: all 0.15s ease; color: #64748B;
      align-self: center; padding: 0;
    }
    #compose-assistant-chat .chat-upload-btn:hover {
      background: #F3E8FF; border-color: #7C3AED; color: #7C3AED;
      transform: scale(1.06); box-shadow: 0 2px 8px rgba(124,58,237,0.15);
    }
    #compose-assistant-chat .chat-upload-btn:active { transform: scale(0.95); }
    #compose-assistant-chat .chat-upload-btn svg { stroke: currentColor; width: 16px; height: 16px; }

    /* File chip */
    #compose-assistant-chat .chat-file-chip-container {
      display: none; padding: 0 14px 4px; align-items: center;
    }
    #compose-assistant-chat .chat-file-chip {
      display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px;
      background: #F3E8FF; border: 1px solid #E9D5FF; border-radius: 8px;
      font-size: 11px; color: #7C3AED; max-width: 100%;
    }
    #compose-assistant-chat .chat-file-chip span {
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    #compose-assistant-chat .chat-file-chip-remove {
      background: none; border: none; color: #7C3AED; cursor: pointer;
      font-size: 14px; font-weight: bold; padding: 0 2px; line-height: 1;
    }
    #compose-assistant-chat .chat-file-chip-remove:hover { color: #5B21B6; }

    /* Typing indicator */
    #compose-assistant-chat .typing-dots { display: flex; gap: 4px; padding: 4px 0; }
    #compose-assistant-chat .typing-dots span {
      width: 6px; height: 6px; background: #7C3AED; border-radius: 50%;
      animation: ca-typing-bounce 1.2s infinite;
    }
    #compose-assistant-chat .typing-dots span:nth-child(2) { animation-delay: 0.15s; }
    #compose-assistant-chat .typing-dots span:nth-child(3) { animation-delay: 0.3s; }
    @keyframes ca-typing-bounce {
      0%, 80%, 100% { transform: translateY(0); opacity: 0.4; }
      40% { transform: translateY(-6px); opacity: 1; }
    }

    /* Scrollbar */
    #compose-assistant-chat .chat-bar-messages::-webkit-scrollbar { width: 5px; }
    #compose-assistant-chat .chat-bar-messages::-webkit-scrollbar-track { background: transparent; }
    #compose-assistant-chat .chat-bar-messages::-webkit-scrollbar-thumb { background: rgba(124,58,237,0.12); border-radius: 10px; }
    #compose-assistant-chat .chat-bar-messages::-webkit-scrollbar-thumb:hover { background: rgba(124,58,237,0.25); }

    /* Resize handle */
    #compose-assistant-chat .chat-bar-resize-handle {
      position: absolute; bottom: 0; right: 0; width: 18px; height: 18px;
      cursor: nwse-resize; background: transparent;
    }
    #compose-assistant-chat .chat-bar-resize-handle::after {
      content: ''; position: absolute; bottom: 4px; right: 4px;
      width: 8px; height: 8px; border-right: 2px solid #CBD5E1;
      border-bottom: 2px solid #CBD5E1; transition: border-color 0.15s;
    }
    #compose-assistant-chat .chat-bar-resize-handle:hover::after { border-color: #7C3AED; }

    /* Chat History Dropdown */
    #compose-assistant-chat .chat-history-dropdown {
      display: none; background: rgba(255,255,255,0.96);
      backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
      border-bottom: 1px solid rgba(124,58,237,0.08); max-height: 220px; overflow-y: auto;
    }
    #compose-assistant-chat .chat-history-item {
      padding: 10px 14px; cursor: pointer; border-bottom: 1px solid #F1F5F9;
      display: flex; align-items: center; gap: 8px; transition: background 0.12s;
    }
    #compose-assistant-chat .chat-history-item:hover { background: rgba(124,58,237,0.03); }
    #compose-assistant-chat .chat-history-item:last-child { border-bottom: none; }
    #compose-assistant-chat .chat-history-item-title {
      font-size: 12px; color: #1E293B; flex: 1; overflow: hidden;
      text-overflow: ellipsis; white-space: nowrap; font-weight: 500;
    }
    #compose-assistant-chat .chat-history-item-date { font-size: 10px; color: #94A3B8; white-space: nowrap; font-weight: 400; }
    #compose-assistant-chat .chat-history-item-delete {
      background: none; border: none; color: #CBD5E1; cursor: pointer;
      padding: 2px 5px; font-size: 14px; border-radius: 6px; line-height: 1; transition: all 0.12s;
    }
    #compose-assistant-chat .chat-history-item-delete:hover { background: #DC2626; color: #fff; }
    #compose-assistant-chat .chat-history-empty { font-size: 12px; color: #94A3B8; padding: 16px; text-align: center; }

    /* Feedback Form */
    #compose-assistant-chat .feedback-form-panel {
      padding: 12px; border: 1px solid rgba(124,58,237,0.08); border-radius: 12px; margin: 8px 14px;
      background: rgba(255,255,255,0.95); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
    }
    #compose-assistant-chat .feedback-form-header {
      font-size: 13px; font-weight: 600; color: #1E293B; margin-bottom: 10px;
    }
    #compose-assistant-chat .feedback-category {
      width: 100%; padding: 6px 8px; border: 1px solid #E2E8F0; border-radius: 6px;
      font-size: 12px; color: #1E293B; background: #fff; margin-bottom: 8px; outline: none;
      font-family: inherit;
    }
    #compose-assistant-chat .feedback-category:focus { border-color: #7C3AED; }
    #compose-assistant-chat .feedback-message {
      width: 100%; padding: 8px; border: 1px solid #E2E8F0; border-radius: 6px;
      font-size: 12px; color: #1E293B; background: #fff; resize: vertical; outline: none;
      font-family: inherit; min-height: 60px;
    }
    #compose-assistant-chat .feedback-message:focus { border-color: #7C3AED; }
    #compose-assistant-chat .feedback-actions {
      display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px;
    }
    #compose-assistant-chat .feedback-cancel {
      padding: 5px 12px; border: 1px solid #E2E8F0; border-radius: 6px; background: #fff;
      color: #64748B; font-size: 12px; cursor: pointer; font-family: inherit;
    }
    #compose-assistant-chat .feedback-cancel:hover { background: #F8FAFC; }
    #compose-assistant-chat .feedback-submit {
      padding: 5px 12px; border: none; border-radius: 6px; background: #7C3AED;
      color: #fff; font-size: 12px; cursor: pointer; font-weight: 500; font-family: inherit;
    }
    #compose-assistant-chat .feedback-submit:hover { background: #6D28D9; }
    #compose-assistant-chat .feedback-submit:disabled { opacity: 0.6; cursor: not-allowed; }
    #compose-assistant-chat .feedback-status {
      font-size: 11px; margin-top: 8px; text-align: center;
    }

    @media (max-width: 480px) {
      #compose-assistant-chat .chat-bar-container { width: calc(100vw - 40px); }
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

// On PDF pages, auto-create the chat bar so the FAB bubble is visible immediately.
// Normal pages create it lazily on first toggle.
if (isPdfPage()) {
  createChatBar();
  _log('[COMPOSE] PDF page detected — chat bar auto-created');
}

_log('Compose Assistant content script loaded');
