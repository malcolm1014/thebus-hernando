/**
 * Feed-freshness guard.
 *
 * A GTFS feed carries a service calendar: each service_id is valid only
 * within a date window (calendar.txt start/end) plus any explicit
 * exception dates (calendar_dates.txt). Once EVERY service's window has
 * elapsed, the feed describes only service that no longer runs -- every
 * schedule answer the app computes from it becomes "no service today",
 * even though the stops and routes still draw on the map. That's a worse
 * rider experience than the agency simply not being present.
 *
 * This is a real, concrete risk, not a hypothetical: Citrus County
 * Transit's only publicly-mirrored GTFS (Mobility Database mdb-2257) is a
 * Nov-2024 feed whose calendar ended 2025-01-01 -- activating it would
 * show a dead agency. And any live agency's feed can quietly lapse if the
 * operator stops republishing (a transit agency letting its GTFS go stale
 * is common). So the ETL refuses to adopt a fully-elapsed feed for ANY
 * agency, Citrus or otherwise.
 *
 * Pure and dependency-free so it can be unit-tested without the rest of
 * the ETL, same as liveBusSanity.js.
 */

/** JS Date -> GTFS "YYYYMMDD" string (local time; a one-day fuzz at
 *  midnight is irrelevant to a guard that catches months-stale feeds). */
function toGtfsDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/**
 * Does this transformed agency dataset still describe service that runs
 * today or later? True if ANY service_id either (a) has a regular
 * calendar window whose end date is today or in the future, or (b) adds
 * at least one exception date (calendar_dates.txt) that is today or
 * later. GTFS dates are fixed-width "YYYYMMDD", so a plain string compare
 * is a correct date compare.
 *
 * A dataset with no services at all is treated as NOT current -- there's
 * nothing to ride.
 *
 * @param {{services?: Object}} data   a transform() result
 * @param {Date} [now]                 injectable clock for testing
 * @returns {boolean}
 */
function hasCurrentService(data, now = new Date()) {
  const today = toGtfsDate(now);
  const services = (data && data.services) || {};
  for (const svc of Object.values(services)) {
    if (!svc) continue;
    // (a) regular calendar window still open (end date today or later)
    if (svc.endDate && String(svc.endDate) >= today) return true;
    // (b) an exception date adds service today or in the future
    const added = Array.isArray(svc.addedDates) ? svc.addedDates : [];
    for (const d of added) {
      if (d != null && String(d) >= today) return true;
    }
  }
  return false;
}

module.exports = { hasCurrentService, toGtfsDate };
