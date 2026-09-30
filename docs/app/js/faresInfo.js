/**
 * Fares and "where to buy a ticket" info, per agency. Deliberately a small
 * CURATED, BUNDLED dataset rather than pulled from a live API:
 *   - It works fully offline (a rider checking "how much / how do I pay"
 *     is often standing at a stop with no signal), matching the app's
 *     offline-first design.
 *   - GTFS fare data is inconsistent across these three agencies, and a
 *     wrong price is worse than none -- so where a current single-ride
 *     price is publicly published we state it (with a verified date), and
 *     where it isn't we say "check the official page" and link it rather
 *     than guess.
 *
 * Sources (verified 2026-09): HART gohart.org/Pages/fares-cards.aspx +
 * flamingofares.com; PascoGo pascocountyfl.gov .../gopasco/fares_and_passes;
 * Hernando hernandocounty.us/living-here/transit-thebus/fares-passes.
 * Re-check these pages periodically -- fares change.
 */
(function (global) {
  const VERIFIED = '2026-09';

  const FARES = {
    hart: {
      label: 'HART (TAMPA)',
      keywords: ['hart', 'hillsborough'],
      singleRide: '$2.00 CASH, EXACT CHANGE (ONE-WAY)',
      caps: 'FARE CAP: NEVER MORE THAN $4/DAY OR $65/MONTH',
      pay: [
        'CASH ON BOARD ($2 EXACT CHANGE)',
        'FLAMINGO FARES APP OR CARD (TAP TO RIDE)',
        'TAP-TO-PAY CREDIT/DEBIT CARD',
      ],
      app: { name: 'FLAMINGO FARES', url: 'https://www.flamingofares.com/' },
      officialUrl: 'https://www.gohart.org/Pages/fares-cards.aspx',
      notes: 'DISCOUNT CARDS FOR YOUTH (6-18), SENIORS (65+), AND RIDERS WITH DISABILITIES.',
    },
    pasco: {
      label: 'PASCOGO (PASCO COUNTY)',
      keywords: ['pasco', 'gopasco'],
      singleRide: '$1.50 ONE-WAY  ·  DAY PASS $3.75',
      caps: null,
      pay: [
        'CASH ON BOARD (EXACT CHANGE)',
        'TOKEN TRANSIT APP (BUY + ACTIVATE ON YOUR PHONE)',
        'GOPASCO OFFICE, 8620 GALEN WILSON BLVD, PORT RICHEY',
      ],
      app: { name: 'TOKEN TRANSIT', url: 'https://tokentransit.com/app' },
      officialUrl: 'https://www.pascocountyfl.gov/services/gopasco/fares_and_passes/index.php',
      notes: 'MILITARY & VETERANS RIDE FREE. REDUCED FARES FOR STUDENTS, 65+, DISABILITY, MEDICARE/VA. INFO: (727) 834-3322.',
    },
    hernando: {
      label: 'THEBUS (HERNANDO COUNTY)',
      keywords: ['hernando', 'thebus'],
      singleRide: null, // current price not published online -- link official page instead of guessing
      caps: 'FARE CAPPING: NEVER PAY MORE THAN A DAILY/WEEKLY/MONTHLY PASS',
      pay: [
        'CASH ON BOARD (EXACT CHANGE -- DRIVERS CARRY NONE)',
        'TOKEN TRANSIT APP (BUY + ACTIVATE ON YOUR PHONE)',
        'MONTHLY PAPER PASS',
      ],
      app: { name: 'TOKEN TRANSIT', url: 'https://tokentransit.com/app' },
      officialUrl: 'https://www.hernandocounty.us/living-here/transit-thebus/fares-passes/',
      notes: 'CURRENT FARE: SEE OFFICIAL PAGE OR TOKEN TRANSIT. REDUCED-FARE ELIGIBILITY: (352) 754-4444.',
    },
  };

  function forAgency(agencyId) {
    return agencyId && FARES[agencyId] ? FARES[agencyId] : null;
  }

  /** Best-effort match of a free-text agency name (e.g. from a trip-plan leg) to a fare card. */
  function matchByName(name) {
    if (!name) return null;
    const n = String(name).toLowerCase();
    for (const info of Object.values(FARES)) {
      if (info.keywords.some((k) => n.includes(k))) return info;
    }
    return null;
  }

  function all() {
    return Object.values(FARES);
  }

  /** One agency's fares as retro-terminal text. */
  function format(info) {
    if (!info) return '';
    const lines = [`FARES -- ${info.label}`];
    if (info.singleRide) lines.push(`  ${info.singleRide}`);
    if (info.caps) lines.push(`  ${info.caps}`);
    lines.push('  HOW TO PAY:');
    info.pay.forEach((p) => lines.push(`    - ${p}`));
    if (info.app) lines.push(`  TICKET APP: ${info.app.name} (${info.app.url})`);
    lines.push(`  OFFICIAL FARES PAGE: ${info.officialUrl}`);
    if (info.notes) lines.push(`  ${info.notes}`);
    lines.push(`  (VERIFIED ${VERIFIED} -- FARES CHANGE; CHECK THE OFFICIAL PAGE)`);
    return lines.join('\n');
  }

  /** All agencies (optionally one, matched by name/id) as terminal text. */
  function formatQuery(query) {
    const q = (query || '').trim().toLowerCase();
    let list = all();
    if (q) {
      const one = forAgency(q) || matchByName(q);
      if (one) list = [one];
    }
    return list.map(format).join('\n\n');
  }

  global.TheBusFares = { forAgency, matchByName, all, format, formatQuery, VERIFIED };
})(typeof window !== 'undefined' ? window : this);
