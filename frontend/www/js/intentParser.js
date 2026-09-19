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
   * Maps a spoken/typed category phrase to the OSM tag value(s)
   * (backend/scripts/osm-transform.js's `category` field, e.g.
   * "shop:pharmacy") that answer it -- an array because a real-world
   * concept sometimes spans more than one OSM tag (a "pharmacy" is
   * tagged shop=chemist OR amenity=pharmacy depending on the mapper).
   * Deliberately a curated, common-sense list of things a transit rider
   * would actually ask for near a bus stop, not an exhaustive OSM tag
   * dictionary.
   */
  const CATEGORY_ALIASES = {
    'pharmacy': ['amenity:pharmacy', 'shop:chemist'],
    'drug store': ['amenity:pharmacy', 'shop:chemist'],
    'gas station': ['amenity:fuel'],
    'petrol station': ['amenity:fuel'],
    'grocery store': ['shop:supermarket', 'shop:grocery'],
    'grocery': ['shop:supermarket', 'shop:grocery'],
    'supermarket': ['shop:supermarket'],
    'bank': ['amenity:bank'],
    'atm': ['amenity:atm'],
    'restaurant': ['amenity:restaurant'],
    'fast food': ['amenity:fast_food'],
    'coffee shop': ['amenity:cafe'],
    'cafe': ['amenity:cafe'],
    'hospital': ['amenity:hospital'],
    'urgent care': ['amenity:clinic'],
    'clinic': ['amenity:clinic'],
    'post office': ['amenity:post_office'],
    'library': ['amenity:library'],
    'park': ['leisure:park'],
    'hotel': ['tourism:hotel'],
    'motel': ['tourism:motel'],
    'laundromat': ['shop:laundry'],
    'liquor store': ['shop:alcohol'],
    'convenience store': ['shop:convenience'],
    'hardware store': ['shop:hardware'],
    'church': ['amenity:place_of_worship'],
  };

  // Longest phrase first, so "grocery store" matches as one phrase
  // rather than the shorter "grocery" alternative winning inside the
  // regex alternation first.
  const CATEGORY_PHRASES = Object.keys(CATEGORY_ALIASES).sort((a, b) => b.length - a.length);
  const CATEGORY_ALTERNATION = CATEGORY_PHRASES.map((p) => p.replace(/\s+/g, '\\s+')).join('|');

  /**
   * A category word is only a meaningful FIND_NEAREST_PLACE signal
   * paired with an actual request phrase -- a BARE category word alone
   * (no `requiredPrefix`) is deliberately not offered as an option here:
   * real GTFS stop/landmark names routinely contain ordinary English
   * words that happen to collide with a category ("Pine Island PARK" is
   * a bus stop, not a request for the nearest park) -- confirmed as a
   * real regression risk against this app's own existing test corpus,
   * not a hypothetical one, before this function existed.
   */
  function buildCategoryCue(requiredPrefix) {
    return new RegExp(`\\b${requiredPrefix}\\b[\\s\\S]*?\\b(${CATEGORY_ALTERNATION})\\b`, 'i');
  }

  /** Which CATEGORY_ALIASES value(s) (if any) a query is asking about. Only meaningful for FIND_NEAREST_PLACE. */
  function extractPlaceCategory(normalizedText) {
    for (const phrase of CATEGORY_PHRASES) {
      if (normalizedText.includes(phrase)) return CATEGORY_ALIASES[phrase];
    }
    return null;
  }

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
    // "from X to Y" is a very strong, distinctive signal on its own --
    // weighted well above every other intent's cues so a trip-planning
    // question never gets crowded out just because it also happens to
    // contain "when"/"next"/etc. ("how do I get from X to Y and when's
    // the next bus").
    PLAN_TRIP: [
      { pattern: /\bfrom\b[\s\S]*?\bto\b/i, weight: 4 },
      { pattern: /\bhow do i get\b/i, weight: 2 },
      { pattern: /\bdirections?\b/i, weight: 2 },
      { pattern: /\btrip\b/i, weight: 1 },
      { pattern: /\btransfers?\b/i, weight: 1 },
    ],
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
      // A rider asking a genuinely BROAD, no-stop-named question ("any
      // buses nearby", "is the bus close") is still asking the exact
      // same underlying question as "when's the next bus" -- they just
      // never named a stop because they expect the app to use their
      // location instead. Without these, a query like "any buses
      // nearby" scored 0 on every intent and fell to the generic
      // "COMMAND NOT RECOGNIZED" help text instead of ever reaching
      // FIND_NEXT_ARRIVAL's own existing no-stop-named GPS fallback
      // (answerFindNextArrival, queryEngine.js) -- these cues exist
      // purely to get such queries classified correctly, not to change
      // what happens once they are.
      { pattern: /\bnearby\b/i, weight: 1 },
      { pattern: /\bnear me\b/i, weight: 1 },
      { pattern: /\bclose\b/i, weight: 1 },
      { pattern: /\bclose by\b/i, weight: 1 },
      { pattern: /\bin the area\b/i, weight: 1 },
      { pattern: /\baround (me|here)\b/i, weight: 1 },
      // "What about X?" is a real, common follow-up shape in an ongoing
      // conversation ("what about route 5?", "what about the next one?")
      // -- without this, "what about route 5?" alone scores 0 on this
      // intent and 1 on LIST_ROUTE_STOPS (the bare word "route"), so it
      // was answered as "list every stop on route 5" instead of "what's
      // route 5's next arrival at the stop we were just discussing."
      // Weighted to beat that 1-point LIST_ROUTE_STOPS collision but stay
      // low enough that a genuinely unrelated "how about" phrase
      // elsewhere doesn't hijack an otherwise-clear different intent.
      // Consumed by queryEngine.js's conversational-context tracking
      // (lastContext) -- see its own comment for how a bare follow-up
      // like this actually gets answered once classified correctly here.
      { pattern: /\b(what about|how about)\b/i, weight: 2 },
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
    // A genuinely distinct question from LIST_ROUTE_STOPS's bare
    // "schedule" cue (kept deliberately narrow, not just "schedule"
    // alone, to protect the existing regression guard: "what's the
    // schedule for route 7" must keep resolving to LIST_ROUTE_STOPS,
    // see intentParser.test.js) -- "timetable"/"all the times" asks for
    // every published departure, not the route's stop list.
    SHOW_TIMETABLE: [
      { pattern: /\btimetable\b/i, weight: 3 },
      { pattern: /\bfull schedule\b/i, weight: 3 },
      { pattern: /\ball (the )?times\b/i, weight: 2 },
      { pattern: /\bevery (departure|time|arrival)\b/i, weight: 2 },
    ],
    // "Nearest STOP" (FIND_NEAREST_STOP, weight 3 on nearest/closest
    // alone) vs. "nearest PHARMACY" are genuinely different questions --
    // one wants a bus stop, the other a business. Weighted at 5 so it
    // reliably outscores FIND_NEAREST_STOP's bare 3. Every cue here
    // REQUIRES an explicit request phrase alongside the category word
    // (never a bare category word alone) -- see buildCategoryCue's own
    // comment on why that's a real, not hypothetical, regression risk.
    FIND_NEAREST_PLACE: [
      { pattern: buildCategoryCue('(nearest|closest)'), weight: 5 },
      { pattern: buildCategoryCue('is there (a|an|any)'), weight: 4 },
      { pattern: buildCategoryCue('find (a|an|the|me a|me an)'), weight: 4 },
    ],
    // On-device turn-by-turn walking directions (see
    // plugins/valhalla-routing) -- a genuinely different question from
    // PLAN_TRIP's bus-trip planning ("how do I get from X to Y" already
    // means "plan a bus trip"), so this only fires on an explicit
    // "walking" mention, never a bare "directions" alone (which would
    // otherwise collide with PLAN_TRIP's "directions" cue).
    FIND_WALKING_DIRECTIONS: [
      { pattern: /\bwalking directions?\b/i, weight: 5 },
      { pattern: /\bwalk(?:ing)?\s+to\b/i, weight: 4 },
      { pattern: /\bhow (?:do|can) i walk\b/i, weight: 4 },
    ],
    // The one-time opt-in download this feature needs (~164MB, see
    // valhallaTiles.js) -- deliberately its own explicit command rather
    // than an automatic background fetch, so a rider always chooses to
    // spend that data. Scored well above every other intent's cues
    // since "download"/"enable" essentially never appear in an
    // ordinary transit query.
    DOWNLOAD_ROUTING_TILES: [
      { pattern: /\bdownload\b[\s\S]*\b(walking )?directions?\b/i, weight: 6 },
      { pattern: /\benable\b[\s\S]*\b(walking )?directions?\b/i, weight: 6 },
      { pattern: /\bdownload\b[\s\S]*\brouting\b/i, weight: 6 },
    ],
  };

  // Tie-break order when two intents land on the exact same score
  // (rare, since weights are hand-tuned to avoid it) -- most-specific
  // intent wins, same reasoning as the old first-match-wins list order.
  const INTENT_PRIORITY = ['DOWNLOAD_ROUTING_TILES', 'PLAN_TRIP', 'FIND_WALKING_DIRECTIONS', 'FIND_NEAREST_PLACE', 'FIND_NEAREST_STOP', 'FIND_FIRST_LAST_BUS', 'SHOW_TIMETABLE', 'FIND_NEXT_ARRIVAL', 'FIND_STOP_LOCATION', 'LIST_ROUTE_STOPS'];

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
  /**
   * Collapses multiple name variants of the SAME entity (its official
   * name plus a learned alias, e.g. "Walmart US19 Spring Hill" and
   * "walmart on 19" both pointing at stop id W1) down to that entity's
   * single best-scoring match. Without this, two phrasings that happen
   * to score similarly would wrongly register as an ambiguous tie
   * between "two" candidates that are actually one and the same stop.
   */
  function dedupeBestPerId(scored) {
    const bestById = new Map();
    for (const c of scored) {
      const existing = bestById.get(c.id);
      if (!existing || c.score > existing.score) bestById.set(c.id, c);
    }
    return [...bestById.values()];
  }

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
      return pickBestOrFlagTie(dedupeBestPerId(finalCandidates));
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
    if (jwCandidates.length > 0) return pickBestOrFlagTie(dedupeBestPerId(jwCandidates));

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

  /** Same fuzzy-match shape as extractStop, against the bundled OSM business/POI corpus (queryEngine.js's index.places) instead of GTFS stops. */
  function extractPlace(normalizedText, placeCandidates) {
    return fuzzyMatch(normalizedText, placeCandidates.map((p) => ({ id: p.id, name: p.name })));
  }

  /** Same fuzzy-match shape as extractStop, against the bundled OSM named-road corpus (queryEngine.js's index.roads). */
  function extractRoad(normalizedText, roadCandidates) {
    return fuzzyMatch(normalizedText, roadCandidates.map((r) => ({ id: r.id, name: r.name })));
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

  /**
   * Pulls origin/destination free text out of a PLAN_TRIP query --
   * same philosophy as extractLandmark: NOT matched against known
   * stop/route names here, since either end can be a real-world place
   * (a business, a school) just as easily as a known stop. Runs against
   * the ORIGINAL text (keeps capitalization/apostrophes for a nicer
   * echoed-back label and for geocoding, same as extractLandmark).
   * "from X to Y" is checked first (the overwhelmingly common phrasing,
   * and what PLAN_TRIP's own strongest intent cue is keyed on); "to Y
   * from X" is supported as a fallback for the reverse phrasing. Both
   * are non-greedy on the origin capture, so the FIRST "to" after "from"
   * wins -- correct for "I need to go from Publix to Kass Circle" (the
   * earlier "to" inside "need to go" sits before "from", so it's never
   * in scope) but, like every other regex-based extraction in this file,
   * can be fooled by a place name that itself contains the word "to" or
   * "from".
   */
  function extractTripEndpoints(rawText) {
    let m = rawText.match(/\bfrom\s+(.+?)\s+to\s+(.+?)[\s?.!]*$/i);
    if (m && m[1].trim() && m[2].trim()) return { origin: m[1].trim(), destination: m[2].trim() };

    m = rawText.match(/\bto\s+(.+?)\s+from\s+(.+?)[\s?.!]*$/i);
    if (m && m[1].trim() && m[2].trim()) return { origin: m[2].trim(), destination: m[1].trim() };

    return null;
  }

  /**
   * Pulls the free-text destination out of a FIND_WALKING_DIRECTIONS
   * query -- same philosophy as extractLandmark: NOT matched against
   * known stop/route names here, since the destination is just as
   * likely a business as a bus stop. Always GPS-anchored on the origin
   * side (see queryEngine.js's answerFindWalkingDirections) -- this app
   * doesn't yet support an explicit "walking directions from X to Y",
   * only "...to Y" from wherever the rider actually is.
   */
  function extractWalkingDestination(rawText) {
    let m = rawText.match(/\bwalking directions?\s+(?:to|for)\s+(.+?)[\s?.!]*$/i);
    if (m && m[1] && m[1].trim()) return m[1].trim();

    m = rawText.match(/\bwalk(?:ing)?\s+to\s+(.+?)[\s?.!]*$/i);
    if (m && m[1] && m[1].trim()) return m[1].trim();

    m = rawText.match(/\bhow (?:do|can) i walk to\s+(.+?)[\s?.!]*$/i);
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
   * @param {{routes: Array<{id,shortName,longName}>, stops: Array<{id,name}>, places?: Array<{id,name}>, roads?: Array<{id,name}>}} index
   *   Built by queryEngine.buildIndex() from the loaded transit_data.json
   *   -- entity extraction is only ever matched against real, current data.
   *   `places`/`roads` are the bundled OSM corpus (absent, or empty, on a
   *   dataset synced before that feature existed -- handled the same way
   *   `stops[].aliases` already is elsewhere in this file).
   */
  function parseQuery(text, index) {
    const normalizedText = normalize(text);
    const intent = classifyIntent(text);
    const route = extractRoute(normalizedText, index.routes);
    const stop = extractStop(normalizedText, index.stops);
    // Always extracted (not gated on intent), same as route/stop above --
    // FIND_STOP_LOCATION's "WHERE IS X" falls back to whichever of these
    // actually matched when X isn't a known stop (see queryEngine.js's
    // answerFindStopLocation).
    const place = extractPlace(normalizedText, index.places || []);
    const road = extractRoad(normalizedText, index.roads || []);
    const placeCategory = intent === 'FIND_NEAREST_PLACE' ? extractPlaceCategory(normalizedText) : null;
    const landmark = (intent === 'FIND_NEAREST_STOP' || intent === 'FIND_NEAREST_PLACE') ? extractLandmark(text) : null;
    const walkingDestination = intent === 'FIND_WALKING_DIRECTIONS' ? extractWalkingDestination(text) : null;
    const firstOrLast = intent === 'FIND_FIRST_LAST_BUS' ? extractFirstOrLast(text) : null;
    const tripEndpoints = intent === 'PLAN_TRIP' ? extractTripEndpoints(text) : null;
    return {
      intent, route, stop, place, road, placeCategory, landmark, walkingDestination, firstOrLast,
      origin: tripEndpoints ? tripEndpoints.origin : null,
      destination: tripEndpoints ? tripEndpoints.destination : null,
      raw: text,
    };
  }

  global.TheBusIntentParser = { parseQuery, classifyIntent, normalize, fuzzyMatch, jaroWinkler, extractPlaceCategory, CATEGORY_ALIASES };
})(window);
