// The stories page shares the daemon's origin, so the app's own storage (the outbox's IndexedDB,
// localStorage, sessionStorage) is the app's, not the stories'. A story that sends, drafts, or
// remembers something must never leave a row or key there. This swaps all three for in-memory
// ones: IndexedDB goes away (the outbox then keeps its rows in memory), and each Storage is a Map
// that dies with the page. stories.html loads it as a classic script before the module script, so
// it runs before any app module reads a storage (a module chunk would run after its imports).
// stories.test.tsx evaluates this same file against a stand-in window.
(function (window) {
  function memoryStorage() {
    var m = new Map()
    return {
      get length() { return m.size },
      clear: function () { m.clear() },
      getItem: function (k) { return m.has(String(k)) ? m.get(String(k)) : null },
      key: function (i) { return Array.from(m.keys())[i] || null },
      removeItem: function (k) { m.delete(String(k)) },
      setItem: function (k, v) { m.set(String(k), String(v)) },
    }
  }
  ;['indexedDB', 'localStorage', 'sessionStorage'].forEach(function (n) {
    Object.defineProperty(window, n, { configurable: true, value: n === 'indexedDB' ? undefined : memoryStorage() })
  })
})(window)
