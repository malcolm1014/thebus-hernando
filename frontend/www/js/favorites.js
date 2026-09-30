/**
 * The "favorites" departures board -- a rider's saved stops with each one's
 * next few arrivals, so their regular stops are one word away ("favorites")
 * instead of retyped every time. Stops are favorited from the Live Map's
 * stop popup (a star toggle); app.js builds the board from storage +
 * queryEngine.nextArrivals and prints it in the terminal.
 *
 * This module is just the pure formatting so it's testable without a DOM or
 * the query engine: given resolved stops, produce the terminal text.
 */
(function (global) {
  /**
   * @param {Array<{name, arrivals: Array<{routeLabel, minutesUntil}>}>} stops
   * @returns {string} the board text (one entry per stop, soonest arrivals first)
   */
  function formatBoard(stops) {
    if (!stops || !stops.length) {
      return 'NO FAVORITE STOPS YET. OPEN THE LIVE MAP, TAP A STOP, AND TAP "★ FAVORITE".';
    }
    const lines = ['★ YOUR STOPS'];
    for (const s of stops) {
      lines.push(`• ${String(s.name).toUpperCase()}`);
      const arrivals = Array.isArray(s.arrivals) ? s.arrivals.slice(0, 3) : [];
      if (!arrivals.length) {
        lines.push('    NO MORE ARRIVALS TODAY');
        continue;
      }
      for (const a of arrivals) {
        const mins = a.minutesUntil <= 0 ? 'DUE' : `${a.minutesUntil} MIN`;
        lines.push(`    ${String(a.routeLabel).toUpperCase()}: ${mins}`);
      }
    }
    return lines.join('\n');
  }

  global.TheBusFavorites = { formatBoard };
})(typeof window !== 'undefined' ? window : this);
