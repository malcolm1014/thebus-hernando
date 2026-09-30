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
    // English by default (so the pure tests stay identical); Spanish when the
    // rider has picked it -- same tr() contract as queryEngine.js.
    const es = (global.TheBusI18n && TheBusI18n.getLang && TheBusI18n.getLang() === 'es');
    const tr = (en, esText) => (es && esText != null ? esText : en);
    if (!stops || !stops.length) {
      return tr('NO FAVORITE STOPS YET. OPEN THE LIVE MAP, TAP A STOP, AND TAP "★ FAVORITE".',
        'AÚN NO TIENES PARADAS FAVORITAS. ABRE EL MAPA EN VIVO, TOCA UNA PARADA Y TOCA "★ FAVORITE".');
    }
    const lines = [tr('★ YOUR STOPS', '★ TUS PARADAS')];
    for (const s of stops) {
      lines.push(`• ${String(s.name).toUpperCase()}`);
      const arrivals = Array.isArray(s.arrivals) ? s.arrivals.slice(0, 3) : [];
      if (!arrivals.length) {
        lines.push(tr('    NO MORE ARRIVALS TODAY', '    NO HAY MÁS LLEGADAS HOY'));
        continue;
      }
      for (const a of arrivals) {
        const mins = a.minutesUntil <= 0 ? tr('DUE', 'AHORA') : `${a.minutesUntil} MIN`;
        lines.push(`    ${String(a.routeLabel).toUpperCase()}: ${mins}`);
      }
    }
    return lines.join('\n');
  }

  global.TheBusFavorites = { formatBoard };
})(typeof window !== 'undefined' ? window : this);
