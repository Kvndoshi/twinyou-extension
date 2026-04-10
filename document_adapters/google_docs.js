(function initGoogleDocsAdapter(globalObject) {
  var EDITOR_SELECTORS = [
    '.kix-appview-editor',
    '.kix-appview-editor-container',
    '#kix-appview',
    '.docs-editor-container',
  ];
  var PARAGRAPH_SELECTOR = '.kix-paragraphrenderer';
  var TITLE_SELECTOR = '.docs-title-input';
  var EVENT_TARGET_IFRAME_SELECTOR = '.docs-texteventtarget-iframe';
  var CURSOR_SELECTOR = '.kix-cursor';

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

  /**
   * Returns the contentDocument inside the text-event target iframe, or null if
   * cross-origin / unavailable.
   */
  function getEventTargetDocument() {
    var doc = getDocument();
    if (!doc) return null;
    var iframe = doc.querySelector(EVENT_TARGET_IFRAME_SELECTOR);
    if (!iframe) return null;
    try {
      return iframe.contentDocument || iframe.contentWindow.document || null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Attempts to show a toast notification via the extension's existing toast
   * mechanism if available, otherwise falls back to console.warn.
   */
  function showToast(message) {
    if (globalObject.ComposeUI && typeof globalObject.ComposeUI.showToast === 'function') {
      globalObject.ComposeUI.showToast(message);
    } else {
      // Best-effort: log so developers can see fallback reason.
      /* eslint-disable-next-line no-console */
      console.warn('[GoogleDocsAdapter] ' + message);
    }
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
    // Last resort: look for canvas element inside docs content area
    var canvas = doc.querySelector('.kix-canvas-tile-content canvas');
    if (canvas) return canvas.closest('.kix-appview-editor') || canvas.parentElement;
    return null;
  }

  function detect() {
    var found = !!findEditorElement();
    // Also detect by paragraph presence (canvas docs still have paragraph renderers)
    if (!found) {
      var doc = getDocument();
      found = !!(doc && doc.querySelectorAll(PARAGRAPH_SELECTOR).length > 0);
    }
    console.log('[ComposeAdapter:GoogleDocs] detect()=' + found + ', url=' + (globalObject.location && globalObject.location.href || '').substring(0, 80));
    return found;
  }

  function getEditorElement() {
    return findEditorElement();
  }

  /**
   * Reads the full document body text.
   *
   * Primary strategy: collect all .kix-paragraphrenderer elements and join
   * their textContent with newlines.  This is partial for very long docs
   * (lazily rendered) but acceptable for MVP.
   *
   * Fallback: SVG accessibility layer — g[role="paragraph"] aria-label attrs.
   *
   * @returns {string}
   */
  function readFullContent() {
    var doc = getDocument();
    if (!doc) return '';

    // Primary: paragraph renderers.
    var paragraphs = doc.querySelectorAll(PARAGRAPH_SELECTOR);
    if (paragraphs && paragraphs.length > 0) {
      var lines = [];
      for (var i = 0; i < paragraphs.length; i++) {
        lines.push(paragraphs[i].textContent || '');
      }
      var text = lines.join('\n');
      if (text.length > 15000) {
        text = text.substring(0, 15000) + '\n... [document truncated]';
      }
      return text;
    }

    // Fallback: SVG aria-label attributes on paragraph rects.
    var ariaRects = doc.querySelectorAll('g[role="paragraph"] rect[aria-label]');
    if (ariaRects && ariaRects.length > 0) {
      var ariaLines = [];
      for (var j = 0; j < ariaRects.length; j++) {
        ariaLines.push(ariaRects[j].getAttribute('aria-label') || '');
      }
      return ariaLines.join('\n');
    }

    return '';
  }

  /**
   * Returns selected text from within the event-target iframe if accessible,
   * or null otherwise.
   * @returns {string|null}
   */
  function readSelection() {
    var iframeDoc = getEventTargetDocument();
    if (iframeDoc) {
      var iframeWindow = iframeDoc.defaultView;
      if (iframeWindow && typeof iframeWindow.getSelection === 'function') {
        var sel = iframeWindow.getSelection();
        if (sel && !sel.isCollapsed) {
          var text = sel.toString();
          if (text) return text;
        }
      }
    }

    // Fallback: top-level selection.
    var topSel = getSelection();
    if (topSel && !topSel.isCollapsed) {
      var topText = topSel.toString();
      if (topText) return topText;
    }

    return null;
  }

  function hasSelection() {
    return readSelection() !== null;
  }

  /**
   * Builds cursor context by locating the .kix-cursor element and mapping it
   * to paragraph renderers for before/after text split.
   * @returns {{before: string, after: string, selectedText: string}}
   */
  function getCursorContext() {
    var doc = getDocument();
    if (!doc) return { before: '', after: '', selectedText: '' };

    var selectedText = readSelection() || '';
    var paragraphs = doc.querySelectorAll(PARAGRAPH_SELECTOR);
    if (!paragraphs || paragraphs.length === 0) {
      return { before: '', after: '', selectedText: selectedText };
    }

    // Find which paragraph contains the cursor element.
    var cursor = doc.querySelector(CURSOR_SELECTOR);
    var splitIndex = -1;

    if (cursor) {
      for (var i = 0; i < paragraphs.length; i++) {
        if (paragraphs[i].contains(cursor)) {
          splitIndex = i;
          break;
        }
      }
    }

    // If we couldn't locate cursor, use the last paragraph as split point.
    if (splitIndex < 0) {
      splitIndex = paragraphs.length - 1;
    }

    var beforeLines = [];
    for (var b = 0; b <= splitIndex; b++) {
      beforeLines.push(paragraphs[b].textContent || '');
    }
    var beforeText = beforeLines.join('\n');
    if (beforeText.length > 500) {
      beforeText = beforeText.slice(-500);
    }

    var afterLines = [];
    for (var a = splitIndex + 1; a < paragraphs.length; a++) {
      afterLines.push(paragraphs[a].textContent || '');
    }
    var afterText = afterLines.join('\n');
    if (afterText.length > 500) {
      afterText = afterText.slice(0, 500);
    }

    return { before: beforeText, after: afterText, selectedText: selectedText };
  }

  function getDocumentTitle() {
    var doc = getDocument();
    if (!doc) return '';
    var titleEl = doc.querySelector(TITLE_SELECTOR);
    if (!titleEl) return '';
    return (titleEl.value !== undefined ? titleEl.value : titleEl.textContent) || '';
  }

  // -------------------------------------------------------------------------
  // Writing helpers
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Writing — uses CDP (Chrome DevTools Protocol) via background.js for
  // trusted keyboard input. Google Docs canvas ignores synthetic DOM events
  // but accepts trusted input dispatched through CDP's Input domain.
  // Falls back to clipboard if debugger permission is not available.
  // -------------------------------------------------------------------------

  /**
   * Copies text to clipboard, then uses CDP to dispatch Ctrl+A + Ctrl+V.
   * Google Docs' own event handlers process Ctrl+A (select all) and Ctrl+V (paste)
   * which correctly interacts with the internal document model.
   * @param {string} text
   * @param {boolean} selectAll - if true, does Ctrl+A before Ctrl+V
   * @returns {Promise<boolean>}
   */
  async function trustedWrite(text, selectAll) {
    try {
      // 1. Write text to real system clipboard FIRST
      await globalObject.navigator.clipboard.writeText(text);
    } catch (e) {
      console.warn('[ComposeAdapter:GoogleDocs] clipboard write failed:', e);
      return false;
    }

    try {
      var chrome = globalObject.chrome;
      if (!chrome || !chrome.runtime || !chrome.runtime.sendMessage) {
        return false;
      }

      // 2. Get editor position for click-to-focus
      var editorEl = findEditorElement();
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
      console.log('[ComposeAdapter:GoogleDocs] pasteReplace: selectAll=' + selectAll + ', result=' + JSON.stringify(result));
      if (result && result.success) return true;
    } catch (e) {
      console.warn('[ComposeAdapter:GoogleDocs] pasteReplace error:', e);
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
    registry.registerAdapter(/docs\.google\.com\/document/, buildAdapter);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
