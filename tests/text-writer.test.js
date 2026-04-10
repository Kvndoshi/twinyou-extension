const assert = require('node:assert/strict');

const {
  prepareElementForTrustedInsert,
  replaceContentEditableText,
} = require('../text_writer');

function createSelectionHarness() {
  const ranges = [];
  const documentEvents = [];

  const selection = {
    removeAllRangesCalls: 0,
    addRangeCalls: 0,
    removeAllRanges() {
      this.removeAllRangesCalls += 1;
      ranges.length = 0;
    },
    addRange(range) {
      this.addRangeCalls += 1;
      ranges.push(range);
    },
  };

  const documentRef = {
    createRange() {
      return {
        selectedNode: null,
        startContainer: null,
        startOffset: null,
        endContainer: null,
        endOffset: null,
        collapsedToStart: null,
        selectNodeContents(node) {
          this.selectedNode = node;
        },
        setStart(node, offset) {
          this.startContainer = node;
          this.startOffset = offset;
        },
        setEnd(node, offset) {
          this.endContainer = node;
          this.endOffset = offset;
        },
        collapse(toStart) {
          this.collapsedToStart = toStart;
        },
      };
    },
    dispatchEvent(event) {
      documentEvents.push(event);
      return true;
    },
  };

  return { documentEvents, documentRef, ranges, selection };
}

function runTest(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

runTest('prepares a textarea for trusted insertion by focusing and selecting all text', () => {
  const element = {
    tagName: 'TEXTAREA',
    focused: false,
    selected: false,
    focus() {
      this.focused = true;
    },
    select() {
      this.selected = true;
    },
  };

  const result = prepareElementForTrustedInsert(element);

  assert.equal(result.ok, true);
  assert.equal(result.kind, 'form');
  assert.equal(result.target, element);
  assert.equal(element.focused, true);
  assert.equal(element.selected, true);
});

runTest('prepares the contenteditable root for trusted insertion without mutating text nodes', () => {
  const harness = createSelectionHarness();
  const root = {
    tagName: 'DIV',
    parentElement: harness.documentRef.body,
    isContentEditable: true,
    getAttribute(name) {
      if (name === 'contenteditable') return 'true';
      if (name === 'role') return 'textbox';
      return null;
    },
    focus() {
      this.focused = true;
    },
  };
  harness.documentRef.body = { tagName: 'BODY' };
  root.parentElement = harness.documentRef.body;
  const child = {
    tagName: 'SPAN',
    parentElement: root,
    isContentEditable: true,
    getAttribute() {
      return null;
    },
  };

  const result = prepareElementForTrustedInsert(child, {
    documentRef: harness.documentRef,
    selection: harness.selection,
  });

  assert.equal(result.ok, true);
  assert.equal(result.kind, 'contenteditable');
  assert.equal(result.target, root);
  assert.equal(root.focused, true);
  assert.equal(harness.selection.removeAllRangesCalls, 1);
  assert.equal(harness.selection.addRangeCalls, 1);
  assert.equal(harness.ranges.length, 1);
  assert.equal(harness.ranges[0].selectedNode, root);
});

runTest('replaces Slate editor content through Slate hotkey select-all and synthetic paste', () => {
  const harness = createSelectionHarness();
  harness.documentRef.body = { tagName: 'BODY' };
  harness.documentRef.execCommandCalls = [];
  harness.documentRef.execCommand = (...args) => {
    harness.documentRef.execCommandCalls.push(args);
    return true;
  };

  class FakeEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.bubbles = !!init.bubbles;
      this.cancelable = !!init.cancelable;
      Object.assign(this, init);
    }
  }

  class FakeClipboardEvent extends FakeEvent {
    constructor(type, init = {}) {
      super(type, init);
      this.clipboardData = init.clipboardData;
    }
  }

  const slateEvents = [];
  const firstTextNode = { nodeType: 3, textContent: 'old' };
  const lastTextNode = { nodeType: 3, textContent: 'draft' };
  const ignoredBreak = { nodeType: 1, tagName: 'BR', childNodes: [] };
  const firstLeaf = {
    nodeType: 1,
    tagName: 'SPAN',
    childNodes: [firstTextNode],
    getAttribute(name) {
      if (name === 'data-slate-string') return 'true';
      return null;
    },
  };
  const lastLeaf = {
    nodeType: 1,
    tagName: 'SPAN',
    childNodes: [lastTextNode],
    getAttribute(name) {
      if (name === 'data-slate-string') return 'true';
      return null;
    },
  };
  const slateChild = {
    tagName: 'DIV',
    parentElement: null,
    childNodes: [firstLeaf, ignoredBreak, lastLeaf],
    getAttribute(name) {
      if (name === 'data-slate-editor') return 'true';
      return null;
    },
    focus() {
      this.focused = true;
    },
    dispatchEvent(event) {
      slateEvents.push(event);
      return true;
    },
  };
  const root = {
    tagName: 'DIV',
    parentElement: harness.documentRef.body,
    isContentEditable: true,
    childNodes: [slateChild],
    getAttribute(name) {
      if (name === 'contenteditable') return 'true';
      return null;
    },
    focus() {
      this.focused = true;
    },
    querySelector(selector) {
      if (selector === '[data-slate-editor="true"]') return slateChild;
      return null;
    },
  };
  slateChild.parentElement = root;

  const result = replaceContentEditableText(root, 'replacement draft', {
    documentRef: harness.documentRef,
    selection: harness.selection,
    ClipboardEventCtor: FakeClipboardEvent,
    KeyboardEventCtor: FakeEvent,
    EventCtor: FakeEvent,
  });

  assert.equal(result.ok, true);
  assert.equal(result.strategy, 'slate-hotkey-paste');
  assert.equal(result.target, slateChild);
  assert.equal(slateChild.focused, true);
  assert.equal(slateEvents.length, 3);
  assert.equal(slateEvents[0].type, 'keydown');
  assert.equal(slateEvents[0].ctrlKey, true);
  assert.equal(slateEvents[0].key, 'a');
  assert.equal(slateEvents[1].type, 'keyup');
  assert.equal(slateEvents[2].type, 'paste');
  assert.equal(slateEvents[2].clipboardData.getData('text/plain'), 'replacement draft');
  assert.deepEqual(harness.documentRef.execCommandCalls, []);
  assert.equal(harness.documentEvents.length, 0);
  assert.equal(harness.ranges.length, 0);
});

runTest('falls back to Slate DOM-native replace when requested', () => {
  const harness = createSelectionHarness();
  harness.documentRef.body = { tagName: 'BODY' };
  harness.selection.isCollapsed = false;
  harness.documentRef.execCommandCalls = [];
  harness.documentRef.execCommand = (...args) => {
    harness.documentRef.execCommandCalls.push(args);
    return true;
  };

  class FakeEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.bubbles = !!init.bubbles;
      this.cancelable = !!init.cancelable;
      Object.assign(this, init);
    }
  }

  class FakeClipboardEvent extends FakeEvent {
    constructor(type, init = {}) {
      super(type, init);
      this.clipboardData = init.clipboardData;
    }
  }

  const slateEvents = [];
  const firstTextNode = { nodeType: 3, textContent: 'old' };
  const lastTextNode = { nodeType: 3, textContent: 'draft' };
  const firstLeaf = {
    nodeType: 1,
    tagName: 'SPAN',
    childNodes: [firstTextNode],
    getAttribute(name) {
      if (name === 'data-slate-string') return 'true';
      return null;
    },
  };
  const lastLeaf = {
    nodeType: 1,
    tagName: 'SPAN',
    childNodes: [lastTextNode],
    getAttribute(name) {
      if (name === 'data-slate-string') return 'true';
      return null;
    },
  };
  const slateChild = {
    tagName: 'DIV',
    parentElement: null,
    childNodes: [firstLeaf, lastLeaf],
    getAttribute(name) {
      if (name === 'data-slate-editor') return 'true';
      return null;
    },
    focus() {
      this.focused = true;
    },
    dispatchEvent(event) {
      slateEvents.push(event);
      return true;
    },
  };
  const root = {
    tagName: 'DIV',
    parentElement: harness.documentRef.body,
    isContentEditable: true,
    childNodes: [slateChild],
    getAttribute(name) {
      if (name === 'contenteditable') return 'true';
      return null;
    },
    focus() {
      this.focused = true;
    },
    querySelector(selector) {
      if (selector === '[data-slate-editor="true"]') return slateChild;
      return null;
    },
  };
  slateChild.parentElement = root;

  const result = replaceContentEditableText(root, 'replacement draft', {
    documentRef: harness.documentRef,
    selection: harness.selection,
    ClipboardEventCtor: FakeClipboardEvent,
    KeyboardEventCtor: FakeEvent,
    EventCtor: FakeEvent,
    slateMode: 'force-dom',
  });

  assert.equal(result.ok, true);
  assert.equal(result.strategy, 'slate-execcommand');
  assert.equal(result.target, slateChild);
  assert.equal(slateChild.focused, true);
  assert.equal(slateEvents.length, 0);
  assert.deepEqual(harness.documentRef.execCommandCalls, [
    ['selectAll', false, null],
    ['insertText', false, 'replacement draft'],
  ]);
  assert.equal(harness.documentEvents.length, 0);
  assert.equal(harness.ranges.length, 0);
});

runTest('manual Slate mode dispatches beforeinput on a Slate-owned selection', () => {
  const harness = createSelectionHarness();
  harness.documentRef.body = { tagName: 'BODY' };
  harness.documentRef.execCommandCalls = [];
  harness.documentRef.execCommand = (...args) => {
    harness.documentRef.execCommandCalls.push(args);
    return false;
  };

  class FakeEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.bubbles = !!init.bubbles;
      this.cancelable = !!init.cancelable;
      Object.assign(this, init);
    }
  }

  class FakeClipboardEvent extends FakeEvent {
    constructor(type, init = {}) {
      super(type, init);
      this.clipboardData = init.clipboardData;
    }
  }

  const slateEvents = [];
  const firstTextNode = { nodeType: 3, textContent: 'old' };
  const lastTextNode = { nodeType: 3, textContent: 'draft' };
  const firstLeaf = {
    nodeType: 1,
    tagName: 'SPAN',
    childNodes: [firstTextNode],
    getAttribute(name) {
      if (name === 'data-slate-string') return 'true';
      return null;
    },
  };
  const lastLeaf = {
    nodeType: 1,
    tagName: 'SPAN',
    childNodes: [lastTextNode],
    getAttribute(name) {
      if (name === 'data-slate-string') return 'true';
      return null;
    },
  };
  const slateChild = {
    tagName: 'DIV',
    parentElement: null,
    childNodes: [firstLeaf, lastLeaf],
    getAttribute(name) {
      if (name === 'data-slate-editor') return 'true';
      return null;
    },
    focus() {
      this.focused = true;
    },
    dispatchEvent(event) {
      slateEvents.push(event);
      return true;
    },
  };
  const root = {
    tagName: 'DIV',
    parentElement: harness.documentRef.body,
    isContentEditable: true,
    childNodes: [slateChild],
    getAttribute(name) {
      if (name === 'contenteditable') return 'true';
      return null;
    },
    focus() {
      this.focused = true;
    },
    querySelector(selector) {
      if (selector === '[data-slate-editor="true"]') return slateChild;
      return null;
    },
  };
  slateChild.parentElement = root;

  const result = replaceContentEditableText(root, 'replacement draft', {
    documentRef: harness.documentRef,
    selection: harness.selection,
    ClipboardEventCtor: FakeClipboardEvent,
    InputEventCtor: FakeEvent,
    KeyboardEventCtor: FakeEvent,
    EventCtor: FakeEvent,
    slateMode: 'manual-model',
  });

  assert.equal(result.ok, true);
  assert.equal(result.strategy, 'slate-manual-beforeinput');
  assert.equal(result.target, slateChild);
  assert.equal(slateChild.focused, true);
  assert.equal(slateEvents.length, 1);
  assert.equal(slateEvents[0].type, 'beforeinput');
  assert.equal(slateEvents[0].inputType, 'insertText');
  assert.equal(slateEvents[0].data, 'replacement draft');
  assert.deepEqual(harness.documentRef.execCommandCalls, []);
  assert.equal(harness.documentEvents.length, 1);
  assert.equal(harness.documentEvents[0].type, 'selectionchange');
  assert.equal(harness.ranges[0].startContainer, firstTextNode);
  assert.equal(harness.ranges[0].endContainer, lastTextNode);
  assert.equal(harness.ranges[0].endOffset, lastTextNode.textContent.length);
});

runTest('falls back to Slate leaf selection when browser select-all is unavailable', () => {
  const harness = createSelectionHarness();
  harness.documentRef.body = { tagName: 'BODY' };
  harness.documentRef.execCommandCalls = [];
  harness.documentRef.execCommand = (...args) => {
    harness.documentRef.execCommandCalls.push(args);
    return false;
  };

  class FakeEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.bubbles = !!init.bubbles;
      this.cancelable = !!init.cancelable;
    }
  }

  class FakeClipboardEvent extends FakeEvent {
    constructor(type, init = {}) {
      super(type, init);
      this.clipboardData = init.clipboardData;
    }
  }

  const slateEvents = [];
  const firstTextNode = { nodeType: 3, textContent: 'old' };
  const lastTextNode = { nodeType: 3, textContent: 'draft' };
  const firstLeaf = {
    nodeType: 1,
    tagName: 'SPAN',
    childNodes: [firstTextNode],
    getAttribute(name) {
      if (name === 'data-slate-string') return 'true';
      return null;
    },
  };
  const lastLeaf = {
    nodeType: 1,
    tagName: 'SPAN',
    childNodes: [lastTextNode],
    getAttribute(name) {
      if (name === 'data-slate-string') return 'true';
      return null;
    },
  };
  const slateChild = {
    tagName: 'DIV',
    parentElement: null,
    childNodes: [firstLeaf, lastLeaf],
    getAttribute(name) {
      if (name === 'data-slate-editor') return 'true';
      return null;
    },
    focus() {
      this.focused = true;
    },
    dispatchEvent(event) {
      slateEvents.push(event);
      return true;
    },
  };
  const root = {
    tagName: 'DIV',
    parentElement: harness.documentRef.body,
    isContentEditable: true,
    childNodes: [slateChild],
    getAttribute(name) {
      if (name === 'contenteditable') return 'true';
      return null;
    },
    focus() {
      this.focused = true;
    },
    querySelector(selector) {
      if (selector === '[data-slate-editor="true"]') return slateChild;
      return null;
    },
  };
  slateChild.parentElement = root;

  const result = replaceContentEditableText(root, 'replacement draft', {
    documentRef: harness.documentRef,
    selection: harness.selection,
    ClipboardEventCtor: FakeClipboardEvent,
    KeyboardEventCtor: FakeEvent,
    EventCtor: FakeEvent,
    slateMode: 'force-dom',
  });

  assert.equal(result.ok, true);
  assert.equal(result.strategy, 'slate-paste');
  assert.equal(result.target, slateChild);
  assert.equal(slateChild.focused, true);
  assert.equal(slateEvents.length, 1);
  assert.equal(slateEvents[0].type, 'paste');
  assert.deepEqual(harness.documentRef.execCommandCalls, [['selectAll', false, null]]);
  assert.equal(harness.documentEvents.length, 1);
  assert.equal(harness.documentEvents[0].type, 'selectionchange');
  assert.equal(harness.ranges[0].startContainer, firstTextNode);
  assert.equal(harness.ranges[0].endContainer, lastTextNode);
  assert.equal(harness.ranges[0].endOffset, lastTextNode.textContent.length);
});

runTest('replaces generic contenteditable content through execCommand after selecting all text', () => {
  const harness = createSelectionHarness();
  harness.documentRef.body = { tagName: 'BODY' };
  harness.documentRef.execCommandCalls = [];
  harness.documentRef.execCommand = (...args) => {
    harness.documentRef.execCommandCalls.push(args);
    return true;
  };

  const root = {
    tagName: 'DIV',
    parentElement: harness.documentRef.body,
    isContentEditable: true,
    getAttribute(name) {
      if (name === 'contenteditable') return 'true';
      return null;
    },
    focus() {
      this.focused = true;
    },
  };

  const result = replaceContentEditableText(root, 'replacement draft', {
    documentRef: harness.documentRef,
    selection: harness.selection,
  });

  assert.equal(result.ok, true);
  assert.equal(result.strategy, 'execCommand');
  assert.equal(result.target, root);
  assert.equal(root.focused, true);
  assert.deepEqual(harness.documentRef.execCommandCalls, [
    ['selectAll', false, null],
    ['insertText', false, 'replacement draft'],
  ]);
  assert.equal(harness.selection.removeAllRangesCalls, 2);
  assert.equal(harness.selection.addRangeCalls, 2);
  assert.equal(harness.documentEvents.length, 2);
});
