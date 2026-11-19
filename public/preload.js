/**
 * RuneDeck — script preloader.
 *
 * `import()` gives no progress, and the battlefield's scripts (Three.js above
 * all) are the bulk of what a first match downloads. This walks the module
 * graph with `fetch`, counting bytes as they arrive; the import that follows
 * finds every file in the browser's cache.
 *
 * It is only a progress meter: any failure here is ignored, because the real
 * import reports real errors.
 */

/** Rough size of the whole graph, used until the true sizes are known. */
const EXPECTED_BYTES = 2_600_000;
const IMPORT = /(?:\bfrom|\bimport)\s*['"]([^'"\n]+)['"]/g;
/** A download that delivers nothing for this long is given up, so the real import can take over. */
const STALL_MS = 15_000;

/**
 * Downloads `entry` and everything it imports. `onProgress(fraction)` is
 * called as bytes arrive, with a fraction that never goes down.
 */
export async function preloadModules(entry, onProgress = () => {}) {
  const seen = new Set();
  const stalled = new AbortController();
  let watchdog = 0;
  const alive = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => stalled.abort(), STALL_MS);
  };
  let loaded = 0;
  let known = 0;
  let best = 0;

  const report = () => {
    best = Math.max(best, Math.min(loaded / Math.max(known, EXPECTED_BYTES), 0.99));
    onProgress(best);
  };

  const resolve = (specifier, parent) => {
    try {
      // Bare names ("three") go through the page's import map.
      if (!/^\.{0,2}\//.test(specifier)) return import.meta.resolve(specifier);
      return new URL(specifier, parent).href;
    } catch {
      return null;
    }
  };

  async function load(url) {
    if (!url || seen.has(url) || new URL(url).origin !== location.origin) return;
    seen.add(url);
    const response = await fetch(url, { credentials: 'same-origin', signal: stalled.signal });
    if (!response.ok) return;
    const length = Number(response.headers.get('content-length')) || 0;
    known += length;

    const chunks = [];
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value, { stream: true }));
      alive();
      received += value.length;
      loaded += value.length;
      report();
    }
    // A compressed response's length is its size on the wire; count what was promised.
    if (length && received !== length) loaded += length - received;

    const source = chunks.join('');
    const children = [];
    for (const [, specifier] of source.matchAll(IMPORT)) children.push(load(resolve(specifier, url)));
    await Promise.all(children);
  }

  try {
    alive();
    await load(new URL(entry, import.meta.url).href);
  } catch {
    // The import that follows will say what went wrong.
  } finally {
    clearTimeout(watchdog);
  }
  onProgress(1);
}
