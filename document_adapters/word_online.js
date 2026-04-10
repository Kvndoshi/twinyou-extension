(function initWordOnlineAdapter(globalObject) {
  var EDITOR_SELECTORS = [
    '#WACViewPanel_EditingElement',
    '[class*="WACViewPanel"] [contenteditable="true"]',
    '.WACEditing[contenteditable="true"]',
    '[data-automation-id="editor"] [contenteditable="true"]',
    '[class*="EditingElement"] [contenteditable="true"]',
  ];
  var TITLE_SELECTORS = [
    '#WACTitleCell',
    '[class*="TitleCell"] input',
    '[class*="FileNameText"]',
  ];

  // -------------------------------------------------------------------------
  // Helper utilities
  // -------------------------------------------------------------------------

  function getDocument() {
    return globalObject.document || null;
  }

  function getSelection() {
    return (
      (typeof globalObject.getSelection === 'function' && globalObject.getSelection()) ||
      (globalObject.window && typeof globalObject.window.getSelection === 'function' && globalObject.window.getSelection()) ||
      null
    );
  }

  // -------------------------------------------------------------------------
  // Adapter implementation
  // -------------------------------------------------------------------------

  function findEditorElement() {
    var doc = getDocument();
    if (!doc) return null;
    for (var i = 0; i < EDITOR_SELECTORS.length; i++) {
      try {
        var el = doc.querySelector(EDITOR_SELECTORS[i]);
        if (el) return el;
      } catch (e) {}
    }
    return null;
  }

  function detect() {
    var found = !!findEditorElement();
    console.log('[ComposeAdapter:WordOnline] detect()=' + found + ', url=' + (globalObject.location && globalObject.location.href || '').substring(0, 80));
    return found;
  }

  function getEditorElement() {
    return findEditorElement();
  }

  function readFullContent() {
    var editor = getEditorElement();
    if (!editor) return '';
    // Use textContent (raw text, fast) instead of innerText (layout-aware, can be very slow)
    var text = editor.textContent || '';
    // Truncate to prevent sending massive documents
    if (text.length > 15000) {
      text = text.substring(0, 15000) + '\n... [document truncated]';
    }
    return text;
  }

  /**
   * Returns the selected text if the selection anchor is inside the editor,
   * otherwise returns null.
   */
  function readSelection() {
    var editor = getEditorElement();
    if (!editor) return null;

    var sel = getSelection();
    if (!sel || sel.isCollapsed) return null;

    var text = sel.toString();
    if (!text) return null;

    // Validate that the selection is inside the editor element.
    var anchorNode = sel.anchorNode;
    if (!anchorNode) return null;

    var node = anchorNode.nodeType === 3 ? anchorNode.parentElement : anchorNode;
    if (editor.contains(node)) {
      return text;
    }
    return null;
  }

  function hasSelection() {
    var sel = getSelection();
    if (!sel || sel.isCollapsed) return false;
    var editor = getEditorElement();
    if (!editor) return false;
    var anchorNode = sel.anchorNode;
    if (!anchorNode) return false;
    var node = anchorNode.nodeType === 3 ? anchorNode.parentElement : anchorNode;
    return editor.contains(node);
  }

  /**
   * Uses Range API to get ~500 chars before and after the cursor inside the editor.
   * @returns {{before: string, after: string, selectedText: string}}
   */
  function getCursorContext() {
    var editor = getEditorElement();
    if (!editor) return { before: '', after: '', selectedText: '' };

    var doc = getDocument();
    if (!doc || typeof doc.createRange !== 'function') {
      return { before: '', after: '', selectedText: '' };
    }

    var sel = getSelection();
    if (!sel || sel.rangeCount === 0) {
      return { before: '', after: '', selectedText: '' };
    }

    var selRange;
    try {
      selRange = sel.getRangeAt(0);
    } catch (e) {
      return { before: '', after: '', selectedText: '' };
    }

    var selectedText = selRange.toString();

    // Range from start of editor to selection start.
    var beforeRange = doc.createRange();
    try {
      beforeRange.setStart(editor, 0);
      beforeRange.setEnd(selRange.startContainer, selRange.startOffset);
    } catch (e) {
      return { before: '', after: '', selectedText: selectedText };
    }
    var beforeText = beforeRange.toString();
    if (beforeText.length > 500) {
      beforeText = beforeText.slice(-500);
    }

    // Range from selection end to end of editor.
    var afterRange = doc.createRange();
    try {
      afterRange.setStart(selRange.endContainer, selRange.endOffset);
      afterRange.setEnd(editor, editor.childNodes.length);
    } catch (e) {
      return { before: beforeText, after: '', selectedText: selectedText };
    }
    var afterText = afterRange.toString();
    if (afterText.length > 500) {
      afterText = afterText.slice(0, 500);
    }

    return { before: beforeText, after: afterText, selectedText: selectedText };
  }

  function getDocumentTitle() {
    var doc = getDocument();
    if (!doc) return '';
    for (var i = 0; i < TITLE_SELECTORS.length; i++) {
      var el = doc.querySelector(TITLE_SELECTORS[i]);
      if (el) {
        return (el.value !== undefined ? el.value : el.textContent) || '';
      }
    }
    return '';
  }

  /**
   * Copies text to clipboard, then uses CDP to dispatch Ctrl+A + Ctrl+V.
   * Word Online's own event handlers process these correctly.
   * @param {string} text
   * @param {boolean} selectAll - if true, does Ctrl+A before Ctrl+V
   * @returns {Promise<boolean>}
   */
  async function trustedWrite(text, selectAll) {
    try {
      // 1. Write text to real system clipboard FIRST
      await globalObject.navigator.clipboard.writeText(text);
    } catch (e) {
      console.warn('[ComposeAdapter:WordOnline] clipboard write failed:', e);
      return false;
    }

    try {
      var chrome = globalObject.chrome;
      if (!chrome || !chrome.runtime || !chrome.runtime.sendMessage) {
        return false;
      }

      // 2. Get editor position for click-to-focus
      var editorEl = getEditorElement();
      var point = null;
      if (editorEl) {
        var rect = editorEl.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          point = {
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
          };
        }
      }

      // 3. Send TRUSTED_PASTE_REPLACE
      // For replaceAll: send coordinates so background clicks editor before Ctrl+A
      // For replaceSelection: don't send coordinates — preserves user's selection
      var result = await new Promise(function (resolve) {
        chrome.runtime.sendMessage({
          type: 'TRUSTED_PASTE_REPLACE',
          selectAll: selectAll,
          x: selectAll && point ? point.x : 0,
          y: selectAll && point ? point.y : 0,
        }, function (resp) {
          resolve(resp || { success: false });
        });
      });
      console.log('[ComposeAdapter:WordOnline] pasteReplace: selectAll=' + selectAll + ', result=' + JSON.stringify(result));
      if (result && result.success) return true;
    } catch (e) {
      console.warn('[ComposeAdapter:WordOnline] pasteReplace error:', e);
    }
    return false;
  }

  async function writeAtCursor(text) { return trustedWrite(text, false); }
  async function replaceSelection(text) { return trustedWrite(text, false); }
  async function replaceAll(text) { return trustedWrite(text, true); }

  /**
   * @param {boolean} hasSelectionFlag
   * @returns {'replaceSelection'|'replaceAll'|'writeAtCursor'}
   */
  function getWriteStrategy(hasSelectionFlag) {
    if (hasSelectionFlag) return 'replaceSelection';
    return 'replaceAll';
  }

  // -------------------------------------------------------------------------
  // Build adapter via the base factory and self-register with the registry.
  // -------------------------------------------------------------------------

  function buildAdapter() {
    var base = globalObject.ComposeDocumentAdapterBase;
    if (base && typeof base.createAdapter === 'function') {
      return base.createAdapter({
        detect,
        getEditorElement,
        readFullContent,
        readSelection,
        hasSelection,
        getCursorContext,
        getDocumentTitle,
        writeAtCursor,
        replaceSelection,
        replaceAll,
        getWriteStrategy,
      });
    }

    // Fallback: plain object if base_adapter hasn't loaded yet (shouldn't happen).
    return {
      detect,
      getEditorElement,
      readFullContent,
      readSelection,
      hasSelection,
      getCursorContext,
      getDocumentTitle,
      writeAtCursor,
      replaceSelection,
      replaceAll,
      getWriteStrategy,
    };
  }

  var registry = globalObject.ComposeDocumentAdapterRegistry;
  if (registry && typeof registry.registerAdapter === 'function') {
    registry.registerAdapter(/officeapps\.live\.com|word-edit\.officeapps/i, buildAdapter);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
