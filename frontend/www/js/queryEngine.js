/**
 * Turns a parsed intent+entities into an answer string by filtering the
 * locally-cached transit_data.json against the device's own clock. This
 * is the whole reason the data was pre-flattened server-side: everything
 * here is array filtering + arithmetic, no joins, so it's fast enough to
 * run on a phone with zero network access.
 */
(function (global) {
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

  /**
   * GTFS arrival times are the AGENCY's local wall-clock time, not UTC
   * and not necessarily the querying device's own timezone -- a phone
   * with its region/timezone set wrong (or a rider traveling with a
   * phone still on home-timezone) would otherwise get wrong "X min away"
   * answers. This reads the device's instant (`now`, a real Date, so
   * still correct in an absolute sense) but reports weekday/date/time-
   * of-day AS SEEN IN the agency's own timezone, via Intl -- no
   * date-math library needed.
   */
  function getAgencyClock(now, timeZone) {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
      weekday: 'long',
    });
    const parts = {};
    for (const p of fmt.formatToParts(now)) parts[p.type] = p.value;
    return {
      dow: parts.weekday.toLowerCase(),
      dateStr: `${parts.year}${parts.month}${parts.day}`,
      minutes: Number(parts.hour) * 60 + Number(parts.minute),
    };
  }

  function agencyTz() {
    return (dataset && dataset.agencyTimezone) || 'America/New_York';
  }

  /** Is `serviceId` running on the given (already agency-local) weekday/date? */
  function isServiceActiveForClock(serviceId, dow, dateStr) {
    const svc = dataset.services[serviceId];
    if (!svc) return false;
    if (svc.removedDates.includes(dateStr)) return false;
    if (svc.addedDates.includes(dateStr)) return true;
    if (!svc[dow]) return false;
    if (svc.startDate && dateStr < svc.startDate) return false;
    if (svc.endDate && dateStr > svc.endDate) return false;
    return true;
  }

  /** Is `serviceId` running on device instant `now`, per the agency's own calendar day? */
  function isServiceActive(serviceId, now) {
    const clock = getAgencyClock(now, agencyTz());
    return isServiceActiveForClock(serviceId, clock.dow, clock.dateStr);
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

  /** Great-circle distance in miles -- accurate enough at county scale, no external library needed. */
  function haversineMiles(lat1, lon1, lat2, lon2) {
    const R = 3958.8; // Earth's radius in miles
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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

  function toArrivalRecord(routeEntry, arr, minutesUntil, wallMinutes, isTomorrow) {
    return {
      routeId: routeEntry.routeId,
      shortName: routeEntry.shortName,
      longName: routeEntry.longName,
      headsign: arr.headsign,
      minutesUntil,
      clock: formatClock(wallMinutes),
      isTomorrow: !!isTomorrow, // rolled forward past midnight -- MUST be flagged, "AT 6:03 AM" bare reads as today's already-passed 6am, not tomorrow's first bus
    };
  }

  /**
   * Next N active arrivals for one stop, optionally filtered to a single
   * route, correct across midnight in both directions:
   *  - a trip scheduled e.g. "25:30" (>= 1440 min) belongs to a service
   *    day that STARTED YESTERDAY -- it only counts if yesterday's
   *    service was active and that after-midnight instant hasn't
   *    actually passed yet on today's real clock.
   *  - a trip already passed earlier today only rolls forward to "later"
   *    if the service actually recurs tomorrow (a Friday-only route
   *    doesn't get treated as running again a few hours after a Friday
   *    night query).
   */
  function nextArrivals(stopId, routeId, now, limit) {
    const stop = dataset.stops[stopId];
    if (!stop) return [];
    const tz = agencyTz();
    const today = getAgencyClock(now, tz);
    const yesterday = getAgencyClock(new Date(now.getTime() - 24 * 60 * 60 * 1000), tz);
    const tomorrow = getAgencyClock(new Date(now.getTime() + 24 * 60 * 60 * 1000), tz);
    const results = [];

    for (const routeEntry of stop.routes) {
      if (routeId && routeEntry.routeId !== routeId) continue;
      for (const arr of routeEntry.arrivals) {
        if (arr.minutes >= 1440) {
          const wallMinutes = arr.minutes - 1440;
          if (wallMinutes < today.minutes) continue; // that after-midnight moment already passed today
          if (!isServiceActiveForClock(arr.serviceId, yesterday.dow, yesterday.dateStr)) continue;
          results.push(toArrivalRecord(routeEntry, arr, wallMinutes - today.minutes, wallMinutes));
          continue;
        }
        if (isServiceActiveForClock(arr.serviceId, today.dow, today.dateStr) && arr.minutes >= today.minutes) {
          results.push(toArrivalRecord(routeEntry, arr, arr.minutes - today.minutes, arr.minutes));
        } else if (isServiceActiveForClock(arr.serviceId, tomorrow.dow, tomorrow.dateStr)) {
          results.push(toArrivalRecord(routeEntry, arr, (1440 - today.minutes) + arr.minutes, arr.minutes, true));
        }
      }
    }

    results.sort((a, b) => a.minutesUntil - b.minutesUntil);
    return limit ? results.slice(0, limit) : results;
  }

  /**
   * All of TODAY's active-service arrivals for a stop (optionally
   * filtered to one route), unsorted by "is this in the future" --
   * unlike nextArrivals(), which only returns what's still upcoming.
   * Used for FIND_FIRST_LAST_BUS, where "first bus" needs the day's
   * earliest scheduled time even if that time already passed hours ago.
   * Simplification, documented: doesn't attempt the yesterday-spillover
   * handling nextArrivals() does for trips scheduled past midnight --
   * acceptable for this feed (no observed overnight service), would need
   * revisiting if a future feed/agency actually runs past midnight.
   */
  function dayArrivals(stopId, routeId, now) {
    const stop = dataset.stops[stopId];
    if (!stop) return [];
    const tz = agencyTz();
    const today = getAgencyClock(now, tz);
    const results = [];
    for (const routeEntry of stop.routes) {
      if (routeId && routeEntry.routeId !== routeId) continue;
      for (const arr of routeEntry.arrivals) {
        if (!isServiceActiveForClock(arr.serviceId, today.dow, today.dateStr)) continue;
        const wallMinutes = arr.minutes % 1440;
        results.push(toArrivalRecord(routeEntry, arr, wallMinutes - today.minutes, wallMinutes));
      }
    }
    results.sort((a, b) => a.minutesUntil - b.minutesUntil);
    return results;
  }

  /** "did you mean X, Y, or Z?" when fuzzy matching found 2-4 equally-good candidates instead of one clear winner -- see intentParser.js's pickBestOrFlagTie for why this can happen (git's "did you mean" precedent: list every tied candidate, don't silently guess). */
  function disambiguationMessage(entity, kind) {
    const names = [entity.name, ...entity.alternatives.map((a) => a.name)];
    return `MULTIPLE ${kind} MATCH THAT: ${names.map((n) => n.toUpperCase()).join(' / ')}. TRY BEING MORE SPECIFIC.`;
  }

  /** Past this many minutes out, show a plain clock time instead of a countdown -- "in 47 min" implies false precision this far ahead; industry-standard cutover for transit-arrival displays. */
  const COUNTDOWN_THRESHOLD_MIN = 30;

  /**
   * Straight-line-nearest stop to a raw {lat, lon} -- shared by the GPS
   * fallback path here and in answerFindNearestStop. Distinct from that
   * function's landmark version: no geocoding, the coordinates are
   * already known (came straight off the device).
   */
  function nearestStopToPoint(lat, lon) {
    let best = null;
    for (const stop of Object.values(dataset.stops)) {
      if (stop.lat == null || stop.lon == null) continue;
      const dist = haversineMiles(lat, lon, stop.lat, stop.lon);
      if (!best || dist < best.dist) best = { stop, dist };
    }
    return best;
  }

  async function answerFindNextArrival(parsed, now) {
    let usedGps = false;
    if (!parsed.stop) {
      // No stop/landmark named at all -- fall back to the device's own
      // GPS position instead of immediately giving up, same "pull my
      // location" behavior requested for FIND_NEAREST_STOP.
      const pos = await TheBusGeolocate.getCurrentPosition();
      if (!pos) {
        return "I DIDN'T CATCH A STOP NAME. TRY: WHEN IS THE NEXT BUS AT <STOP NAME>? OR TURN ON LOCATION AND JUST ASK: WHEN IS THE NEXT BUS?";
      }
      const nearest = nearestStopToPoint(pos.lat, pos.lon);
      if (!nearest) return 'NO STOPS ON FILE.';
      parsed = { ...parsed, stop: { id: nearest.stop.id, name: nearest.stop.name, score: 1, alternatives: [] } };
      usedGps = true;
    }
    if (parsed.stop.alternatives.length > 0) return disambiguationMessage(parsed.stop, 'STOPS');
    if (parsed.route && parsed.route.alternatives.length > 0) return disambiguationMessage(parsed.route, 'ROUTES');
    const stop = dataset.stops[parsed.stop.id];

    if (parsed.route) {
      const servesStop = stop.routes.some((r) => r.routeId === parsed.route.id);
      if (!servesStop) {
        const route = dataset.routes[parsed.route.id];
        const routesHere = stop.routes.map((r) => routeLabel(r).replace(/^ROUTE /, '')).join(', ') || 'NONE ON FILE';
        return `${routeLabel(route)} DOES NOT SERVE ${stop.name.toUpperCase()}. ROUTES HERE: ${routesHere}.`;
      }
    }

    const relevantRoutes = parsed.route ? stop.routes.filter((r) => r.routeId === parsed.route.id) : stop.routes;
    const arrivals = nextArrivals(parsed.stop.id, parsed.route ? parsed.route.id : null, now, 3);

    const lines = arrivals.map((a) => {
      const day = a.isTomorrow ? 'TOMORROW ' : '';
      const timing = a.minutesUntil > COUNTDOWN_THRESHOLD_MIN
        ? `${day}AT ${a.clock}`
        : `${a.minutesUntil} MIN (${day}${a.clock})`;
      return `${routeLabel(a)} -- ${timing} TOWARD ${a.headsign.toUpperCase() || 'N/A'}`;
    });

    // A multi-route stop shouldn't just silently drop a route the rider
    // might be waiting for -- call out routes with zero upcoming
    // arrivals by name instead of collapsing everything into one
    // generic stop-level "nothing found" message.
    const routesWithArrivals = new Set(arrivals.map((a) => a.routeId));
    for (const r of relevantRoutes) {
      if (routesWithArrivals.has(r.routeId)) continue;
      // r.arrivals is the route's FULL, unfiltered arrival list (before
      // today's date/time filtering) -- if it's empty even before any
      // filtering, this route genuinely has no published times for this
      // stop at all (a non-"timepoint" stop in the feed), which is a
      // different situation from "ran today, already finished."
      lines.push(r.arrivals.length === 0
        ? `${routeLabel(r)} -- SERVES THIS STOP, BUT NO PUBLISHED TIMES ARE AVAILABLE FOR IT`
        : `${routeLabel(r)} -- NO MORE SERVICE TODAY`);
    }

    const stopLabel = usedGps ? `${stop.name.toUpperCase()} (NEAREST TO YOU)` : stop.name.toUpperCase();
    if (lines.length === 0) {
      return `NO SERVICE TODAY AT ${stopLabel}.`;
    }
    return `NEXT ARRIVALS AT ${stopLabel}:\n${lines.join('\n')}`;
  }

  function answerFindStopLocation(parsed) {
    if (!parsed.stop) {
      return "I DIDN'T CATCH A STOP NAME. TRY: WHERE IS <STOP NAME>?";
    }
    if (parsed.stop.alternatives.length > 0) return disambiguationMessage(parsed.stop, 'STOPS');
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
    if (parsed.route.alternatives.length > 0) return disambiguationMessage(parsed.route, 'ROUTES');
    const route = dataset.routes[parsed.route.id];
    const names = route.stopIds.map((id) => dataset.stops[id]?.name).filter(Boolean);
    const label = routeLabel(route);
    if (names.length === 0) return `NO STOPS ON FILE FOR ${label}.`;
    return `${label} STOPS:\n${names.map((n, i) => `${i + 1}. ${n.toUpperCase()}`).join('\n')}`;
  }

  /** "FIRST BUS" / "LAST BUS" -- distinct from "next bus": needs the whole day's schedule (dayArrivals), not just what's still upcoming, so it still answers correctly even late at night after service has ended for the day. */
  function answerFindFirstLastBus(parsed, now) {
    if (!parsed.stop) {
      return "I DIDN'T CATCH A STOP NAME. TRY: FIRST BUS AT <STOP NAME>? OR LAST BUS AT <STOP NAME>?";
    }
    if (parsed.stop.alternatives.length > 0) return disambiguationMessage(parsed.stop, 'STOPS');
    if (parsed.route && parsed.route.alternatives.length > 0) return disambiguationMessage(parsed.route, 'ROUTES');
    const stop = dataset.stops[parsed.stop.id];

    if (parsed.route) {
      const servesStop = stop.routes.some((r) => r.routeId === parsed.route.id);
      if (!servesStop) {
        const route = dataset.routes[parsed.route.id];
        const routesHere = stop.routes.map((r) => routeLabel(r).replace(/^ROUTE /, '')).join(', ') || 'NONE ON FILE';
        return `${routeLabel(route)} DOES NOT SERVE ${stop.name.toUpperCase()}. ROUTES HERE: ${routesHere}.`;
      }
    }

    const all = dayArrivals(parsed.stop.id, parsed.route ? parsed.route.id : null, now);
    if (all.length === 0) {
      return `NO SERVICE TODAY AT ${stop.name.toUpperCase()}.`;
    }
    const picked = parsed.firstOrLast === 'last' ? all[all.length - 1] : all[0];
    const label = parsed.firstOrLast === 'last' ? 'LAST BUS' : 'FIRST BUS';
    return `${label} TODAY AT ${stop.name.toUpperCase()}:\n${routeLabel(picked)} -- AT ${picked.clock} TOWARD ${picked.headsign.toUpperCase() || 'N/A'}`;
  }

  // Recognizes the rider referring to their own position instead of a
  // named place ("nearest stop to me", "closest stop to here") -- routed
  // to GPS instead of ever being handed to the geocoder, which has no
  // way to resolve "me" to anything.
  const SELF_LOCATION_RE = /^(me|here|my location|my current location|my position)$/i;

  function knownStopAnswer(landmarkLabel, stop) {
    const routesHere = stop.routes.map((r) => routeLabel(r).replace(/^ROUTE /, '')).join(', ') || 'NONE ON FILE';
    return `"${landmarkLabel.toUpperCase()}" IS A KNOWN STOP:\n${stop.name.toUpperCase()}\nSERVED BY ROUTES: ${routesHere}`;
  }

  function nearestToPointAnswer(landmarkLabel, lat, lon) {
    const best = nearestStopToPoint(lat, lon);
    if (!best) return 'NO STOPS ON FILE.';
    const routesHere = best.stop.routes.map((r) => routeLabel(r).replace(/^ROUTE /, '')).join(', ') || 'NONE ON FILE';
    return `NEAREST STOP TO ${landmarkLabel.toUpperCase()}:\n${best.stop.name.toUpperCase()} (${best.dist.toFixed(2)} MI AWAY)\nSERVED BY ROUTES: ${routesHere}`;
  }

  /**
   * Finds the closest stop to any real-world place, checked in order
   * across all 3 search tiers, cheapest/most-confident first:
   *   TIER 3 (LANGUAGE) -- this exact phrase resolved confidently
   *      before ("walmart on 19" was already looked up once) -- an
   *      instant, offline, guaranteed-consistent repeat answer, no
   *      matching or network work at all.
   *   TIER 1 (GTFS) -- the phrase is already the (informal) name of a
   *      known stop itself ("walmart on 19" for the stop "Walmart US19
   *      Spring Hill") -- checked via the SAME fuzzy stop-name matching
   *      every other intent uses, fully offline.
   *   (GPS) -- the rider's own position ("nearest stop to me") -- not
   *      cached, since "me" resolves to a different point every time.
   *   TIER 2 (PLACES) -- a real-world place (business, school,
   *      landmark) this device has successfully geocoded before --
   *      offline and instant, since it's just a local coordinate lookup
   *      now, no network round trip needed a second time.
   *   NETWORK -- a genuine place never seen before -- resolved via
   *      TheBusGeocode, the one part of this query that truly can't
   *      work offline. Successful lookups get folded into tiers 2 and 3
   *      for next time, so the app's local knowledge only ever grows.
   */
  async function answerFindNearestStop(parsed) {
    if (!parsed.landmark) {
      return "I DIDN'T CATCH A PLACE NAME. TRY: NEAREST STOP TO <PLACE>? OR: NEAREST STOP TO ME?";
    }

    await TheBusSearchIndex.ensureLoaded();
    const normalizedLandmark = TheBusIntentParser.normalize(parsed.landmark);
    const isSelf = SELF_LOCATION_RE.test(parsed.landmark.trim());

    if (!isSelf) {
      const alias = TheBusSearchIndex.lookupAlias('landmark', normalizedLandmark);
      if (alias) {
        if (alias.kind === 'stop') return knownStopAnswer(parsed.landmark, dataset.stops[alias.id]);
        if (alias.kind === 'place') {
          const place = TheBusSearchIndex.getPlaceById(alias.id);
          if (place) return nearestToPointAnswer(parsed.landmark, place.lat, place.lon);
        }
      }
    }

    const directMatch = TheBusIntentParser.fuzzyMatch(normalizedLandmark, index.stops);
    if (directMatch && directMatch.alternatives.length === 0) {
      const stop = dataset.stops[directMatch.id];
      TheBusSearchIndex.recordAlias('landmark', normalizedLandmark, { kind: 'stop', id: directMatch.id, name: stop.name });
      return knownStopAnswer(parsed.landmark, stop);
    }

    if (isSelf) {
      const pos = await TheBusGeolocate.getCurrentPosition();
      if (!pos) {
        return "COULDN'T GET YOUR LOCATION. CHECK THAT LOCATION IS TURNED ON FOR THIS APP AND TRY AGAIN.";
      }
      return nearestToPointAnswer('you', pos.lat, pos.lon);
    }

    const placeMatch = TheBusIntentParser.fuzzyMatch(normalizedLandmark, TheBusSearchIndex.getPlaceCandidates());
    if (placeMatch && placeMatch.alternatives.length === 0) {
      const place = TheBusSearchIndex.getPlaceById(placeMatch.id);
      TheBusSearchIndex.recordAlias('landmark', normalizedLandmark, { kind: 'place', id: place.id, name: place.name });
      return nearestToPointAnswer(parsed.landmark, place.lat, place.lon);
    }

    if (!navigator.onLine) {
      return `LOOKING UP "${parsed.landmark.toUpperCase()}" NEEDS A NETWORK CONNECTION. TRY AGAIN WHEN ONLINE.`;
    }

    let place;
    try {
      place = await TheBusGeocode.lookup(parsed.landmark);
    } catch (err) {
      console.error(err);
      return `COULDN'T LOOK UP "${parsed.landmark.toUpperCase()}" RIGHT NOW. TRY AGAIN IN A MOMENT.`;
    }
    if (!place) {
      return `COULDN'T FIND "${parsed.landmark.toUpperCase()}" NEAR HERNANDO COUNTY. TRY A NEARBY ROAD OR A BETTER-KNOWN LANDMARK -- VERY SMALL LOCAL BUSINESSES SOMETIMES AREN'T IN THE MAP DATA THIS APP USES.`;
    }

    const placeId = TheBusSearchIndex.recordPlace({ name: parsed.landmark, lat: place.lat, lon: place.lon });
    TheBusSearchIndex.recordAlias('landmark', normalizedLandmark, { kind: 'place', id: placeId, name: parsed.landmark });
    return nearestToPointAnswer(parsed.landmark, place.lat, place.lon);
  }

  /**
   * @param {string} text - raw rider input
   * @param {Date} now - device clock (caller-supplied so this stays pure/testable)
   */
  async function answerQuery(text, now) {
    if (!dataset) return 'DATASET NOT LOADED. CHECK YOUR CONNECTION AND RESTART.';
    const parsed = TheBusIntentParser.parseQuery(text, index);

    switch (parsed.intent) {
      case 'FIND_NEAREST_STOP': return answerFindNearestStop(parsed);
      case 'FIND_FIRST_LAST_BUS': return answerFindFirstLastBus(parsed, now);
      case 'FIND_NEXT_ARRIVAL': return answerFindNextArrival(parsed, now);
      case 'FIND_STOP_LOCATION': return answerFindStopLocation(parsed);
      case 'LIST_ROUTE_STOPS': return answerListRouteStops(parsed);
      default:
        return "COMMAND NOT RECOGNIZED. TRY:\n- WHEN IS THE NEXT BUS AT <STOP>?\n- WHERE IS <STOP>?\n- LIST STOPS ON ROUTE <N>\n- NEAREST STOP TO <PLACE>?\n- FIRST/LAST BUS AT <STOP>?";
    }
  }

  global.TheBusQueryEngine = { setDataset, getIndex, answerQuery, nextArrivals, isServiceActive };
})(window);
