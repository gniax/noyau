// A native permission sheet can keep a pointer gesture pending longer than the
// usual synthetic-click debounce. Suppress its click until the action finishes.
export function createTapGuard(now = Date.now) {
  let last = null;
  return {
    run(target, action) {
      const item = { target, pending: true, at: now() }; last = item;
      const finish = () => { item.pending = false; item.at = now(); };
      try { const result = action(); if (result && typeof result.then === "function") result.then(finish, finish); else finish(); return result; }
      catch (error) { finish(); throw error; }
    },
    allowClick(target) { return !last || last.target !== target || (!last.pending && now() - last.at >= 700); },
  };
}
