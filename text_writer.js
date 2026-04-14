(function initComposeTextWriter(globalObject) {
  function normalizeWriteText(text) {
    return String(text ?? '').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
  }

  function getContentEditableRoot(el, documentRef) {
    let root = el;
    let node = el;
    while (node && node !== documentRef?.body) {
      if (node.getAttribute?.('contenteditable') === 'true') {
        root = node;
      }
      node = node.parentElement;
    }
    return root;
  }

  // Subtrees that represent quoted / cited history (Gmail thread replies, forwarded
  // messages, other email clients). Anything inside these should be preserved
  // verbatim during draft insertion — we never want to overwrite the user's
  // conversation history.
  const PRESERVED_QUOTE_SELECTOR =
    '.gmail_quote, .gmail_extra, .gmail_attr, blockquote.gmail_quote, ' +
    'blockquote[type="cite"], .moz-cite-prefix, [data-smartmail]';

  function isPreservedContainer(node) {
    if (!node || node.nodeType !== 1) return false;
    if (typeof node.matches !== 'function') return false;
    try {
      return node.matches(PRESERVED_QUOTE_SELECTOR);
    } catch (error) {
      return false;
    }
  }

  function collectTextNodes(root) {
    const textNodes = [];
    function walk(node) {
      if (!node) {
        return;
      }
      // Skip quoted-history subtrees (Gmail .gmail_quote, blockquote[type="cite"], etc.)
      // so execCommand('insertText') only replaces the user's draft area.
      if (isPreservedContainer(node)) {
        return;
      }
      if (node.nodeType === 3) {
        textNodes.push(node);
        return;
      }
      const children = node.childNodes || [];
      for (const child of children) {
        walk(child);
      }
    }
    walk(root);
    return textNodes;
  }

  function dispatchSelectionChange(documentRef, options = {}) {
    const EventCtor = options.EventCtor || globalObject.Event;
    let event = null;

    if (typeof EventCtor === 'function') {
      event = new EventCtor('selectionchange', { bubbles: true, cancelable: false });
    } else if (typeof documentRef?.createEvent === 'function') {
      event = documentRef.createEvent('Event');
      event.initEvent('selectionchange', true, false);
    }

    if (event && typeof documentRef?.dispatchEvent === 'function') {
      documentRef.dispatchEvent(event);
    }
  }

  function findFirstPreservedChild(target) {
    if (!target) return null;
    const children = target.children ? Array.from(target.children) : [];
    for (const child of children) {
      if (isPreservedContainer(child)) return child;
      // Also catch cases where the quote is wrapped one level deeper.
      if (typeof child.querySelector === 'function') {
        try {
          const nested = child.querySelector(PRESERVED_QUOTE_SELECTOR);
          if (nested) return child;
        } catch (error) { /* ignore */ }
      }
    }
    return null;
  }

  function selectEntireContent(target, documentRef, selection, options = {}) {
    const range = documentRef.createRange();
    const textNodes = collectTextNodes(target);

    if (textNodes.length > 0) {
      const first = textNodes[0];
      const last = textNodes[textNodes.length - 1];
      range.setStart(first, 0);
      range.setEnd(last, last.textContent?.length || 0);
    } else {
      // No draftable text nodes outside preserved quotes. If there's a
      // quoted-history block, bound the range to end just before it so
      // insertText can't eat the quote.
      const firstPreserved = findFirstPreservedChild(target);
      if (firstPreserved && typeof range.setEndBefore === 'function') {
        try {
          range.setStart(target, 0);
          range.setEndBefore(firstPreserved);
        } catch (error) {
          range.selectNodeContents(target);
        }
      } else {
        range.selectNodeContents(target);
      }
    }

    selection.removeAllRanges();
    selection.addRange(range);
    dispatchSelectionChange(documentRef, options);
  }

  function collectSlateTextNodes(root) {
    const textNodes = [];

    function walk(node, inSlateTextLeaf = false) {
      if (!node) {
        return;
      }

      if (node.nodeType === 3) {
        if (inSlateTextLeaf && node.textContent != null) {
          textNodes.push(node);
        }
        return;
      }

      const isSlateTextLeaf = !!node.getAttribute?.('data-slate-string') || !!node.getAttribute?.('data-slate-zero-width');
      const children = node.childNodes || [];
      for (const child of children) {
        walk(child, inSlateTextLeaf || isSlateTextLeaf);
      }
    }

    walk(root, false);
    return textNodes;
  }

  function selectEntireSlateContent(target, documentRef, selection, options = {}) {
    const range = documentRef.createRange();
    const textNodes = collectSlateTextNodes(target);

    if (textNodes.length === 0) {
      return false;
    }

    const first = textNodes[0];
    const last = textNodes[textNodes.length - 1];
    range.setStart(first, 0);
    range.setEnd(last, last.textContent?.length || 0);

    selection.removeAllRanges();
    selection.addRange(range);
    dispatchSelectionChange(documentRef, options);
    return true;
  }

  function selectionLooksExpanded(selection) {
    if (!selection) {
      return false;
    }
    if (typeof selection.isCollapsed === 'boolean') {
      return selection.isCollapsed === false;
    }
    if (typeof selection.toString === 'function' && selection.toString()) {
      return true;
    }
    if (typeof selection.rangeCount === 'number' && selection.rangeCount > 0 && typeof selection.getRangeAt === 'function') {
      try {
        const range = selection.getRangeAt(0);
        return !!range && range.collapsed === false;
      } catch (error) {
        return false;
      }
    }
    return false;
  }

  function trySelectAll(target, documentRef, selection) {
    if (typeof target?.focus === 'function') {
      target.focus();
    }
    if (typeof documentRef?.execCommand !== 'function') {
      return false;
    }
    const ok = !!documentRef.execCommand('selectAll', false, null);
    if (!ok) {
      return false;
    }
    return selectionLooksExpanded(selection) || !selection;
  }

  function prepareElementForTrustedInsert(el, options = {}) {
    const documentRef = options.documentRef || globalObject.document;
    const selection = options.selection || globalObject.getSelection?.() || globalObject.window?.getSelection?.();
    if (!el) {
      return { ok: false, kind: 'unknown', target: null };
    }

    const tag = el.tagName?.toUpperCase();
    if (tag === 'TEXTAREA' || tag === 'INPUT') {
      if (typeof el.focus === 'function') {
        el.focus();
      }
      if (typeof el.select === 'function') {
        el.select();
      }
      return { ok: true, kind: 'form', target: el };
    }

    const isContentEditable = !!(el.isContentEditable || el.getAttribute?.('contenteditable') === 'true' || el.getAttribute?.('role') === 'textbox');
    if (!isContentEditable || !documentRef || !selection || typeof documentRef.createRange !== 'function') {
      return { ok: false, kind: 'unknown', target: el };
    }

    const target = getContentEditableRoot(el, documentRef);
    const slateTarget = isSlateEditor(target) ? (getSlateEditorTarget(target) || target) : null;
    if (typeof (slateTarget || target).focus === 'function') {
      (slateTarget || target).focus();
    }

    if (!slateTarget) {
      selectEntireContent(target, documentRef, selection, options);
    }

    return { ok: true, kind: 'contenteditable', target };
  }

  function isSlateEditor(el) {
    if (!el) return false;
    if (el.getAttribute?.('data-slate-editor') === 'true') {
      return true;
    }
    if (typeof el.closest === 'function' && el.closest('[data-slate-editor="true"]')) {
      return true;
    }
    return !!el.querySelector?.('[data-slate-editor="true"]');
  }

  function getSlateEditorTarget(el) {
    if (!el) {
      return null;
    }
    if (el.getAttribute?.('data-slate-editor') === 'true') {
      return el;
    }
    if (typeof el.closest === 'function') {
      const closestMatch = el.closest('[data-slate-editor="true"]');
      if (closestMatch) {
        return closestMatch;
      }
    }
    return el.querySelector?.('[data-slate-editor="true"]') || null;
  }

  function createClipboardData(text, options = {}) {
    const DataTransferCtor = options.DataTransferCtor || globalObject.DataTransfer;
    if (typeof DataTransferCtor === 'function') {
      try {
        const clipboardData = new DataTransferCtor();
        if (typeof clipboardData.setData === 'function') {
          clipboardData.setData('text/plain', text);
          clipboardData.setData('text', text);
        }
        return clipboardData;
      } catch (error) {
        // Fall back to a minimal clipboardData shim below.
      }
    }

    const store = new Map([
      ['text/plain', text],
      ['text', text],
    ]);

    return {
      dropEffect: 'none',
      effectAllowed: 'all',
      files: [],
      items: [],
      types: Array.from(store.keys()),
      getData(type) {
        return store.get(type) || '';
      },
      setData(type, value) {
        store.set(type, String(value));
        this.types = Array.from(store.keys());
      },
    };
  }

  function createSyntheticPasteEvent(text, options = {}) {
    const documentRef = options.documentRef || globalObject.document;
    const ClipboardEventCtor = options.ClipboardEventCtor || globalObject.ClipboardEvent;
    const EventCtor = options.EventCtor || globalObject.Event;
    const clipboardData = createClipboardData(text, options);
    let event = null;

    if (typeof ClipboardEventCtor === 'function') {
      try {
        event = new ClipboardEventCtor('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData,
        });
      } catch (error) {
        event = null;
      }
    }

    if (!event && typeof EventCtor === 'function') {
      event = new EventCtor('paste', { bubbles: true, cancelable: true });
    }

    if (!event && typeof documentRef?.createEvent === 'function') {
      event = documentRef.createEvent('Event');
      event.initEvent('paste', true, true);
    }

    if (!event) {
      return null;
    }

    try {
      if (!('clipboardData' in event) || !event.clipboardData) {
        Object.defineProperty(event, 'clipboardData', {
          configurable: true,
          enumerable: true,
          value: clipboardData,
        });
      }
    } catch (error) {
      event.clipboardData = clipboardData;
    }

    return event;
  }

  function createSyntheticInputEvent(type, text, options = {}, inputType = 'insertText') {
    const InputEventCtor = options.InputEventCtor || globalObject.InputEvent;
    const EventCtor = options.EventCtor || globalObject.Event;
    let event = null;

    if (typeof InputEventCtor === 'function') {
      try {
        event = new InputEventCtor(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          data: text,
          inputType,
        });
      } catch (error) {
        event = null;
      }
    }

    if (!event && typeof EventCtor === 'function') {
      event = new EventCtor(type, { bubbles: true, cancelable: true, composed: true });
    } else if (!event && typeof globalObject.document?.createEvent === 'function') {
      event = globalObject.document.createEvent('Event');
      event.initEvent(type, true, true);
    }

    if (!event) {
      return null;
    }

    try {
      if (!('data' in event)) {
        Object.defineProperty(event, 'data', {
          configurable: true,
          enumerable: true,
          value: text,
        });
      }
      if (!('inputType' in event)) {
        Object.defineProperty(event, 'inputType', {
          configurable: true,
          enumerable: true,
          value: inputType,
        });
      }
      if (!('isComposing' in event)) {
        Object.defineProperty(event, 'isComposing', {
          configurable: true,
          enumerable: true,
          value: false,
        });
      }
    } catch (error) {
      event.data = text;
      event.inputType = inputType;
      event.isComposing = false;
    }

    return event;
  }

  function createSyntheticKeyboardEvent(type, init = {}, options = {}) {
    const documentRef = options.documentRef || globalObject.document;
    const KeyboardEventCtor = options.KeyboardEventCtor || globalObject.KeyboardEvent;
    const EventCtor = options.EventCtor || globalObject.Event;
    let event = null;

    if (typeof KeyboardEventCtor === 'function') {
      try {
        event = new KeyboardEventCtor(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          ...init,
        });
      } catch (error) {
        event = null;
      }
    }

    if (!event && typeof EventCtor === 'function') {
      event = new EventCtor(type, { bubbles: true, cancelable: true });
    }

    if (!event && typeof documentRef?.createEvent === 'function') {
      event = documentRef.createEvent('Event');
      event.initEvent(type, true, true);
    }

    if (!event) {
      return null;
    }

    for (const [key, value] of Object.entries(init)) {
      try {
        if (!(key in event) || event[key] !== value) {
          Object.defineProperty(event, key, {
            configurable: true,
            enumerable: true,
            value,
          });
        }
      } catch (error) {
        event[key] = value;
      }
    }

    return event;
  }

  function dispatchSlateSelectAllHotkey(target, options = {}) {
    if (!target || typeof target.dispatchEvent !== 'function') {
      return false;
    }

    const isMacPlatform = !!((options.navigatorRef || globalObject.navigator)?.platform || '').match(/Mac|iPhone|iPad/i);
    const modifierProps = isMacPlatform
      ? { metaKey: true, ctrlKey: false }
      : { ctrlKey: true, metaKey: false };
    const keydown = createSyntheticKeyboardEvent('keydown', {
      key: 'a',
      code: 'KeyA',
      keyCode: 65,
      which: 65,
      ...modifierProps,
    }, options);
    const keyup = createSyntheticKeyboardEvent('keyup', {
      key: 'a',
      code: 'KeyA',
      keyCode: 65,
      which: 65,
      ...modifierProps,
    }, options);

    if (!keydown || !keyup) {
      return false;
    }

    target.dispatchEvent(keydown);
    target.dispatchEvent(keyup);
    return true;
  }

  function dispatchSyntheticPaste(target, text, options = {}) {
    if (!target || typeof target.dispatchEvent !== 'function') {
      return false;
    }

    const event = createSyntheticPasteEvent(text, options);
    if (!event) {
      return false;
    }

    target.dispatchEvent(event);
    return true;
  }

  function dispatchSyntheticBeforeInput(target, text, options = {}) {
    if (!target || typeof target.dispatchEvent !== 'function') {
      return false;
    }

    const event = createSyntheticInputEvent('beforeinput', text, options, 'insertText');
    if (!event) {
      return false;
    }

    target.dispatchEvent(event);
    return true;
  }

  function replaceContentEditableText(el, text, options = {}) {
    const prepared = prepareElementForTrustedInsert(el, options);
    const documentRef = options.documentRef || globalObject.document;
    const selection = options.selection || globalObject.getSelection?.() || globalObject.window?.getSelection?.();
    const slateMode = options.slateMode || 'prefer-model';

    if (!prepared.ok || prepared.kind !== 'contenteditable' || !documentRef || !selection) {
      return { ok: false, strategy: 'unsupported', target: prepared.target || el };
    }

    const target = prepared.target;
    if (isSlateEditor(target)) {
      const slateTarget = getSlateEditorTarget(target) || target;
      if (slateMode === 'prefer-model') {
        const hotkeyOk = dispatchSlateSelectAllHotkey(slateTarget, options);
        const pasteOk = hotkeyOk && dispatchSyntheticPaste(slateTarget, text, options);
        if (pasteOk) {
          return { ok: true, strategy: 'slate-hotkey-paste', target: slateTarget };
        }
      }

      if (slateMode === 'manual-model') {
        const selected = selectEntireSlateContent(slateTarget, documentRef, selection, options);
        if (!selected) {
          return { ok: false, strategy: 'slate-select-failed', target: slateTarget };
        }
        const inputOk = dispatchSyntheticBeforeInput(slateTarget, text, options);
        if (inputOk) {
          return { ok: true, strategy: 'slate-manual-beforeinput', target: slateTarget };
        }
        const ok = dispatchSyntheticPaste(slateTarget, text, options);
        return { ok, strategy: ok ? 'slate-manual-paste' : 'slate-manual-paste-failed', target: slateTarget };
      }

      const browserSelected = trySelectAll(slateTarget, documentRef, selection);
      if (browserSelected) {
        const execOk = !!documentRef.execCommand?.('insertText', false, text);
        if (execOk) {
          return { ok: true, strategy: 'slate-execcommand', target: slateTarget };
        }
      }

      const selected = browserSelected
        || selectEntireSlateContent(slateTarget, documentRef, selection, options);
      if (!selected) {
        return { ok: false, strategy: 'slate-select-failed', target: slateTarget };
      }
      const ok = dispatchSyntheticPaste(slateTarget, text, options);
      return { ok, strategy: ok ? 'slate-paste' : 'slate-paste-failed', target: slateTarget };
    }

    if (typeof documentRef.execCommand === 'function') {
      documentRef.execCommand('selectAll', false, null);
      selectEntireContent(target, documentRef, selection, options);
    }

    const ok = !!documentRef.execCommand?.('insertText', false, text);
    return { ok, strategy: ok ? 'execCommand' : 'execCommand-failed', target };
  }

  const api = {
    createClipboardData,
    createSyntheticInputEvent,
    createSyntheticPasteEvent,
    dispatchSyntheticBeforeInput,
    dispatchSyntheticPaste,
    dispatchSlateSelectAllHotkey,
    dispatchSelectionChange,
    getContentEditableRoot,
    getSlateEditorTarget,
    isSlateEditor,
    normalizeWriteText,
    prepareElementForTrustedInsert,
    replaceContentEditableText,
    selectEntireSlateContent,
    selectEntireContent,
    isPreservedContainer,
    PRESERVED_QUOTE_SELECTOR,
  };

  globalObject.ComposeTextWriter = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
