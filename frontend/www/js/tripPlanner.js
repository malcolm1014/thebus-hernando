/**
 * Cross-country trip planning, client side. The offline rule engine
 * (queryEngine.js) already plans "FROM X TO Y" trips WITHIN our bundled
 * tri-county dataset; this handles the trips that leave it -- Tampa to
 * Orlando, Brooksville to Atlanta -- by calling the backend's /api/plan
 * proxy, which in turn queries the free Transitous/MOTIS network (see
 * backend/src/tripPlanner.js).
 *
 * Deliberately a SEPARATE, explicit command ("PLAN <origin> to
 * <destination>") rather than hijacking the offline "from X to Y"
 * planner: this one needs a network connection (a routed long-distance
 * itinerary can't be computed from the offline dataset) and reaches a
 * donated third-party service, so it should only fire when the rider
 * clearly asked for it. Offline, it says so plainly instead of failing.
 */
(function (global) {
  /** Recognizes "PLAN <origin> to <destination>" / "TRIP FROM <origin> TO <destination>". Returns {origin, dest} or null. */
  function parseCommand(text) {
    const m = String(text || '').match(/^\s*(?:plan|trip)\s+(?:a\s+trip\s+)?(?:from\s+)?(.+?)\s+to\s+(.+?)\s*$/i);
    if (!m) return null;
    const origin = m[1].trim();
    const dest = m[2].trim();
    if (!origin || !dest) return null;
    return { origin, dest };
  }

  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function fmtDuration(mins) {
    if (mins == null || isNaN(mins)) return '';
    if (mins < 60) return `${mins} MIN`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? `${h}H ${m}M` : `${h}H`;
  }

  function modeLabel(leg) {
    const mode = (leg.mode || '').toUpperCase();
    if (mode === 'WALK') return 'WALK';
    // For transit legs, prefer the route number + agency.
    const route = leg.routeName ? leg.routeName.toUpperCase() : mode;
    const agency = leg.agency ? ` (${leg.agency.toUpperCase()})` : '';
    return `${mode === 'BUS' ? 'BUS' : mode} ${route}${agency}`.trim();
  }

  /** Turns one planner result into retro-terminal text (multi-line string; #history renders pre-wrap). */
  function formatResult(result) {
    const from = (result.from && result.from.name ? result.from.name : 'START').toUpperCase();
    const to = (result.to && result.to.name ? result.to.name : 'DESTINATION').toUpperCase();
    const lines = [`TRIP: ${from} -> ${to}`];

    if (!result.itineraries || result.itineraries.length === 0) {
      lines.push('');
      lines.push('NO TRANSIT ROUTE FOUND BETWEEN THOSE TWO PLACES.');
      lines.push('(TRY NEARBY MAJOR STOPS, OR CHECK INTERCITY CARRIERS DIRECTLY.)');
      return lines.join('\n');
    }

    result.itineraries.forEach((it, i) => {
      lines.push('');
      const dur = fmtDuration(it.durationMinutes);
      const transfers = it.transfers === 0 ? 'DIRECT'
        : (it.transfers != null ? `${it.transfers} TRANSFER${it.transfers === 1 ? '' : 'S'}` : '');
      const head = `OPTION ${i + 1}: DEPART ${fmtTime(it.departure)} - ARRIVE ${fmtTime(it.arrival)}`;
      const meta = [dur, transfers].filter(Boolean).join(', ');
      lines.push(meta ? `${head}  (${meta})` : head);

      (it.legs || []).forEach((leg) => {
        if ((leg.mode || '').toUpperCase() === 'WALK') {
          const dist = leg.distanceMeters != null
            ? ` ${(leg.distanceMeters / 1609.34).toFixed(2)} MI`
            : '';
          const dest = leg.to ? ` TO ${leg.to.toUpperCase()}` : '';
          lines.push(`  WALK${dist}${dest} (${fmtDuration(leg.durationMinutes) || '~'})`);
        } else {
          lines.push(`  ${modeLabel(leg)}${leg.headsign ? ' -> ' + leg.headsign.toUpperCase() : ''}`);
          const board = leg.from ? leg.from.toUpperCase() : '';
          const alight = leg.to ? leg.to.toUpperCase() : '';
          lines.push(`    ${board} ${fmtTime(leg.departure)} -> ${alight} ${fmtTime(leg.arrival)}`);
        }
      });
    });

    return lines.join('\n');
  }

  /**
   * Plans a trip via the backend proxy. Resolves to a formatted terminal
   * string (success, no-route, or a clear error message) -- never throws,
   * so the caller can print whatever comes back directly.
   */
  async function plan(origin, dest) {
    if (!global.navigator || !navigator.onLine) {
      return 'TRIP PLANNING NEEDS A CONNECTION. LOCAL TRIPS WORK OFFLINE -- TRY "FROM <STOP> TO <STOP>".';
    }
    const base = global.TheBusSync && TheBusSync.API_BASE ? TheBusSync.API_BASE : '';
    const url = `${base}/api/plan?from=${encodeURIComponent(origin)}&to=${encodeURIComponent(dest)}`;
    let res;
    try {
      res = await fetch(url);
    } catch (err) {
      return 'COULD NOT REACH THE TRIP PLANNER. CHECK YOUR CONNECTION AND TRY AGAIN.';
    }
    if (res.status === 422) {
      let which = '';
      try { const body = await res.json(); which = body && body.text ? ` ("${String(body.text).toUpperCase()}")` : ''; } catch (e) { /* ignore */ }
      return `COULDN'T FIND ONE OF THOSE PLACES${which}. TRY A CITY OR A WELL-KNOWN LANDMARK.`;
    }
    if (!res.ok) {
      return 'TRIP PLANNER UNAVAILABLE RIGHT NOW. PLEASE TRY AGAIN IN A MOMENT.';
    }
    let result;
    try {
      result = await res.json();
    } catch (err) {
      return 'TRIP PLANNER RETURNED SOMETHING UNEXPECTED. PLEASE TRY AGAIN.';
    }
    return formatResult(result);
  }

  global.TheBusTripPlanner = { parseCommand, plan, formatResult };
})(typeof window !== 'undefined' ? window : this);
