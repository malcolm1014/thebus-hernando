/**
 * Rule-based (NOT ML/LLM) intent + entity extraction, in the classic 90s
 * chatbot style: no network, no model -- this all runs synchronously
 * on-device.
 *
 * Design choices below are backed by research into real transit
 * chatbots, mature fuzzy-search libraries, address-normalization
 * standards, and disambiguation UX from established CLI tools (git,
 * apt) rather than guesswork -- specific sources cited inline at each
 * decision point.
 *
 * Example:
 *   parseQuery("When is the next bus at Avalon Publix?", index)
 *   -> {
 *        intent: "FIND_NEXT_ARRIVAL",
 *        stop: { id: "1042", name: "Avalon Publix", score: 1, alternatives: [] },
 *        route: null,
 *        raw: "When is the next bus at Avalon Publix?"
 *      }
 */
(function (global) {

  /**
   * Intent classification: WEIGHTED SCORING across every intent
   * simultaneously, not first-match-wins ordered regex (the previous
   * design). A query mentioning both "when" and "where" used to be
   * locked to whichever intent was checked first in an arbitrary list
   * order; now every intent accumulates a score from its own cues and
   * the highest total wins, so "where's the closest stop with the next
   * bus" resolves on real signal strength instead of list order.
   * Pattern verified against a real working implementation:
   * potatoes0089/transitai-utm-demo (js/intent.js) uses this exact
   * strong-cue/weak-cue additive-scoring shape for transit intents.
   *
   * Trigger phrases below are sourced from two real production transit
   * voice-assistant projects (not brainstormed): OneBusAway's Alexa
   * skill (OneBusAway/onebusaway-alexa, interaction model/utterances.txt
   * -- ~50 real phrasings Amazon's certification process required them
   * to support, including the depart/leave/coming/approaching verb
   * family and "how far away" distance framing our old trigger list
   * missed entirely) and a university shuttle skill (pem5rm/BusTracker,
   * utterances.txt -- informal "gonna arrive"/"going to be at" phrasing).
   */
  const INTENT_CUES = {
    // Checked with top priority: "nearest STOP" would otherwise mostly
    // score toward LIST_ROUTE_STOPS's "stop" cue.
    FIND_NEAREST_STOP: [
      { pattern: /\b(nearest|closest)\b/i, weight: 3 },
    ],
    // "first bus" / "last bus" is a genuinely distinct question from
    // "next bus" (needs the WHOLE day's schedule, not just what's
    // upcoming) -- no real prior-art phrase list exists for this intent
    // in any transit chatbot surveyed during research, so this trigger
    // set is original, not sourced.
    FIND_FIRST_LAST_BUS: [
      { pattern: /\b(first|last)\s+bus\b/i, weight: 3 },
      { pattern: /\bstill running\b/i, weight: 2 },
    ],
    FIND_NEXT_ARRIVAL: [
      { pattern: /\bwhen\b/i, weight: 2 },
      { pattern: /\bnext\b/i, weight: 2 },
      { pattern: /\b(arriv\w*|eta)\b/i, weight: 2 },
      { pattern: /\bhow (long|soon|far)\b/i, weight: 2 },
      { pattern: /\btime(?!table)\b/i, weight: 1 },
      { pattern: /\bdepart\w*\b/i, weight: 2 },        // OneBusAway: "when does the bus depart"
      { pattern: /\bleav(e|ing)\b/i, weight: 2 },       // OneBusAway: "when is it leaving"
      { pattern: /\b(coming|approaching)\b/i, weight: 1 }, // OneBusAway: "is the bus coming"
      { pattern: /\bfar away\b/i, weight: 1 },          // OneBusAway: "how far away is the bus"
      { pattern: /\bgonna (arrive|be)\b/i, weight: 1 }, // BusTracker: "gonna arrive"
      { pattern: /\bgoing to (arrive|be at)\b/i, weight: 1 }, // BusTracker: "going to be at"
      { pattern: /\bbus times?\b/i, weight: 1 },        // OneBusAway: bare noun-phrase queries, no verb at all
    ],
    FIND_STOP_LOCATION: [
      { pattern: /\bwhere\b/i, weight: 2 },
      { pattern: /\blocat\w*\b/i, weight: 2 },
      { pattern: /\bmap\b/i, weight: 1 },
      { pattern: /\baddress\b/i, weight: 1 },
    ],
    LIST_ROUTE_STOPS: [
      { pattern: /\bstops?\b/i, weight: 2 },
      { pattern: /\broute\b/i, weight: 1 },
      { pattern: /\bschedule\b/i, weight: 1 },
    ],
  };

  // Tie-break order when two intents land on the exact same score
  // (rare, since weights are hand-tuned to avoid it) -- most-specific
  // intent wins, same reasoning as the old first-match-wins list order.
  const INTENT_PRIORITY = ['FIND_NEAREST_STOP', 'FIND_FIRST_LAST_BUS', 'FIND_NEXT_ARRIVAL', 'FIND_STOP_LOCATION', 'LIST_ROUTE_STOPS'];

  function classifyIntent(text) {
    let bestIntent = 'UNKNOWN';
    let bestScore = 0;
    for (const intent of INTENT_PRIORITY) {
      let score = 0;
      for (const cue of INTENT_CUES[intent]) {
        if (cue.pattern.test(text)) score += cue.weight;
      }
      if (score > bestScore) {
        bestScore = score;
        bestIntent = intent;
      }
    }
    return bestIntent;
  }

  /**
   * Real U.S. street-type/directional abbreviation pairs, sourced
   * directly from libpostal's own dictionaries (openvenues/libpostal,
   * resources/dictionaries/en/street_types.txt and directionals.txt --
   * libpostal's own docs describe these as derived from USPS
   * Publication 28, the official postal abbreviation standard) rather
   * than guessed. Real Hernando County stop names are built almost
   * entirely from abbreviated road/cross-street names ("Forest Oaks
   * Blvd", "US19 Pine Forest Dr N/E"), so a rider typing the spelled-out
   * form ("Boulevard", "Drive", "Northeast") would otherwise never
   * match. Canonicalized to the SHORT form since that's what our real
   * stop-name data already uses. Restricted to safe, unambiguous
   * multi-letter forms -- deliberately skips single-letter road-type
   * abbreviations (e.g. "d" for Drive, "l" for Lane) since those
   * collide too easily with ordinary short words/initials in free text;
   * single-letter CARDINAL directions (n/s/e/w) are kept since they're
   * unambiguous and heavily used in our actual stop names ("N/E", "S/W").
   */
  const ABBREVIATIONS = {
    blvd: ['boulevard', 'bd', 'bde', 'blv', 'bl', 'blvde', 'blvrd', 'boulavard', 'boul', 'boulv', 'bvd', 'boulevarde'],
    dr: ['drive', 'drv', 'dve'],
    rd: ['road', 'ro', 'roa', 'raod'],
    ct: ['court', 'crt'],
    ln: ['lane', 'la'],
    pkwy: ['parkway', 'parkwy', 'pky', 'pkway', 'prkwy', 'prkway', 'pkw', 'pwy', 'prkw'],
    st: ['street', 'str', 'stre', 'stree', 'strt'],
    hwy: ['highway', 'hgwy', 'hw', 'hway', 'hi', 'hwye', 'hywy'],
    ave: ['avenue', 'av', 'aven', 'avenu', 'avn', 'avnu', 'avnue'],
    cir: ['circle', 'circel', 'cirlce'],
    n: ['north'],
    s: ['south'],
    e: ['east'],
    w: ['west'],
    ne: ['northeast'],
    nw: ['northwest'],
    se: ['southeast'],
    sw: ['southwest'],
  };

  const ABBREV_LOOKUP = (() => {
    const map = {};
    for (const [canonical, variants] of Object.entries(ABBREVIATIONS)) {
      for (const variant of variants) map[variant] = canonical;
    }
    return map;
  })();

  function expandAbbreviations(text) {
    return text.split(' ').map((w) => ABBREV_LOOKUP[w] || w).join(' ');
  }

  /** Lowercases, strips punctuation (keeps digits), collapses whitespace, then canonicalizes road/direction abbreviations. */
  function normalize(text) {
    const base = text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return expandAbbreviations(base);
  }

  /**
   * Jaro-Winkler similarity (0..1, 1 = identical) -- specifically suited
   * to short-string name matching, unlike plain edit distance: it gives
   * extra credit for a shared PREFIX, which fits how people actually
   * mistype place names (the error is usually in the middle/end --
   * "Wallmart"/"Publx" -- while the start is typed correctly). Standard
   * algorithm (see e.g. https://en.wikipedia.org/wiki/Jaro%E2%80%93Winkler_distance),
   * hand-implemented to stay dependency-free.
   */
  function jaroWinkler(a, b) {
    if (a === b) return 1;
    const len1 = a.length;
    const len2 = b.length;
    if (len1 === 0 || len2 === 0) return 0;

    const matchWindow = Math.max(0, Math.floor(Math.max(len1, len2) / 2) - 1);
    const aMatches = new Array(len1).fill(false);
    const bMatches = new Array(len2).fill(false);
    let matches = 0;

    for (let i = 0; i < len1; i++) {
      const start = Math.max(0, i - matchWindow);
      const end = Math.min(i + matchWindow + 1, len2);
      for (let j = start; j < end; j++) {
        if (bMatches[j] || a[i] !== b[j]) continue;
        aMatches[i] = true;
        bMatches[j] = true;
        matches++;
        break;
      }
    }
    if (matches === 0) return 0;

    let transpositions = 0;
    let k = 0;
    for (let i = 0; i < len1; i++) {
      if (!aMatches[i]) continue;
      while (!bMatches[k]) k++;
      if (a[i] !== b[k]) transpositions++;
      k++;
    }
    transpositions = transpositions / 2;

    const jaro = (matches / len1 + matches / len2 + (matches - transpositions) / matches) / 3;

    let prefixLen = 0;
    const maxPrefix = 4;
    for (let i = 0; i < Math.min(maxPrefix, len1, len2); i++) {
      if (a[i] !== b[i]) break;
      prefixLen++;
    }
    return jaro + prefixLen * 0.1 * (1 - jaro);
  }

  /**
   * Picks the single best-scoring candidate from an already-thresholded
   * list. If 2+ candidates tie at the best score, flags the OTHERS as
   * `alternatives` instead of silently guessing which one the rider
   * meant -- git's actual "did you mean" behavior (git/git help.c:
   * lists every command tied at the minimum edit distance, not just
   * one) applied to our fuzzy stop/route matching. Capped at 4 tied
   * candidates: beyond that a tie usually means the query was too
   * generic to be a meaningful disambiguation prompt, not a genuine
   * near-miss between a couple of specific places, so it silently picks
   * the longest/most-specific name instead (previous tie-break rule).
   * This mirrors OneBusAway's own production architecture
   * (OneBusAway/onebusaway-application-modules, SearchServiceImpl.java):
   * fuzzy name matches are explicitly commented "just a suggestion" and
   * never auto-committed as a confident answer the way an exact ID
   * match is -- our pass-1 exact-substring match stays fully confident,
   * only passes 2-3 go through this tie-check.
   */
  function pickBestOrFlagTie(scored) {
    const EPSILON = 0.001;
    const maxScore = Math.max(...scored.map((c) => c.score));
    const tied = scored.filter((c) => Math.abs(c.score - maxScore) < EPSILON);
    tied.sort((a, b) => b.name.length - a.name.length);
    if (tied.length === 1 || tied.length > 4) {
      return { id: tied[0].id, name: tied[0].name, score: tied[0].score, alternatives: [] };
    }
    return { id: tied[0].id, name: tied[0].name, score: tied[0].score, alternatives: tied.slice(1) };
  }

  /**
   * A bare road/highway number in a query ("on 19", "route 19") should
   * count as matching a name-token that's the same number with a
   * road-type prefix stuck to it ("us19", "sr50", "cr491") -- real
   * Hernando stop names are built that way ("Walmart US19 Spring Hill"),
   * but nobody actually SAYS the "US"/"SR"/"CR" prefix out loud. Requires
   * the character right before the matched digits (if any) to be a
   * non-digit, so "19" matches "us19" but not the "19" inside "119" or
   * "1900" -- those are different roads/numbers, not the same one typed
   * without its prefix.
   */
  function numericSuffixMatch(queryWord, nameWord) {
    if (!/^\d+$/.test(queryWord)) return false;
    if (queryWord === nameWord) return false; // exact match already handled elsewhere
    if (!nameWord.endsWith(queryWord)) return false;
    const before = nameWord[nameWord.length - queryWord.length - 1];
    return !before || !/\d/.test(before);
  }

  /**
   * Finds the best-matching entry in `candidates` (each {id, name}) inside
   * `normalizedText`. Three-pass, most-specific first:
   *   1. Exact full-name substring match (handles multi-word names like
   *      "Pine Island Park" or "Avalon Publix" cleanly) -- checked
   *      longest-candidate-first so a more specific name always wins a
   *      substring tie. Fully confident; never flags alternatives.
   *   2. Word-overlap fallback, for partial mentions ("the Publix stop").
   *      Counts both exact word matches and bare-number-vs-prefixed-number
   *      matches ("19" vs "us19", see numericSuffixMatch). Ties broken by
   *      preferring the longer (more specific) name, UNLESS 2-4 candidates
   *      tie -- then all are surfaced as alternatives.
   *   3. Jaro-Winkler typo tolerance ("Wallmart" -> "Walmart") -- last
   *      resort, only tried when the first two passes found nothing.
   * Returns { id, name, score, alternatives } or null if nothing clears
   * the threshold. `alternatives` is only ever non-empty for passes 2-3.
   */
  function fuzzyMatch(normalizedText, candidates) {
    const byLengthDesc = [...candidates].sort((a, b) => b.name.length - a.name.length);
    for (const c of byLengthDesc) {
      const n = normalize(c.name);
      if (n.length >= 3 && normalizedText.includes(n)) {
        return { id: c.id, name: c.name, score: 1, alternatives: [] };
      }
    }

    // Numeric tokens ("19", "50") stay meaningful even at 1-2 digits --
    // unlike short words, a road/highway number is highly distinctive --
    // so they're kept at any length while non-numeric words still need
    // >=3 chars to count as signal.
    const queryWords = new Set(normalizedText.split(' ').filter((w) => w.length >= 3 || /^\d+$/.test(w)));
    const wordOverlapCandidates = [];
    for (const c of candidates) {
      // Deduped so a name repeating a word (e.g. "Spring Hill Dr at
      // Spring Hill Shoppes") can't inflate its own score just by
      // saying the same word twice.
      const nameWords = [...new Set(normalize(c.name).split(' ').filter((w) => w.length >= 3))];
      if (nameWords.length === 0) continue;
      let exactHits = 0;
      let numericHits = 0;
      for (const w of nameWords) {
        if (queryWords.has(w)) { exactHits++; continue; }
        if ([...queryWords].some((qw) => numericSuffixMatch(qw, w))) numericHits++;
      }
      const hits = exactHits + numericHits;
      if (hits === 0) continue;
      const score = hits / nameWords.length;
      if (score < 0.5) continue;
      wordOverlapCandidates.push({ id: c.id, name: c.name, score, exactHits });
    }
    if (wordOverlapCandidates.length > 0) {
      // A road/highway number is shared by every stop strung along that
      // road, so on its own it's weak, common evidence -- not enough to
      // pick out one specific stop. When candidates tie on score, a
      // candidate that ALSO matched a real distinctive word (a business
      // or place name) should win outright over ones that only matched
      // the shared road number, rather than being treated as a genuine
      // ambiguous tie between equally-good guesses.
      const hasExactHit = wordOverlapCandidates.some((c) => c.exactHits > 0);
      const finalCandidates = hasExactHit
        ? wordOverlapCandidates.filter((c) => c.exactHits > 0)
        : wordOverlapCandidates;
      return pickBestOrFlagTie(finalCandidates);
    }

    // Aggregated across ALL matched query words, like pass 2 -- not just
    // the single best word-pair. A candidate that shares one incidental
    // word at high similarity (e.g. "Plaz" matching "Plaza" inside an
    // unrelated "Briarwood Plaza") must NOT outrank the real target just
    // because that one pair scored well; scaling by what fraction of the
    // CANDIDATE's own words got matched (same shape as pass 2's
    // hits/nameWords.length) fixes that -- caught via real testing
    // against actual stop data before this fix shipped.
    const jwCandidates = [];
    for (const c of candidates) {
      const nameWords = [...new Set(normalize(c.name).split(' ').filter((w) => w.length >= 4))];
      if (nameWords.length === 0) continue;
      let totalSim = 0;
      let matchedWords = 0;
      for (const queryWord of queryWords) {
        if (queryWord.length < 4) continue;
        let bestForThisWord = 0;
        for (const nameWord of nameWords) {
          if (Math.abs(nameWord.length - queryWord.length) > 3) continue; // cheap pre-filter, skip clearly-unrelated lengths
          const sim = jaroWinkler(nameWord, queryWord);
          if (sim > bestForThisWord) bestForThisWord = sim;
        }
        if (bestForThisWord >= 0.85) {
          totalSim += bestForThisWord;
          matchedWords++;
        }
      }
      if (matchedWords === 0) continue;
      const score = (totalSim / matchedWords) * (matchedWords / nameWords.length);
      if (score >= 0.5) jwCandidates.push({ id: c.id, name: c.name, score });
    }
    if (jwCandidates.length > 0) return pickBestOrFlagTie(jwCandidates);

    return null;
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
      if (byNumber) return { id: byNumber.id, name: byNumber.shortName, score: 1, alternatives: [] };
      // Some real-world feeds (Hernando County's included) leave
      // route_short_name blank and put the rider-facing number inside
      // route_long_name instead (e.g. "Route 1 Red"). Fall back to a
      // whole-word digit match there before giving up on the number.
      const byNumInLongName = routeCandidates.find((r) => new RegExp(`\\b${num}\\b`).test(r.longName || ''));
      if (byNumInLongName) return { id: byNumInLongName.id, name: byNumInLongName.longName, score: 1, alternatives: [] };
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
   * Pulls the free-text place name out of a FIND_NEAREST_STOP query --
   * this is deliberately NOT matched against known stop/route names
   * (extractStop/extractRoute), since the whole point is answering about
   * places that aren't in the transit dataset at all (a business, a
   * school, a landmark). Runs against the ORIGINAL text, not the
   * lowercased/punctuation-stripped normalized form, so the extracted
   * name keeps its real capitalization and apostrophes (geocoding
   * quality is unaffected either way, but the echoed-back name in the
   * answer reads better, and geocoders handle "Murphy's" fine either way).
   * Two patterns, most-specific first: an explicit connector word
   * ("nearest stop TO X" / "closest bus stop NEAR X"), then a bare
   * "nearest stop X" with no connector at all.
   */
  function extractLandmark(rawText) {
    let m = rawText.match(/\b(?:nearest|closest)\b.*?\b(?:to|near|by|from)\s+(.+?)[\s?.!]*$/i);
    if (m && m[1] && m[1].trim()) return m[1].trim();

    m = rawText.match(/\b(?:nearest|closest)\s+(?:bus\s+)?stop\s+(.+?)[\s?.!]*$/i);
    if (m && m[1] && m[1].trim()) return m[1].trim();

    return null;
  }

  /** For FIND_FIRST_LAST_BUS: which one is being asked about. Defaults to 'first' if the trigger somehow fired without either word literally present. */
  function extractFirstOrLast(rawText) {
    if (/\blast\b/i.test(rawText)) return 'last';
    if (/\bfirst\b/i.test(rawText)) return 'first';
    return 'first';
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
    const landmark = intent === 'FIND_NEAREST_STOP' ? extractLandmark(text) : null;
    const firstOrLast = intent === 'FIND_FIRST_LAST_BUS' ? extractFirstOrLast(text) : null;
    return { intent, route, stop, landmark, firstOrLast, raw: text };
  }

  global.TheBusIntentParser = { parseQuery, classifyIntent, normalize, fuzzyMatch, jaroWinkler };
})(window);
