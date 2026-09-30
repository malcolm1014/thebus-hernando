/**
 * Predictive search: as the rider types, this ranks the things they're most
 * likely to mean -- transit STOPS, ROUTES, and the bundled OSM PLACES/ROADS
 * corpus, plus a few command templates -- so the answer is essentially
 * forming before they finish typing. Selecting a suggestion runs the most
 * useful query for that thing (a stop -> its next bus; a place -> the
 * nearest stop; a route -> its timetable), so the real answer lands in the
 * terminal in one tap.
 *
 * Entirely offline and synchronous over the already-loaded dataset (the
 * same corpus the query engine and trip planner use). It indexes once per
 * dataset and scans a precomputed normalized string per entry, so a scan is
 * cheap enough to run on every keystroke (the caller debounces anyway).
 */
(function (global) {
  let entries = [];

  function norm(s) {
    if (global.TheBusIntentParser && typeof TheBusIntentParser.normalize === 'function') {
      try { return TheBusIntentParser.normalize(s); } catch (e) { /* fall through */ }
    }
    return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  // A handful of command templates so a rider can discover what they can
  // ask. `fill` templates put text in the box (rider completes it); others
  // are full queries that run on select.
  const COMMANDS = [
    { label: 'WHEN IS THE NEXT BUS AT ...', kw: 'when next bus at', fill: 'WHEN IS THE NEXT BUS AT ' },
    { label: 'NEAREST STOP TO ...', kw: 'nearest stop to', fill: 'NEAREST STOP TO ' },
    { label: 'PLAN <CITY> TO <CITY>', kw: 'plan trip to from', fill: 'PLAN ' },
    { label: 'FARES & TICKETS', kw: 'fares tickets how much cost pay', run: 'FARES' },
    { label: 'FROM <PLACE> TO <PLACE>', kw: 'from to trip directions', fill: 'FROM ' },
  ];

  function routeLabel(r) {
    if (r.shortName && r.longName) return `ROUTE ${r.shortName} - ${r.longName}`;
    if (r.shortName) return `ROUTE ${r.shortName}`;
    return r.longName || r.id;
  }

  function setDataset(data) {
    entries = [];
    if (!data) return;
    const push = (type, label, ref, extraNorm) => entries.push({ type, label, ref, norm: norm(`${label} ${extraNorm || ''}`) });
    for (const s of Object.values(data.stops || {})) push('stop', s.name, s);
    for (const r of Object.values(data.routes || {})) push('route', routeLabel(r), r, `${r.shortName || ''} ${r.longName || ''} route`);
    for (const p of Object.values(data.places || {})) push('place', p.name, p, (p.aliases || []).join(' '));
    for (const rd of Object.values(data.roads || {})) push('road', rd.name, rd);
  }

  const TYPE_WEIGHT = { stop: 8, route: 7, place: 6, command: 5, road: 2 };

  function matchScore(entryNorm, q) {
    if (!entryNorm) return 0;
    if (entryNorm === q) return 100;
    if (entryNorm.startsWith(q)) return 82 - Math.min(20, (entryNorm.length - q.length) * 0.1);
    if (entryNorm.includes(` ${q}`)) return 62; // word-boundary match
    if (entryNorm.includes(q)) return 42;
    return 0;
  }

  /** What to do when a suggestion is chosen: a full query to run, or text to fill. */
  function actionFor(entry) {
    switch (entry.type) {
      case 'stop': return { run: `WHEN IS THE NEXT BUS AT ${entry.label}` };
      case 'place': return { run: `NEAREST STOP TO ${entry.label}` };
      case 'road': return { run: `WHERE IS ${entry.label}` };
      case 'route': return { run: `TIMETABLE FOR ROUTE ${entry.ref.shortName || entry.ref.longName || ''}`.trim() };
      case 'command': return entry.ref.run ? { run: entry.ref.run } : { fill: entry.ref.fill };
      default: return { run: entry.label };
    }
  }

  /** A short, cheap hint shown under each suggestion (no per-keystroke network or heavy compute). */
  function hintFor(entry) {
    if (entry.type === 'stop') {
      const routes = (entry.ref.routes || []).map((r) => r.shortName || r.longName).filter(Boolean);
      return routes.length ? `STOP · RT ${[...new Set(routes)].slice(0, 6).join(', ')}` : 'STOP';
    }
    if (entry.type === 'route') return entry.ref.longName ? `ROUTE · ${entry.ref.longName}` : 'ROUTE';
    if (entry.type === 'place') return entry.ref.category ? `PLACE · ${String(entry.ref.category).split(':').pop().replace(/_/g, ' ')}` : 'PLACE';
    if (entry.type === 'road') return 'ROAD';
    if (entry.type === 'command') return 'COMMAND';
    return '';
  }

  /**
   * @returns ranked suggestions: [{ type, label, hint, run?, fill?, ref }]
   */
  function suggest(query, limit = 8) {
    const q = norm(query);
    if (!q) return [];
    const scored = [];

    if (q.length >= 1) {
      for (const cmd of COMMANDS) {
        const s = Math.max(matchScore(norm(cmd.label), q), matchScore(cmd.kw, q));
        if (s > 0) scored.push({ entry: { type: 'command', label: cmd.label, ref: cmd }, s: s + TYPE_WEIGHT.command });
      }
    }
    if (q.length >= 2) {
      for (const e of entries) {
        const base = matchScore(e.norm, q);
        if (base > 0) scored.push({ entry: e, s: base + (TYPE_WEIGHT[e.type] || 0) });
      }
    }

    scored.sort((a, b) => (b.s - a.s) || (a.entry.label.length - b.entry.label.length));

    const out = [];
    const seen = new Set();
    for (const { entry } of scored) {
      const key = `${entry.type}:${entry.label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const action = actionFor(entry);
      out.push({ type: entry.type, label: entry.label, hint: hintFor(entry), ref: entry.ref, run: action.run, fill: action.fill });
      if (out.length >= limit) break;
    }
    return out;
  }

  global.TheBusSuggest = { setDataset, suggest, actionFor, hintFor };
})(typeof window !== 'undefined' ? window : this);
