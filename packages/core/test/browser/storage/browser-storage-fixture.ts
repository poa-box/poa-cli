// Offline transaction harness. A readwrite transaction commits all staged puts
// together; later transactions observe that commit, including across adapter instances.
export function browserStorageFixture() {
  const rows = new Map(), held = new Set(), faults = { open: false, write: false, relaxed: false };
  let created = false, tail = Promise.resolve();
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const db = {
    createObjectStore() {},
    transaction(_name, mode, options) {
      let release;
      const previous = tail; tail = new Promise(resolve => { release = resolve; });
      const ops = [], tx = { durability: faults.relaxed ? 'relaxed' : options?.durability ?? 'default', aborted: false, abort() { tx.aborted = true; }, objectStore() { return store; } };
      const store = {
        get(key) { const request = {}; ops.push({ kind: 'get', key, request }); return request; },
        put(value, key) { ops.push({ kind: 'put', key, value: clone(value) }); return {}; },
      };
      queueMicrotask(async () => {
        await previous;
        const staged = new Map([...rows].map(([key, value]) => [key, clone(value)]));
        try {
          while (ops.length && !tx.aborted) {
            const op = ops.shift();
            if (op.kind === 'get') { op.request.result = clone(staged.get(op.key)); op.request.onsuccess?.(); }
            else if (faults.write) tx.abort();
            else staged.set(op.key, op.value);
          }
          if (tx.aborted) tx.onabort?.();
          else {
            if (mode === 'readwrite') { rows.clear(); for (const [key, value] of staged) rows.set(key, value); }
            tx.oncomplete?.();
          }
        } finally { release(); }
      });
      return tx;
    },
  };
  return { rows, held, faults,
    indexedDB: { open() {
      const request = {};
      queueMicrotask(() => {
        if (faults.open) return request.onerror?.();
        request.result = db;
        if (!created) { created = true; request.onupgradeneeded?.(); }
        request.onsuccess?.();
      });
      return request;
    } },
    locks: { async request(name, _options, run) {
      if (held.has(name)) return run(null);
      held.add(name);
      try { return await run({ name }); } finally { held.delete(name); }
    } },
  };
}
