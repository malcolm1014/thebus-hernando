/**
 * Terminal UI glue: renders the scrolling history and drives the
 * sync -> parse -> query pipeline. The command line itself is a real,
 * visible <input> styled to look like terminal text -- not a hidden
 * proxy mirrored into a fake element (a prior version tried that, and
 * it broke Android keyboards' own cursor/composition tracking on-device:
 * confirmed reversed text entry, then broken backspace, across two
 * different mitigation attempts). Letting the OS keyboard own a real
 * input directly means cursor, backspace, and IME composition are all
 * handled natively -- we only touch `.value` on submit and on history
 * recall, never mid-keystroke.
 */
(function () {
  const historyEl = document.getElementById('history');
  const commandInput = document.getElementById('command-input');
  const bootStatus = document.getElementById('boot-status');

  const commandLog = [];
  let historyPointer = -1;

  // ---- CRT effects toggle (flicker/scanlines/bloom), independent of
  // the OS's prefers-reduced-motion -- see storage.js's getEffectsEnabled
  // for why this exists as its own setting. ----
  const crtEl = document.getElementById('crt');
  const fxToggle = document.getElementById('fx-toggle');

  function applyEffectsEnabled(enabled) {
    crtEl.classList.toggle('effects-off', !enabled);
    fxToggle.textContent = enabled ? '[ EFFECTS: ON ]' : '[ EFFECTS: OFF ]';
    fxToggle.setAttribute('aria-pressed', String(enabled));
  }

  fxToggle.addEventListener('click', async () => {
    const enabled = !(await TheBusStorage.getEffectsEnabled());
    await TheBusStorage.setEffectsEnabled(enabled);
    applyEffectsEnabled(enabled);
  });

  TheBusStorage.getEffectsEnabled()
    .then(applyEffectsEnabled)
    .catch((err) => console.error('effects toggle: failed to read stored preference, leaving effects on', err));

  // ---- High-contrast accessibility mode (opt-in) ----
  const contrastToggle = document.getElementById('contrast-toggle');
  function applyHighContrast(enabled) {
    document.documentElement.setAttribute('data-contrast', enabled ? 'high' : 'normal');
    contrastToggle.textContent = enabled ? '[ HIGH CONTRAST: ON ]' : '[ HIGH CONTRAST: OFF ]';
    contrastToggle.setAttribute('aria-pressed', String(enabled));
  }
  contrastToggle.addEventListener('click', async () => {
    const enabled = !(await TheBusStorage.getHighContrast());
    await TheBusStorage.setHighContrast(enabled);
    applyHighContrast(enabled);
  });
  TheBusStorage.getHighContrast()
    .then(applyHighContrast)
    .catch((err) => console.error('contrast toggle: failed to read stored preference', err));

  // ---- Crash reporting -- see backend's /api/crash-report for what
  // this deliberately does NOT send (query text, location). Best-effort:
  // never blocks anything, never throws itself, silently gives up if
  // offline or if the request fails. Deduped by message text and capped
  // per session so a rapidly-repeating error (e.g. one firing on every
  // animation frame) can't turn into a flood of outbound requests. ----
  const reportedMessages = new Set();
  const MAX_CRASH_REPORTS_PER_SESSION = 20;
  let crashReportCount = 0;

  function currentScreenLabel() {
    const tabMapEl = document.getElementById('tab-map');
    return (tabMapEl && tabMapEl.classList.contains('active')) ? 'map' : 'terminal';
  }

  function reportCrash(message, stack) {
    if (!message || reportedMessages.has(message) || crashReportCount >= MAX_CRASH_REPORTS_PER_SESSION) return;
    if (!navigator.onLine) return;
    reportedMessages.add(message);
    crashReportCount += 1;
    const platform = (window.Capacitor && window.Capacitor.getPlatform) ? window.Capacitor.getPlatform() : 'web';
    fetch(`${TheBusSync.API_BASE}/api/crash-report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: String(message), stack: stack ? String(stack) : undefined, screen: currentScreenLabel(), platform }),
    }).catch(() => {}); // nothing to do if this fails -- it's diagnostic, not functional
  }

  window.addEventListener('error', (event) => {
    reportCrash(event.message, event.error && event.error.stack);
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const message = (reason && reason.message) ? reason.message : String(reason);
    reportCrash(message, reason && reason.stack);
  });

  function scrollToBottom() {
    historyEl.scrollTop = historyEl.scrollHeight;
  }

  function appendEntry(className, text) {
    const div = document.createElement('div');
    div.className = `entry ${className}`;
    div.textContent = text;
    historyEl.appendChild(div);
    scrollToBottom();
    return div;
  }

  function setStatus(msg) {
    bootStatus.textContent = msg;
  }

  /**
   * A small rendered map image for the location a location-bearing
   * answer was just about (see queryEngine.js's getLastLocation()) --
   * purely additive visual context on top of an already-complete text
   * answer, never required to understand it. Requires network (the
   * image itself is proxied server-side, see backend's /api/staticmap);
   * skipped entirely when offline, and silently removed if the request
   * fails for any other reason (feature not configured server-side,
   * upstream hiccup) -- a broken-image icon would look like the app is
   * malfunctioning, when really it's just an optional extra that isn't
   * available right now.
   */
  function appendMapImage(lat, lon, label) {
    const wrapper = document.createElement('div');
    wrapper.className = 'entry map-thumb';
    const img = document.createElement('img');
    img.alt = `MAP: ${(label || '').toUpperCase()}`;
    img.loading = 'lazy';
    img.addEventListener('error', () => wrapper.remove(), { once: true });
    img.src = `${TheBusSync.API_BASE}/api/staticmap?lat=${lat}&lon=${lon}`;
    wrapper.appendChild(img);
    historyEl.appendChild(wrapper);
    scrollToBottom();
  }

  /** Simulates old-terminal processing latency before printing the answer, per spec. `fn` may be async (e.g. a NEAREST STOP query that needs a network geocode lookup). */
  function withProcessingDelay(fn) {
    const processingEl = appendEntry('processing', 'PROCESSING...');
    const delay = 350 + Math.random() * 450; // 350-800ms, feels like a retro system "thinking"
    setTimeout(async () => {
      processingEl.remove();
      await fn();
    }, delay);
  }

  function handleSubmit(rawText) {
    const text = rawText.trim();
    if (!text) return;

    appendEntry('you', text);
    commandLog.push(text);
    historyPointer = commandLog.length;

    // Cross-country / cross-agency trip planning ("PLAN <origin> to
    // <destination>") is an explicit, online-only command handled by the
    // Transitous proxy (see tripPlanner.js). Checked before the offline
    // rule engine so it never collides with the engine's own local
    // "from X to Y" planner. Everything else falls through unchanged.
    const tripCmd = TheBusTripPlanner.parseCommand(text);
    if (tripCmd) {
      withProcessingDelay(async () => {
        let prefs;
        try { prefs = await TheBusStorage.getTripPrefs(); } catch (e) { prefs = undefined; }
        // Resolve local endpoints via the bundled OSM corpus before the
        // online geocoder (same as the map planner).
        const rf = global.TheBusLocalPlaces ? TheBusLocalPlaces.resolve(tripCmd.origin) : null;
        const rt = global.TheBusLocalPlaces ? TheBusLocalPlaces.resolve(tripCmd.dest) : null;
        const opts = {};
        if (rf) opts.fromCoords = { lat: rf.lat, lon: rf.lon };
        if (rt) opts.toCoords = { lat: rt.lat, lon: rt.lon };
        const output = await TheBusTripPlanner.plan(
          rf ? rf.name : tripCmd.origin,
          rt ? rt.name : tripCmd.dest,
          prefs,
          Object.keys(opts).length ? opts : undefined,
        );
        appendEntry('sys', output);
      });
      return;
    }

    // Fares & tickets: "FARE(S)", "TICKET(S)", "HOW MUCH", optionally naming
    // an agency ("fares hart"). Answered entirely offline from bundled data.
    const fareMatch = text.match(/^\s*(?:fares?|tickets?|how much(?: is| does)?(?: it)?(?: cost)?)\b\s*(.*)$/i);
    if (fareMatch && global.TheBusFares) {
      const output = TheBusFares.formatQuery(fareMatch[1]);
      appendEntry('sys', output || 'FARE INFO UNAVAILABLE.');
      return;
    }

    withProcessingDelay(async () => {
      let answer;
      try {
        answer = await TheBusQueryEngine.answerQuery(text, new Date());
      } catch (err) {
        console.error(err);
        answer = 'SYSTEM ERROR -- QUERY COULD NOT BE PROCESSED.';
      }

      // The rule engine's own answer is always fully correct and always
      // computed first, entirely offline -- this is a REPHRASING step
      // only, never a source of transit facts. When online and
      // configured server-side, this asks Grok to rewrite it in more
      // natural language; any failure/timeout/missing-config resolves to
      // null (see grokEnhance.js), and the original answer is shown
      // completely unchanged, exactly as before this feature existed.
      const enhanced = await TheBusGrokEnhance.enhance(text, answer);
      if (enhanced) {
        appendEntry('sys-ai', `[AI] ${enhanced}`.toUpperCase());
      } else {
        appendEntry('sys', answer.toUpperCase());
      }

      if (navigator.onLine) {
        const loc = TheBusQueryEngine.getLastLocation();
        if (loc) appendMapImage(loc.lat, loc.lon, loc.label);
      }
    });
  }

  function submitAndClear() {
    const value = commandInput.value;
    commandInput.value = '';
    handleSubmit(value);
  }

  // ---- Predictive search suggestions (suggest.js) ----
  // As the rider types, rank the stops/routes/places/roads/commands they're
  // most likely to mean and show a live "next bus" peek for the top stops,
  // so the answer is essentially forming before they finish typing. Arrow
  // keys move through it; Enter takes the highlighted one (or submits the
  // raw text if none is highlighted).
  const suggestBox = document.getElementById('suggestions');
  const suggestions = (function () {
    let items = [];
    let active = -1;
    let timer = null;

    function open() { suggestBox.hidden = false; commandInput.setAttribute('aria-expanded', 'true'); }
    function close() {
      suggestBox.hidden = true;
      suggestBox.textContent = '';
      items = []; active = -1;
      commandInput.setAttribute('aria-expanded', 'false');
      commandInput.setAttribute('aria-activedescendant', '');
    }
    function isOpen() { return !suggestBox.hidden; }

    // Cheap live peek for a stop suggestion: its very next arrival. Only for
    // the top few, so it never turns typing into heavy work.
    function peek(item) {
      if (item.type !== 'stop' || !item.ref) return '';
      try {
        const arr = TheBusQueryEngine.nextArrivals(item.ref.id, null, new Date(), 1);
        if (arr && arr.length) {
          const m = arr[0].minutesUntil;
          return m <= 0 ? ' · DUE NOW' : ` · NEXT ~${m} MIN`;
        }
      } catch (e) { /* no peek -- the label still stands */ }
      return '';
    }

    function render() {
      suggestBox.textContent = '';
      items.forEach((it, i) => {
        const li = document.createElement('li');
        li.className = 'sugg' + (i === active ? ' active' : '');
        li.id = `sugg-${i}`;
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', i === active ? 'true' : 'false');
        const lab = document.createElement('span');
        lab.className = 'sugg-label';
        lab.textContent = it.label;
        li.appendChild(lab);
        const hint = document.createElement('span');
        hint.className = 'sugg-hint';
        hint.textContent = (it.hint || '') + (i < 3 ? peek(it) : '');
        li.appendChild(hint);
        // mousedown (not click) so choosing fires before the input blurs.
        li.addEventListener('mousedown', (ev) => { ev.preventDefault(); choose(it); });
        suggestBox.appendChild(li);
      });
    }

    function update(value) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (!global.TheBusSuggest) { close(); return; }
        items = TheBusSuggest.suggest(value, 8) || [];
        active = -1;
        if (items.length) { render(); open(); } else { close(); }
      }, 80);
    }

    function move(delta) {
      if (!items.length) return;
      active = (active + delta + items.length) % items.length;
      commandInput.setAttribute('aria-activedescendant', `sugg-${active}`);
      render();
      const el = document.getElementById(`sugg-${active}`);
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    }

    function choose(it) {
      if (it.fill) { commandInput.value = it.fill; close(); commandInput.focus(); update(it.fill); return; }
      close();
      commandInput.value = '';
      handleSubmit(it.run || it.label);
    }

    function current() { return active >= 0 ? items[active] : null; }

    return { update, move, close, isOpen, current, choose };
  })();

  commandInput.addEventListener('input', (e) => {
    // Many Android soft keyboards (Gboard, SwiftKey) submit via a plain
    // `input` event carrying this inputType instead of ever firing a
    // real `keydown` Enter -- the keydown handler below alone misses
    // those entirely. A single-line <input> shouldn't actually accept a
    // literal newline, but strip one defensively if an IME snuck one in.
    if (e.inputType === 'insertLineBreak') {
      commandInput.value = commandInput.value.replace(/\n/g, '');
      suggestions.close();
      submitAndClear();
      return;
    }
    suggestions.update(commandInput.value);
  });

  commandInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const chosen = suggestions.isOpen() ? suggestions.current() : null;
      if (chosen) { suggestions.choose(chosen); } else { suggestions.close(); submitAndClear(); }
    } else if (e.key === 'Escape') {
      if (suggestions.isOpen()) { e.preventDefault(); suggestions.close(); }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (suggestions.isOpen()) {
        suggestions.move(-1);
      } else if (historyPointer > 0) {
        historyPointer -= 1;
        commandInput.value = commandLog[historyPointer];
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (suggestions.isOpen()) {
        suggestions.move(1);
      } else if (historyPointer < commandLog.length - 1) {
        historyPointer += 1;
        commandInput.value = commandLog[historyPointer];
      } else {
        historyPointer = commandLog.length;
        commandInput.value = '';
      }
    }
  });

  // Tapping away closes the dropdown (mousedown-preventDefault on items
  // keeps focus, so a suggestion tap still registers before this fires).
  commandInput.addEventListener('blur', () => setTimeout(() => suggestions.close(), 150));

  // Tapping anywhere on the terminal view refocuses the input. Scoped to
  // #terminal-view specifically (not the whole #screen) so tapping the
  // live map doesn't steal focus back to the command line and pop the
  // keyboard open over the map.
  document.getElementById('terminal-view').addEventListener('click', () => commandInput.focus());

  // ---- View tabs: terminal <-> live map ----
  const tabTerminal = document.getElementById('tab-terminal');
  const tabMap = document.getElementById('tab-map');
  const terminalView = document.getElementById('terminal-view');
  const mapView = document.getElementById('map-view');
  const mapStatus = document.getElementById('map-status');
  const busListPanel = document.getElementById('bus-list-panel');
  const countySelector = document.getElementById('county-selector');
  let mapInitialized = false;
  let lastDataset = null;
  let busListOpen = false;

  // ---- County map selector: one button per agency in the current
  // dataset, letting a rider narrow the Live Map to just one county
  // instead of the whole (visually unreadable at HART's density) merged
  // region at once. Hidden entirely for a single-agency dataset (no
  // `dataset.agencies`, or exactly one entry) -- nothing to choose
  // between, and this preserves the original single-county behavior
  // unchanged. ----
  let selectedAgencyId = null;
  let countySelectorBuiltForVersion = null;

  // Which agencies have a real-time source wired into /api/live-buses:
  // Hernando (Passio), Pasco (Avail/myStop), and HART (Swiftly's official
  // API -- active whenever the backend has a Swiftly key configured; when
  // it doesn't, HART simply reports "LIVE TRACKER UNAVAILABLE" with
  // routes/stops still shown, no worse than before). A single,
  // easy-to-extend list here rather than baking that assumption into
  // liveMap.js itself -- see README's "Live map" scope note.
  const LIVE_TRACKING_AGENCIES = new Set(['hernando', 'pasco', 'hart']);

  function agencyIdsOf(dataset) {
    return dataset && dataset.agencies ? Object.keys(dataset.agencies) : [];
  }

  // Sentinel for "show every county at once" -- deliberately the same
  // falsy value drawStaticData()/refreshLiveTrackingForSelection()
  // already treat as "no agency filter" (both check `agencyId &&
  // ...`), so this needs no special-casing in either of them: it's
  // just never filtering anything out, and live tracking still runs
  // normally (every agency's real buses are worth showing at once on the
  // combined view).
  const ALL_COUNTIES = null;
  const ALL_COUNTIES_LABEL = 'TRI-COUNTY';

  /** (Re)builds the county buttons if the dataset's agency list has changed since the last build; otherwise just refreshes which one shows as active. */
  function buildCountySelector(dataset) {
    const ids = agencyIdsOf(dataset);
    if (ids.length < 2) {
      countySelector.hidden = true;
      countySelectorBuiltForVersion = null;
      selectedAgencyId = null;
      return;
    }

    if (countySelectorBuiltForVersion !== dataset.version) {
      countySelector.textContent = '';
      const allBtn = document.createElement('button');
      allBtn.type = 'button';
      allBtn.className = 'county-btn';
      allBtn.dataset.agencyId = '';
      allBtn.textContent = ALL_COUNTIES_LABEL;
      allBtn.addEventListener('click', () => selectCounty(ALL_COUNTIES));
      countySelector.appendChild(allBtn);
      for (const id of ids) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'county-btn';
        btn.dataset.agencyId = id;
        btn.textContent = dataset.agencies[id].label.toUpperCase();
        btn.addEventListener('click', () => selectCounty(id));
        countySelector.appendChild(btn);
      }
      countySelectorBuiltForVersion = dataset.version;
      // Opening the map for a newly-loaded (or just-updated) dataset
      // starts on the full regional view -- the individual county
      // buttons are for narrowing in, not the default.
      selectedAgencyId = ALL_COUNTIES;
    }

    countySelector.hidden = false;
    updateCountyButtonStates();
  }

  function updateCountyButtonStates() {
    for (const btn of countySelector.children) {
      btn.classList.toggle('active', btn.dataset.agencyId === (selectedAgencyId || ''));
    }
  }

  function selectCounty(agencyId) {
    selectedAgencyId = agencyId;
    updateCountyButtonStates();
    TheBusLiveMap.drawStaticData(lastDataset, agencyId);
    refreshLiveTrackingForSelection();
  }

  /** Renders the "N BUSES ACTIVE" dropdown: one line per active bus, the stop it's nearest to right now, and that route's next scheduled arrival there. Uses real DOM nodes (not innerHTML) so stop/route names never need HTML-escaping. */
  function renderBusList() {
    busListPanel.textContent = '';
    const summaries = TheBusLiveMap.activeBusSummaries(new Date());
    if (summaries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'bus-list-empty';
      empty.textContent = 'NO BUSES CURRENTLY ACTIVE.';
      busListPanel.appendChild(empty);
      return;
    }
    for (const s of summaries) {
      const row = document.createElement('div');
      row.className = 'bus-list-row';
      const strong = document.createElement('strong');
      strong.textContent = s.label.toUpperCase();
      row.appendChild(strong);
      row.appendChild(document.createTextNode(` -- ${s.text}`));
      busListPanel.appendChild(row);
    }
  }

  function closeBusList() {
    busListOpen = false;
    busListPanel.hidden = true;
    mapStatus.setAttribute('aria-expanded', 'false');
  }

  mapStatus.addEventListener('click', () => {
    busListOpen = !busListOpen;
    busListPanel.hidden = !busListOpen;
    mapStatus.setAttribute('aria-expanded', String(busListOpen));
    if (busListOpen) renderBusList();
  });

  function showTerminal() {
    tabTerminal.classList.add('active');
    tabTerminal.setAttribute('aria-selected', 'true');
    tabMap.classList.remove('active');
    tabMap.setAttribute('aria-selected', 'false');
    terminalView.hidden = false;
    mapView.hidden = true;
    TheBusLiveMap.stopPolling();
    closeBusList(); // don't reopen showing stale positions from before polling stopped
    commandInput.focus();
  }

  /**
   * Starts (or stops) live bus polling based on which county is
   * currently selected -- real-time positions only exist for the
   * agencies in LIVE_TRACKING_AGENCIES (Hernando + Pasco today; HART has
   * no source wired in yet, see README), so switching to HART says so
   * plainly instead of leaving "CONNECTING TO LIVE TRACKER..." up
   * forever for a county that will never actually connect. Selecting
   * TRI-COUNTY (selectedAgencyId === null) polls every source at once,
   * unfiltered -- see startPolling()'s own agencyFilter param. Pulled
   * out of showMap() so selectCounty() can re-run it on every switch,
   * not just once when the map tab first opens.
   */
  function refreshLiveTrackingForSelection() {
    TheBusLiveMap.stopPolling();
    closeBusList(); // don't leave a stale bus list open across a county switch

    if (selectedAgencyId && !LIVE_TRACKING_AGENCIES.has(selectedAgencyId)) {
      const label = lastDataset.agencies[selectedAgencyId].label.toUpperCase();
      mapStatus.textContent = `REAL-TIME TRACKING NOT YET AVAILABLE FOR ${label} -- ROUTES/STOPS STILL SHOWN`;
      return;
    }

    // Routes/stops (colored lines + dots) always draw from the offline
    // dataset regardless of connectivity -- only the street-map
    // background underneath them and live bus positions actually need a
    // network. Said outright rather than left for the rider to notice a
    // plain dark map on their own: the whole point of "works offline" is
    // that the app is honest about the one part of this view that
    // genuinely can't be.
    if (!navigator.onLine) {
      mapStatus.textContent = 'OFFLINE -- SHOWING ROUTES/STOPS ONLY (NO STREET MAP, NO LIVE BUSES)';
      return;
    }

    mapStatus.textContent = 'CONNECTING TO LIVE TRACKER...';
    TheBusLiveMap.startPolling(10000, (result) => {
      // navigator.onLine only means the device has SOME network path,
      // not that tile.openstreetmap.org specifically is reachable (a
      // captive wifi portal or a firewall blocking just tile servers
      // would leave this true while the basemap still never loads) --
      // isBasemapHealthy() catches that case too, so the message stays
      // honest either way.
      const basemapNote = TheBusLiveMap.isBasemapHealthy() ? '' : ' (NO STREET MAP)';
      if (!result.ok) {
        mapStatus.textContent = `LIVE TRACKER UNAVAILABLE -- ROUTES/STOPS STILL SHOWN${basemapNote}`;
      } else if (result.count === 0) {
        mapStatus.textContent = `NO BUSES CURRENTLY RUNNING${basemapNote}`;
      } else {
        mapStatus.textContent = `${result.count} BUS${result.count === 1 ? '' : 'ES'} ACTIVE${basemapNote}`;
      }
      if (busListOpen) renderBusList(); // keep it live while open, same cadence as the map markers
    }, selectedAgencyId);
  }

  function showMap() {
    tabMap.classList.add('active');
    tabMap.setAttribute('aria-selected', 'true');
    tabTerminal.classList.remove('active');
    tabTerminal.setAttribute('aria-selected', 'false');
    terminalView.hidden = true;
    mapView.hidden = false;

    if (!mapInitialized) {
      TheBusLiveMap.initMap('map');
      mapInitialized = true;
    }
    // Leaflet can't detect its container becoming visible on its own --
    // it was 0x0 (display:none) until just now.
    TheBusLiveMap.invalidateSize();
    if (lastDataset) {
      buildCountySelector(lastDataset);
      TheBusLiveMap.drawStaticData(lastDataset, selectedAgencyId);
    }
    refreshLiveTrackingForSelection();
  }

  tabTerminal.addEventListener('click', showTerminal);
  tabMap.addEventListener('click', showMap);

  // ---- Service alerts banner (GTFS-RT via /api/service-alerts) ----
  // Independent of dataset/map init: fetches active alerts when online and
  // shows them across the top of both tabs; stays hidden otherwise.
  TheBusServiceAlerts.init(document.getElementById('alerts-banner'));
  if (global.TheBusRouteAlerts) TheBusRouteAlerts.init(); // set up the notification channel (native only; no-op on web)

  // ---- Live Map trip planner panel (Transitous via /api/plan) ----
  (function setupTripPlannerPanel() {
    const toggle = document.getElementById('plan-trip-toggle');
    const panel = document.getElementById('trip-planner-panel');
    const closeBtn = document.getElementById('tp-close');
    const fromInput = document.getElementById('tp-from');
    const toInput = document.getElementById('tp-to');
    const hereBtn = document.getElementById('tp-here');
    const swapBtn = document.getElementById('tp-swap');
    const goBtn = document.getElementById('tp-go');
    const results = document.getElementById('tp-results');
    const prefTransfers = document.getElementById('tp-pref-transfers');
    const prefWalking = document.getElementById('tp-pref-walking');
    const prefWheelchair = document.getElementById('tp-pref-wheelchair');
    const savedWrap = document.getElementById('tp-saved-wrap');
    const savedList = document.getElementById('tp-saved');
    if (!toggle || !panel) return;

    const MY_LOCATION = 'MY LOCATION';
    let myLocationCoords = null; // {lat,lon} when FROM is "use my location"

    // Restore saved preferences into the checkboxes; persist on change.
    TheBusStorage.getTripPrefs().then((p) => {
      prefTransfers.checked = p.fewerTransfers;
      prefWalking.checked = p.lessWalking;
      prefWheelchair.checked = p.wheelchair;
    }).catch(() => {});
    function currentPrefs() {
      return { fewerTransfers: prefTransfers.checked, lessWalking: prefWalking.checked, wheelchair: prefWheelchair.checked };
    }
    [prefTransfers, prefWalking, prefWheelchair].forEach((cb) =>
      cb.addEventListener('change', () => { TheBusStorage.setTripPrefs(currentPrefs()).catch(() => {}); }));

    // Editing FROM by hand clears any "use my location" coords tied to it.
    fromInput.addEventListener('input', () => {
      if (fromInput.value !== MY_LOCATION) myLocationCoords = null;
    });

    function setMsg(text) {
      results.textContent = '';
      const d = document.createElement('div');
      d.className = 'tp-msg';
      d.textContent = text;
      results.appendChild(d);
    }

    function openPanel() {
      panel.hidden = false;
      toggle.setAttribute('aria-expanded', 'true');
      renderSaved();
      fromInput.focus();
    }
    function closePanel() {
      panel.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
    }
    toggle.addEventListener('click', () => (panel.hidden ? openPanel() : closePanel()));
    closeBtn.addEventListener('click', closePanel);

    // "Use my location" -> fill FROM with a sentinel + remember coords.
    hereBtn.addEventListener('click', async () => {
      hereBtn.disabled = true;
      const prev = fromInput.value;
      fromInput.value = 'LOCATING...';
      try {
        const pos = await TheBusGeolocate.getCurrentPosition();
        if (pos && pos.lat != null) {
          myLocationCoords = { lat: pos.lat, lon: pos.lon };
          fromInput.value = MY_LOCATION;
        } else {
          fromInput.value = prev;
          setMsg("COULDN'T GET YOUR LOCATION. TYPE A START INSTEAD.");
        }
      } catch (e) {
        fromInput.value = prev;
        setMsg("COULDN'T GET YOUR LOCATION. TYPE A START INSTEAD.");
      } finally {
        hereBtn.disabled = false;
      }
    });

    swapBtn.addEventListener('click', () => {
      const f = fromInput.value;
      fromInput.value = toInput.value;
      toInput.value = f;
      myLocationCoords = null; // coords no longer map cleanly after a swap
    });

    // ---- Fares footer: which agencies this trip uses, and how to pay ----
    function renderFaresFooter(result) {
      if (!global.TheBusFares) return;
      const names = new Set();
      (result.itineraries || []).forEach((it) => (it.legs || []).forEach((leg) => {
        if (leg.agency) names.add(leg.agency);
      }));
      const infos = [];
      names.forEach((n) => { const info = TheBusFares.matchByName(n); if (info && !infos.includes(info)) infos.push(info); });
      if (infos.length === 0) return;

      const wrap = document.createElement('div');
      wrap.className = 'tp-fares';
      const h = document.createElement('div');
      h.className = 'tp-subhead';
      h.textContent = 'FARES & TICKETS';
      wrap.appendChild(h);
      infos.forEach((info) => {
        const line = document.createElement('div');
        line.className = 'tp-fare-line';
        const price = info.singleRide ? info.singleRide : 'SEE OFFICIAL PAGE';
        line.textContent = `${info.label}: ${price}`;
        wrap.appendChild(line);
        const link = document.createElement('a');
        link.className = 'tp-fare-link';
        link.href = info.officialUrl;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = `HOW TO PAY / BUY (${info.app ? info.app.name : 'OFFICIAL'})`;
        wrap.appendChild(link);
      });
      results.appendChild(wrap);
    }

    function renderResult(result, saveTrip) {
      results.textContent = '';
      const fmt = TheBusTripPlanner.format;
      const head = document.createElement('div');
      head.className = 'tp-route-head';
      const fromName = (result.from && result.from.name ? result.from.name : 'START').toUpperCase();
      const toName = (result.to && result.to.name ? result.to.name : 'DESTINATION').toUpperCase();
      head.textContent = `${fromName} -> ${toName}`;
      results.appendChild(head);

      // Draw the first option's route lines + A/B pins on the map.
      if (TheBusLiveMap.drawTripPlan) {
        TheBusLiveMap.drawTripPlan(result);
      } else if (result.from && result.to && TheBusLiveMap.showTripEndpoints) {
        TheBusLiveMap.showTripEndpoints(result.from, result.to);
      }

      const itins = result.itineraries || [];
      if (itins.length === 0) {
        const d = document.createElement('div');
        d.className = 'tp-msg';
        d.textContent = 'NO TRANSIT ROUTE FOUND BETWEEN THOSE TWO PLACES.';
        results.appendChild(d);
        return;
      }

      itins.forEach((it, i) => {
        const opt = document.createElement('div');
        opt.className = 'tp-option';
        const meta = document.createElement('div');
        meta.className = 'tp-option-meta';
        const transfers = it.transfers === 0 ? 'DIRECT'
          : (it.transfers != null ? `${it.transfers} TRANSFER${it.transfers === 1 ? '' : 'S'}` : '');
        const parts = [fmt.duration(it.durationMinutes), transfers].filter(Boolean).join(', ');
        meta.textContent = `OPTION ${i + 1}: ${fmt.time(it.departure)} -> ${fmt.time(it.arrival)}${parts ? '  (' + parts + ')' : ''}`;
        opt.appendChild(meta);

        (it.legs || []).forEach((leg) => {
          const isWalk = (leg.mode || '').toUpperCase() === 'WALK';
          const row = document.createElement('div');
          row.className = 'tp-leg';
          if (isWalk) {
            const dist = leg.distanceMeters != null ? ` ${(leg.distanceMeters / 1609.34).toFixed(2)} MI` : '';
            row.textContent = `WALK${dist}${leg.to ? ' TO ' + leg.to.toUpperCase() : ''}`;
            opt.appendChild(row);
          } else {
            row.textContent = `${fmt.modeLabel(leg)}${leg.headsign ? ' -> ' + leg.headsign.toUpperCase() : ''}`;
            opt.appendChild(row);
            const times = document.createElement('div');
            times.className = 'tp-leg-time';
            times.textContent = `${(leg.from || '').toUpperCase()} ${fmt.time(leg.departure)} -> ${(leg.to || '').toUpperCase()} ${fmt.time(leg.arrival)}`;
            opt.appendChild(times);
          }
        });
        results.appendChild(opt);
      });

      renderFaresFooter(result);

      // Offer to save the trip -- only when both ends are plain text (a
      // "my location" trip can't be re-planned from saved text).
      if (saveTrip && saveTrip.from && saveTrip.to) {
        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'tp-save';
        saveBtn.textContent = '[ SAVE THIS TRIP ]';
        saveBtn.addEventListener('click', async () => {
          await TheBusStorage.addSavedTrip(saveTrip);
          saveBtn.textContent = '[ SAVED ]';
          saveBtn.disabled = true;
          renderSaved();
        });
        results.appendChild(saveBtn);
      }
    }

    function localResolve(text) {
      if (!global.TheBusLocalPlaces) return null;
      try { return TheBusLocalPlaces.resolve(text); } catch (e) { return null; }
    }

    async function runPlan() {
      const fromText = fromInput.value.trim();
      const toText = toInput.value.trim();
      const usingMyLocation = fromText === MY_LOCATION && myLocationCoords;
      if ((!fromText && !usingMyLocation) || !toText) { setMsg('ENTER BOTH A START AND A DESTINATION.'); return; }
      goBtn.disabled = true;
      goBtn.textContent = '[ PLANNING... ]';
      setMsg('PLANNING...');

      // Resolve local endpoints against the bundled OSM corpus first (a
      // landmark the online geocoder may not know); fall back to sending
      // the text for Transitous to geocode (cities/addresses).
      const opts = {};
      let fromLabel = fromText;
      let toLabel = toText;
      if (usingMyLocation) {
        opts.fromCoords = myLocationCoords;
        fromLabel = MY_LOCATION;
      } else {
        const rf = localResolve(fromText);
        if (rf) { opts.fromCoords = { lat: rf.lat, lon: rf.lon }; fromLabel = rf.name || fromText; }
      }
      const rt = localResolve(toText);
      if (rt) { opts.toCoords = { lat: rt.lat, lon: rt.lon }; toLabel = rt.name || toText; }

      const outcome = await TheBusTripPlanner.planStructured(fromLabel, toLabel, currentPrefs(), Object.keys(opts).length ? opts : undefined);
      goBtn.disabled = false;
      goBtn.textContent = '[ PLAN ]';
      if (outcome.error) { setMsg(outcome.error); return; }
      // Save the rider's original typed text (so a re-plan re-resolves).
      const saveTrip = (!usingMyLocation && fromText && toText) ? { from: fromText, to: toText } : null;
      renderResult(outcome.result, saveTrip);
    }

    goBtn.addEventListener('click', runPlan);
    [fromInput, toInput].forEach((el) => el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); runPlan(); }
    }));

    // ---- Saved trips ----
    async function renderSaved() {
      let trips = [];
      try { trips = await TheBusStorage.getSavedTrips(); } catch (e) { trips = []; }
      savedList.textContent = '';
      if (!trips.length) { savedWrap.hidden = true; return; }
      savedWrap.hidden = false;
      trips.forEach((t) => {
        const row = document.createElement('div');
        row.className = 'tp-saved-row';
        const go = document.createElement('button');
        go.type = 'button';
        go.className = 'tp-saved-go';
        go.textContent = `${t.from.toUpperCase()} -> ${t.to.toUpperCase()}`;
        go.addEventListener('click', () => {
          fromInput.value = t.from;
          toInput.value = t.to;
          myLocationCoords = null;
          runPlan();
        });
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'tp-mini';
        del.setAttribute('aria-label', 'Remove saved trip');
        del.textContent = 'X';
        del.addEventListener('click', async () => { await TheBusStorage.removeSavedTrip(t.from, t.to); renderSaved(); });
        row.appendChild(go);
        row.appendChild(del);
        savedList.appendChild(row);
      });
    }
  })();

  // iOS Safari shrinks the *visual* viewport (not the layout viewport)
  // when the on-screen keyboard opens, which `height: 100%` doesn't
  // track on its own -- the input line can end up hidden behind the
  // keyboard. Pin #crt's actual height to the visual viewport instead.
  if (window.visualViewport) {
    const crtEl = document.getElementById('crt');
    const syncViewportHeight = () => {
      crtEl.style.height = `${window.visualViewport.height}px`;
    };
    window.visualViewport.addEventListener('resize', syncViewportHeight);
    syncViewportHeight();
  }

  // ---- First-launch onboarding: location consent, then a brief how-to ----
  const onboardLocation = document.getElementById('onboard-location');
  const onboardHelp = document.getElementById('onboard-help');

  async function maybeShowOnboarding() {
    // Fails OPEN, not closed: an error reading the stored "seen" flag
    // must never mean the onboarding modals silently never appear again.
    // (Root-caused an on-device report of exactly that -- this call was
    // previously neither awaited nor wrapped by boot(), so a storage
    // rejection here vanished as an unhandled promise rejection with no
    // console output and no popup, while the rest of the app kept working
    // fine because sync.js's storage calls are all try/caught already.)
    let seen = false;
    try {
      seen = await TheBusStorage.getOnboardingSeen();
    } catch (err) {
      console.error('onboarding: failed to read seen state, showing it anyway', err);
    }
    if (seen) return;

    function showHelp() {
      onboardLocation.hidden = true;
      onboardHelp.hidden = false;
    }

    document.getElementById('onboard-location-yes').addEventListener('click', async () => {
      await TheBusGeolocate.getCurrentPosition(); // triggers the OS permission prompt; result unused here
      showHelp();
    });
    document.getElementById('onboard-location-no').addEventListener('click', showHelp);
    document.getElementById('onboard-help-close').addEventListener('click', () => {
      onboardHelp.hidden = true;
      TheBusStorage.setOnboardingSeen();
      commandInput.focus();
    });

    onboardLocation.hidden = false;
  }

  // Past this many days since the last successful server contact (or if
  // there's never been one at all), the freshness line switches from a
  // subtle note to an explicit warning color. 30 days is deliberately
  // generous -- the backend checks the county's feed daily and small-
  // agency schedules can validly go unchanged for months, so this isn't
  // about "the schedule is probably wrong," it's about "this app hasn't
  // been able to confirm anything for a genuinely long time, independent
  // of whether the data happens to still be accurate."
  const FRESHNESS_WARN_DAYS = 30;
  const dataFreshnessEl = document.getElementById('data-freshness');

  function formatFreshness(lastSyncedAt) {
    if (!lastSyncedAt) {
      return { text: 'SCHEDULE DATA: NOT YET CONFIRMED WITH SERVER', stale: true };
    }
    const ageDays = Math.floor((Date.now() - lastSyncedAt) / 86400000);
    const when = ageDays <= 0 ? 'TODAY' : ageDays === 1 ? '1 DAY AGO' : `${ageDays} DAYS AGO`;
    return { text: `SCHEDULE DATA LAST CONFIRMED: ${when}`, stale: ageDays >= FRESHNESS_WARN_DAYS };
  }

  async function renderFreshness() {
    const lastSyncedAt = await TheBusStorage.getLastSyncedAt();
    const { text, stale } = formatFreshness(lastSyncedAt);
    dataFreshnessEl.textContent = text;
    dataFreshnessEl.hidden = false;
    dataFreshnessEl.classList.toggle('freshness-stale', stale);
  }

  /** Wires a freshly-activated dataset into every part of the app that reads it. */
  function activateDataset(rawData) {
    // Single funnel point for every dataset source (on-device cache,
    // bundled first-launch snapshot, or a fresh download) -- expanding
    // the backend's compact wire format (see sync.js's expandDataset)
    // exactly once, here, means queryEngine.js/liveMap.js never need to
    // know the on-disk/on-the-wire shape differs from what they expect.
    const data = TheBusSync.expandDataset(rawData);
    TheBusQueryEngine.setDataset(data);
    if (global.TheBusLocalPlaces) TheBusLocalPlaces.setDataset(data); // offline place lookup for the trip planner
    if (global.TheBusSuggest) TheBusSuggest.setDataset(data); // predictive search index
    lastDataset = data;
    // Covers the case where the rider switched to the map tab before this
    // ran -- the map would've drawn with no routes/stops yet otherwise.
    if (mapInitialized && !mapView.hidden) {
      buildCountySelector(lastDataset);
      TheBusLiveMap.drawStaticData(lastDataset, selectedAgencyId);
    }
  }

  async function boot() {
    // Not awaited -- shouldn't block the terminal loading underneath it --
    // but still must never fail silently (see maybeShowOnboarding's own
    // internal try/catch for why this matters).
    maybeShowOnboarding().catch((err) => console.error('onboarding: unexpected failure', err));
    setStatus('LOADING...');

    // STEP 1 -- instant, no network: whatever's on disk from a prior
    // sync, or (first-ever launch) the real schedule data bundled inside
    // the app itself. This is what makes a fresh install answer real
    // questions immediately instead of waiting on a possibly-sleeping
    // backend, or showing nothing at all with no connection.
    const { data: initialData, source } = await TheBusSync.getInitialData();

    if (initialData) {
      activateDataset(initialData);
      TheBusSearchIndex.ensureLoaded();
      bootStatus.classList.add('ready');
      setStatus(source === 'bundled' ? 'READY (BUILT-IN SCHEDULE DATA)' : 'READY (OFFLINE CACHE)');
      renderFreshness();
      appendEntry('sys', 'TYPE A QUESTION BELOW, E.G. "WHEN IS THE NEXT BUS AT AVALON PUBLIX?"');
      appendEntry('sys', 'GOING FARTHER? TRY "PLAN TAMPA TO ORLANDO" (NEEDS A CONNECTION).');
      appendEntry('sys', 'FARES & TICKETS: TYPE "FARES" (OR "FARES HART").');
      // Don't pop the keyboard open behind an onboarding modal that's
      // still up -- this can finish before the rider has answered it.
      if (onboardLocation.hidden && onboardHelp.hidden) commandInput.focus();
    } else {
      // Only reachable if even the bundled snapshot is missing/corrupt --
      // shouldn't happen for a correctly-built release, but still needs
      // a real message rather than a silent blank screen.
      setStatus('NO DATA AVAILABLE -- CONNECT TO NETWORK AND RESTART');
      appendEntry('err', 'UNABLE TO LOAD TRANSIT DATA. THIS APP REQUIRES AT LEAST ONE ONLINE SYNC BEFORE IT CAN WORK OFFLINE.');
    }

    // STEP 2 -- background: quietly check for anything newer than what's
    // already on screen. Never blocks, never touches the status line
    // unless it actually finds something to swap in, so it can't make an
    // already-working app look broken or stuck mid-use.
    const { data: freshData, updated } = await TheBusSync.checkForUpdate();
    if (updated && freshData) {
      TheBusSearchIndex.ensureLoaded();
      activateDataset(freshData);
      bootStatus.classList.add('ready');
      setStatus('DATASET SYNCED -- READY');
      if (!initialData) {
        appendEntry('sys', 'TYPE A QUESTION BELOW, E.G. "WHEN IS THE NEXT BUS AT AVALON PUBLIX?"');
      }
    }
    // Re-render regardless of whether anything NEW came down -- a check
    // that confirms "you're already current" still moves the "last
    // confirmed" timestamp forward, so the freshness line should reflect
    // that too, not just an actual data change.
    renderFreshness();
  }

  boot();

  // ---- Android hardware back button ----
  // A well-documented, recurring Capacitor gotcha (capacitorjs.com/docs/
  // android/troubleshooting; ionic-team/capacitor #4317/#4300): with no
  // handler at all, Android's default is to exit the app on ANY
  // back-press, regardless of what's on screen -- an open onboarding
  // modal, an open bus list, or the Live Map tab would all just quit the
  // app instead of doing the obviously-expected thing (close the modal,
  // go back to the terminal). Requires @capacitor/app (see package.json)
  // -- NOT YET INSTALLED/BUILT OR VERIFIED ON A REAL DEVICE as of this
  // commit (this sandbox has no Android runtime to test against); run
  // `npm install` and confirm on-device before relying on this. Falls
  // back to a no-op outside the Capacitor shell (plain browser dev
  // server), same pattern storage.js already uses for its own optional
  // native APIs.
  if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
    window.Capacitor.Plugins.App.addListener('backButton', () => {
      if (!onboardLocation.hidden) { onboardLocation.hidden = true; return; }
      if (!onboardHelp.hidden) { onboardHelp.hidden = true; return; }
      if (busListOpen) { closeBusList(); return; }
      if (!mapView.hidden) { showTerminal(); return; }
      window.Capacitor.Plugins.App.exitApp();
    });
  }
})();
