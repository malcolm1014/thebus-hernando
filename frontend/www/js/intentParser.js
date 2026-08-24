/**
 * Rule-based (NOT ML/LLM) intent + entity extraction, in the classic 90s
 * chatbot style: ordered regex triggers pick the intent, then a fuzzy
 * substring/word-overlap matcher pulls out route and stop entities by
 * comparing against the route/stop names actually present in the loaded
 * dataset. No network, no model -- this all runs synchronously on-device.
 *
 * Example:
 *   parseQuery("When is the next bus at Avalon Publix?", index)
 *   -> {
 *        intent: "FIND_NEXT_ARRIVAL",
 *        stop: { id: "1042", name: "Avalon Publix", score: 1 },
 *        route: null,
 *        raw: "When is the next bus at Avalon Publix?"
 *      }
 */
(function (global) {

  // Checked in this order: arrival questions are the dominant use case and
  // often ALSO contain the word "route" (e.g. "when's the next bus on
  // route 10"), so FIND_NEXT_ARRIVAL must be tested before the more
  // generic LIST_ROUTE_STOPS trigger on "route"/"stops" would fire.
  const INTENT_RULES = [
    { intent: 'FIND_NEXT_ARRIVAL', pattern: /\b(when|next|how (long|soon)|eta|arriv\w*|time(?!table))\b/i },
    { intent: 'FIND_STOP_LOCATION', pattern: /\b(where|map|locat\w*|address)\b/i },
    { intent: 'LIST_ROUTE_STOPS', pattern: /\b(stops?|schedule|route)\b/i },
  ];

  function classifyIntent(text) {
    for (const rule of INTENT_RULES) {
      if (rule.pattern.test(text)) return rule.intent;
    }
    return 'UNKNOWN';
  }

  /** Lowercases, strips punctuation (keeps digits), collapses whitespace. */
  function normalize(text) {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Classic edit-distance metric, used only as a last-resort typo-tolerance pass below. */
  function levenshtein(a, b) {
    const m = a.length;
    const n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const curr = [i];
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      }
      prev = curr;
    }
    return prev[n];
  }

  /**
   * Finds the best-matching entry in `candidates` (each {id, name}) inside
   * `normalizedText`. Three-pass, most-specific first:
   *   1. Exact full-name substring match (handles multi-word names like
   *      "Pine Island Park" or "Avalon Publix" cleanly) -- checked
   *      longest-candidate-first so a more specific name always wins a
   *      substring tie (e.g. "Pine Island Park" over a shorter unrelated
   *      candidate that happens to also be contained in the text).
   *   2. Word-overlap fallback, for partial mentions ("the Publix stop").
   *      Ties broken by preferring the longer (more specific) name.
   *   3. Single-word typo tolerance (Levenshtein distance) for near-miss
   *      spellings like "Wallmart" -> "Walmart" -- only tried when the
   *      first two passes found nothing, and only trusts close matches.
   * Returns { id, name, score } or null if nothing clears the threshold.
   */
  function fuzzyMatch(normalizedText, candidates) {
    let best = null;

    const byLengthDesc = [...candidates].sort((a, b) => b.name.length - a.name.length);
    for (const c of byLengthDesc) {
      const n = normalize(c.name);
      if (n.length >= 3 && normalizedText.includes(n)) {
        return { id: c.id, name: c.name, score: 1 };
      }
    }

    const queryWords = new Set(normalizedText.split(' ').filter((w) => w.length >= 3));
    for (const c of candidates) {
      // Deduped so a name repeating a word (e.g. "Spring Hill Dr at
      // Spring Hill Shoppes") can't inflate its own score just by
      // saying the same word twice.
      const nameWords = [...new Set(normalize(c.name).split(' ').filter((w) => w.length >= 3))];
      if (nameWords.length === 0) continue;
      const hits = nameWords.filter((w) => queryWords.has(w)).length;
      if (hits === 0) continue;
      const score = hits / nameWords.length;
      if (score < 0.5) continue;
      if (!best || score > best.score || (score === best.score && c.name.length > best.name.length)) {
        best = { id: c.id, name: c.name, score };
      }
    }
    if (best) return best;

    let bestDist = Infinity;
    for (const c of candidates) {
      const nameWords = normalize(c.name).split(' ').filter((w) => w.length >= 4);
      for (const nameWord of nameWords) {
        for (const queryWord of queryWords) {
          if (Math.abs(nameWord.length - queryWord.length) > 2) continue; // cheap pre-filter, skip clearly-unrelated lengths
          const dist = levenshtein(nameWord, queryWord);
          const threshold = nameWord.length <= 5 ? 1 : 2;
          if (dist <= threshold && dist < bestDist) {
            bestDist = dist;
            best = { id: c.id, name: c.name, score: 1 - dist / Math.max(nameWord.length, queryWord.length) };
          }
        }
      }
    }
    return best;
  }

  /**
   * Pulls a route entity out of the text. Checks explicit "Route 10" /
   * "Route #10" style mentions first (unambiguous), then falls back to
   * fuzzy-matching against known route short/long names and color
   * nicknames (e.g. "the Red route", "Mermaid").
   */
  function extractRoute(normalizedText, routeCandidates) {
    const numMatch = normalizedText.match(/\broute\s*#?\s*(\d+)\b/);
    if (numMatch) {
      const num = numMatch[1];
      const byNumber = routeCandidates.find((r) => r.shortName === num);
      if (byNumber) return { id: byNumber.id, name: byNumber.shortName, score: 1 };
      // Some real-world feeds (Hernando County's included) leave
      // route_short_name blank and put the rider-facing number inside
      // route_long_name instead (e.g. "Route 1 Red"). Fall back to a
      // whole-word digit match there before giving up on the number.
      const byNumInLongName = routeCandidates.find((r) => new RegExp(`\\b${num}\\b`).test(r.longName || ''));
      if (byNumInLongName) return { id: byNumInLongName.id, name: byNumInLongName.longName, score: 1 };
    }
    const named = fuzzyMatch(
      normalizedText,
      routeCandidates.map((r) => ({ id: r.id, name: r.longName || r.shortName }))
    );
    return named;
  }

  function extractStop(normalizedText, stopCandidates) {
    return fuzzyMatch(normalizedText, stopCandidates.map((s) => ({ id: s.id, name: s.name })));
  }

  /**
   * @param {string} text - raw user input
   * @param {{routes: Array<{id,shortName,longName}>, stops: Array<{id,name}>}} index
   *   Built by queryEngine.buildIndex() from the loaded transit_data.json
   *   -- entity extraction is only ever matched against real, current data.
   */
  function parseQuery(text, index) {
    const normalizedText = normalize(text);
    const intent = classifyIntent(text);
    const route = extractRoute(normalizedText, index.routes);
    const stop = extractStop(normalizedText, index.stops);
    return { intent, route, stop, raw: text };
  }

  global.TheBusIntentParser = { parseQuery, classifyIntent, normalize, fuzzyMatch };
})(window);
