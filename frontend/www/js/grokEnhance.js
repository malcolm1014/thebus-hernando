/**
 * Thin client for the backend's optional /api/enhance-answer proxy (see
 * backend/src/grokAnswer.js). Takes the query engine's own already-
 * correct, fully-offline answer and asks Grok to rephrase it into more
 * natural language -- never a source of transit facts on its own.
 *
 * Deliberately fails soft in every way: offline, no network, a slow
 * response, a backend error, or the feature simply not being configured
 * server-side all resolve to `null` here, never throw -- app.js's
 * caller always has the original factual answer already in hand and
 * falls back to showing that, unchanged, exactly as this app behaved
 * before this feature existed.
 */
(function (global) {
  const REQUEST_TIMEOUT_MS = 6000; // must never make a rider wait long for a "nicer" answer that was already computed

  /** @returns {Promise<string | null>} */
  async function enhance(query, factualAnswer) {
    if (!global.navigator || !navigator.onLine) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${TheBusSync.API_BASE}/api/enhance-answer`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, factualAnswer }),
      });
      if (!res.ok) return null;
      const { enhanced } = await res.json();
      return typeof enhanced === 'string' && enhanced.trim() ? enhanced.trim() : null;
    } catch (err) {
      return null; // offline mid-request, timeout/abort, malformed response -- all the same to the caller: just use the factual answer
    } finally {
      clearTimeout(timer);
    }
  }

  global.TheBusGrokEnhance = { enhance };
})(window);
