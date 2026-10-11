(() => {
  const key = "__delPipAttributeRemoverV1";
  if (globalThis[key]) return globalThis[key].scan();

  let removed = 0;
  const observers = new Map();
  const retries = new WeakMap();
  const pending = new Set();
  let flushTimer = null;

  function clean(element) {
    if (element.localName === "video" && element.hasAttribute("disablepictureinpicture")) {
      const now = Date.now();
      let retry = retries.get(element);
      if (retry && now < retry.blockedUntil) return;
      if (!retry || now - retry.started >= 5000) {
        retry = { started: now, count: 0, blockedUntil: 0 };
        retries.set(element, retry);
      }
      // A site may immediately restore the attribute. Bound attempts per video.
      if (retry.count >= 5) {
        retry.blockedUntil = now + 30000;
        return;
      }
      retry.count += 1;
      element.removeAttribute("disablepictureinpicture");
      removed += 1;
    }
  }

  function visit(node) {
    if (node.nodeType === 1) {
      clean(node);
      if (node.shadowRoot) observe(node.shadowRoot);
    }
    for (const element of node.querySelectorAll?.("*") || []) {
      clean(element);
      if (element.shadowRoot) observe(element.shadowRoot);
    }
  }

  function observe(root) {
    if (observers.has(root)) {
      visit(root);
      return;
    }
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes") {
          if (record.target.hasAttribute("disablepictureinpicture")) pending.add(record.target);
        } else {
          for (const node of record.addedNodes) {
            if (node.nodeType === 1) pending.add(node);
          }
        }
      }
      // Never fight another MutationObserver inside the microtask checkpoint.
      if (pending.size && flushTimer === null) {
        flushTimer = setTimeout(() => {
          flushTimer = null;
          const nodes = [...pending];
          pending.clear();
          for (const node of nodes) if (node.isConnected) visit(node);
        }, 100);
      }
    });
    observers.set(root, observer);
    observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["disablepictureinpicture"]
    });
    visit(root);
  }

  function scan() {
    const before = removed;
    for (const [root, observer] of observers) {
      if (root.host && !root.host.isConnected) {
        observer.disconnect();
        observers.delete(root);
      }
    }
    visit(document);
    return { removed: removed - before };
  }

  globalThis[key] = { scan };
  observe(document);
  // Attaching a shadow root does not emit a document mutation. Discover late roots.
  setInterval(() => {
    if (!document.hidden) scan();
  }, 2000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) scan();
  });
  return { removed };
})();
