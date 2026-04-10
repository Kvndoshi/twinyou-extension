(function initComposeDocumentAdapterBase(globalObject) {
  /**
   * Default no-op implementations for all adapter interface methods.
   * Every platform adapter should override all of these.
   */
  const defaults = {
    /**
     * Returns true if this adapter's platform is active on the current page.
     * @returns {boolean}
     */
    detect() {
      return false;
    },

    /**
     * Returns the main editing surface element (NOT the document title).
     * @returns {HTMLElement|null}
     */
    getEditorElement() {
      return null;
    },

    /**
     * Returns the full document body as plain text.
     * @returns {string}
     */
    readFullContent() {
      return '';
    },

    /**
     * Returns the currently selected text, or null if nothing is selected.
     * @returns {string|null}
     */
    readSelection() {
      return null;
    },

    /**
     * Quick check for whether the user has a non-collapsed selection.
     * @returns {boolean}
     */
    hasSelection() {
      return false;
    },

    /**
     * Returns text context around the cursor (~500 chars each side).
     * @returns {{before: string, after: string, selectedText: string}}
     */
    getCursorContext() {
      return { before: '', after: '', selectedText: '' };
    },

    /**
     * Returns the document title string.
     * @returns {string}
     */
    getDocumentTitle() {
      return '';
    },

    /**
     * Inserts text at the current cursor position.
     * @param {string} text
     * @returns {Promise<boolean>}
     */
    async writeAtCursor(text) {
      return false;
    },

    /**
     * Replaces the currently selected text with the given text.
     * @param {string} text
     * @returns {Promise<boolean>}
     */
    async replaceSelection(text) {
      return false;
    },

    /**
     * Replaces the entire document body with the given text.
     * @param {string} text
     * @returns {Promise<boolean>}
     */
    async replaceAll(text) {
      return false;
    },

    /**
     * Returns the recommended write strategy given the current selection state.
     * @param {boolean} hasSelection
     * @returns {'replaceSelection'|'replaceAll'|'writeAtCursor'}
     */
    getWriteStrategy(hasSelection) {
      if (hasSelection) return 'replaceSelection';
      return 'writeAtCursor';
    },
  };

  /**
   * Factory that merges caller-supplied overrides onto the default no-op adapter.
   * Usage:
   *   const myAdapter = ComposeDocumentAdapterBase.createAdapter({
   *     detect() { ... },
   *     getEditorElement() { ... },
   *     ...
   *   });
   *
   * @param {Partial<typeof defaults>} overrides
   * @returns {typeof defaults}
   */
  function createAdapter(overrides) {
    return Object.assign(Object.create(null), defaults, overrides || {});
  }

  const api = {
    createAdapter,
    defaults,
  };

  globalObject.ComposeDocumentAdapterBase = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
