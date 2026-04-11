(function initComposeDocumentAdapterRegistry(globalObject) {
  /** @type {Array<{pattern: RegExp, factory: function(): object}>} */
  const registeredAdapters = [];

  /** @type {object|null} */
  let cachedAdapter = null;

  /** @type {boolean} */
  let cachePopulated = false;

  /**
   * Clears the cached adapter lookup. Called on SPA navigation events.
   */
  function clearCache() {
    cachedAdapter = null;
    cachePopulated = false;
  }

  /**
   * Register an adapter factory for a given URL pattern.
   * Adapters are checked in registration order; first matching + detecting adapter wins.
   *
   * @param {RegExp} urlPattern - regex tested against window.location.href
   * @param {function(): object} factoryFn - called to produce the adapter instance
   */
  function registerAdapter(urlPattern, factoryFn) {
    registeredAdapters.push({ pattern: urlPattern, factory: factoryFn });
  }

  /**
   * Returns the first adapter whose URL pattern matches the current href
   * AND whose detect() method returns true. Result is cached for the page load.
   *
   * Returns null if no adapter matches.
   *
   * @returns {object|null}
   */
  function getAdapter() {
    if (cachePopulated) {
      return cachedAdapter;
    }

    const href = (globalObject.location && globalObject.location.href) || '';
    let matched = null;

    console.log('[ComposeAdapterRegistry] getAdapter() checking ' + registeredAdapters.length + ' adapters for: ' + href.substring(0, 80));
    for (const entry of registeredAdapters) {
      var urlMatch = entry.pattern.test(href);
      if (urlMatch) {
        console.log('[ComposeAdapterRegistry] URL matched pattern: ' + entry.pattern);
        try {
          const adapter = entry.factory();
          if (adapter && typeof adapter.detect === 'function' && adapter.detect()) {
            matched = adapter;
            console.log('[ComposeAdapterRegistry] Adapter detected! Using it.');
            break;
          } else {
            console.log('[ComposeAdapterRegistry] URL matched but detect() returned false');
          }
        } catch (err) {
          console.warn('[ComposeAdapterRegistry] Factory/detect error:', err);
        }
      }
    }

    cachedAdapter = matched;
    cachePopulated = true;
    if (!matched) {
      console.log('[ComposeAdapterRegistry] No adapter matched/detected');
    }
    return matched;
  }

  /**
   * Returns true if the current URL matches any registered adapter pattern,
   * WITHOUT calling detect(). Used to suppress false "no text field" errors
   * in multi-frame pages where the editor lives in a different frame.
   */
  function hasUrlMatch() {
    var href = (globalObject.location && globalObject.location.href) || '';
    for (var i = 0; i < registeredAdapters.length; i++) {
      if (registeredAdapters[i].pattern.test(href)) {
        return true;
      }
    }
    return false;
  }

  // Listen for SPA navigation so the cached adapter is re-evaluated after route changes.
  (function attachNavigationListeners() {
    if (typeof globalObject.addEventListener !== 'function') {
      return;
    }

    globalObject.addEventListener('popstate', clearCache);

    // Monkey-patch pushState / replaceState to fire a cache-clear on programmatic navigation.
    const history = globalObject.history;
    if (history) {
      const _pushState = history.pushState;
      const _replaceState = history.replaceState;

      if (typeof _pushState === 'function') {
        history.pushState = function pushState(...args) {
          clearCache();
          return _pushState.apply(this, args);
        };
      }

      if (typeof _replaceState === 'function') {
        history.replaceState = function replaceState(...args) {
          clearCache();
          return _replaceState.apply(this, args);
        };
      }
    }
  })();

  const api = {
    getAdapter,
    registerAdapter,
    clearCache,
    hasUrlMatch,
  };

  globalObject.ComposeDocumentAdapterRegistry = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
