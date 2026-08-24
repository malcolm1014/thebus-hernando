/**
 * Turns a parsed intent+entities into an answer string by filtering the
 * locally-cached transit_data.json against the device's own clock. This
 * is the whole reason the data was pre-flattened server-side: everything
 * here is array filtering + arithmetic, no joins, so it's fast enough to
 * run on a phone with zero network access.
 */
(function (global) {
  const DOW_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

  let dataset = null;
  let index = null; // { routes: [{id, shortName, longName}], stops: [{id, name}] }

  function setDataset(data) {
    dataset = data;
    index = {
      routes: Object.values(data.routes).map((r) => ({ id: r.id, shortName: r.shortName, longName: r.longName })),
      stops: Object.values(data.stops).map((s) => ({ id: s.id, name: s.name })),
    };
  }

  function getIndex() {
    return index;
  }

  /** yyyymmdd string for a Date, in local device time -- matches GTFS calendar_dates format. */
  function toGtfsDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}${m}${day}`;
  }

  /** Is `serviceId` running on device date `now`? Checks weekday flags, the calendar date range, then exceptions. */
  function isServiceActive(serviceId, now) {
    const svc = dataset.services[serviceId];
    if (!svc) return false;
    const dateStr = toGtfsDate(now);

    if (svc.removedDates.includes(dateStr)) return false;
    if (svc.addedDates.includes(dateStr)) return true;

    const dow = DOW_KEYS[now.getDay()];
    if (!svc[dow]) return false;
    if (svc.startDate && dateStr < svc.startDate) return false;
    if (svc.endDate && dateStr > svc.endDate) return false;
    return true;
  }

  function minutesNow(now) {
    return now.getHours() * 60 + now.getMinutes();
  }

  /**
   * Some real-world feeds (Hernando County's included) leave
   * route_short_name entirely blank and put the whole rider-facing name
   * ("Blue", "Route 1 Red") in route_long_name instead. This picks
   * whichever field is populated and avoids a redundant "ROUTE ROUTE 1
   * RED" when the long name already starts with "Route".
   */
  function routeLabel(route) {
    const short = (route.shortName || '').trim();
    const long = (route.longName || '').trim();
    if (short && long && short.toLowerCase() !== long.toLowerCase()) {
      return `ROUTE ${short} (${long.toUpperCase()})`;
    }
    const name = short || long;
    if (!name) return 'ROUTE (UNNAMED)';
    return /^route\b/i.test(name) ? name.toUpperCase() : `ROUTE ${name.toUpperCase()}`;
  }

  function formatClock(minutesPastMidnight) {
    const m = ((Math.round(minutesPastMidnight) % 1440) + 1440) % 1440;
    let h = Math.floor(m / 60);
    const min = m % 60;
    const suffix = h >= 12 ? 'PM' : 'AM';
    h = h % 12;
    if (h === 0) h = 12;
    return `${h}:${String(min).padStart(2, '0')} ${suffix}`;
  }

  /** Next N active arrivals for one stop, optionally filtered to a single route. */
  function nextArrivals(stopId, routeId, now, limit) {
    const stop = dataset.stops[stopId];
    if (!stop) return [];
    const nowMin = minutesNow(now);
    const results = [];

    for (const routeEntry of stop.routes) {
      if (routeId && routeEntry.routeId !== routeId) continue;
      for (const arr of routeEntry.arrivals) {
        if (!isServiceActive(arr.serviceId, now)) continue;
        // GTFS times can exceed 1440 for past-midnight trips; treat those
        // as "later today" by taking minutes mod 1440 relative to now.
        const arrMinToday = arr.minutes % 1440;
        let delta = arrMinToday - nowMin;
        if (delta < 0) delta += 1440; // wraps to "tomorrow" within the same active service day
        results.push({
          routeId: routeEntry.routeId,
          shortName: routeEntry.shortName,
          longName: routeEntry.longName,
          headsign: arr.headsign,
          minutesUntil: delta,
          clock: formatClock(arrMinToday),
        });
      }
    }

    results.sort((a, b) => a.minutesUntil - b.minutesUntil);
    return limit ? results.slice(0, limit) : results;
  }

  function answerFindNextArrival(parsed, now) {
    if (!parsed.stop) {
      return "I DIDN'T CATCH A STOP NAME. TRY: WHEN IS THE NEXT BUS AT <STOP NAME>?";
    }
    const arrivals = nextArrivals(parsed.stop.id, parsed.route ? parsed.route.id : null, now, 3);
    if (arrivals.length === 0) {
      return `NO UPCOMING ARRIVALS FOUND AT ${parsed.stop.name.toUpperCase()} TODAY.`;
    }
    const lines = arrivals.map((a) =>
      `${routeLabel(a)} -- ${a.minutesUntil} MIN (${a.clock}) TOWARD ${a.headsign.toUpperCase() || 'N/A'}`
    );
    return `NEXT ARRIVALS AT ${parsed.stop.name.toUpperCase()}:\n${lines.join('\n')}`;
  }

  function answerFindStopLocation(parsed) {
    if (!parsed.stop) {
      return "I DIDN'T CATCH A STOP NAME. TRY: WHERE IS <STOP NAME>?";
    }
    const stop = dataset.stops[parsed.stop.id];
    const routeList = stop.routes.map((r) => routeLabel(r).replace(/^ROUTE /, '')).join(', ') || 'NONE ON FILE';
    const coords = (stop.lat != null && stop.lon != null)
      ? `${stop.lat.toFixed(5)}, ${stop.lon.toFixed(5)}`
      : 'UNAVAILABLE';
    return `STOP: ${stop.name.toUpperCase()}\nCOORDINATES: ${coords}\nSERVED BY ROUTES: ${routeList}`;
  }

  function answerListRouteStops(parsed) {
    if (!parsed.route) {
      return "I DIDN'T CATCH A ROUTE. TRY: LIST STOPS ON ROUTE 10.";
    }
    const route = dataset.routes[parsed.route.id];
    const names = route.stopIds.map((id) => dataset.stops[id]?.name).filter(Boolean);
    const label = routeLabel(route);
    if (names.length === 0) return `NO STOPS ON FILE FOR ${label}.`;
    return `${label} STOPS:\n${names.map((n, i) => `${i + 1}. ${n.toUpperCase()}`).join('\n')}`;
  }

  /**
   * @param {string} text - raw rider input
   * @param {Date} now - device clock (caller-supplied so this stays pure/testable)
   */
  function answerQuery(text, now) {
    if (!dataset) return 'DATASET NOT LOADED. CHECK YOUR CONNECTION AND RESTART.';
    const parsed = TheBusIntentParser.parseQuery(text, index);

    switch (parsed.intent) {
      case 'FIND_NEXT_ARRIVAL': return answerFindNextArrival(parsed, now);
      case 'FIND_STOP_LOCATION': return answerFindStopLocation(parsed);
      case 'LIST_ROUTE_STOPS': return answerListRouteStops(parsed);
      default:
        return "COMMAND NOT RECOGNIZED. TRY:\n- WHEN IS THE NEXT BUS AT <STOP>?\n- WHERE IS <STOP>?\n- LIST STOPS ON ROUTE <N>";
    }
  }

  global.TheBusQueryEngine = { setDataset, getIndex, answerQuery, nextArrivals, isServiceActive };
})(window);
