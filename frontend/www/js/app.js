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

    withProcessingDelay(async () => {
      let answer;
      try {
        answer = await TheBusQueryEngine.answerQuery(text, new Date());
      } catch (err) {
        console.error(err);
        answer = 'SYSTEM ERROR -- QUERY COULD NOT BE PROCESSED.';
      }
      appendEntry('sys', answer.toUpperCase());
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

  commandInput.addEventListener('input', (e) => {
    // Many Android soft keyboards (Gboard, SwiftKey) submit via a plain
    // `input` event carrying this inputType instead of ever firing a
    // real `keydown` Enter -- the keydown handler below alone misses
    // those entirely. A single-line <input> shouldn't actually accept a
    // literal newline, but strip one defensively if an IME snuck one in.
    if (e.inputType === 'insertLineBreak') {
      commandInput.value = commandInput.value.replace(/\n/g, '');
      submitAndClear();
    }
  });

  commandInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitAndClear();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (historyPointer > 0) {
        historyPointer -= 1;
        commandInput.value = commandLog[historyPointer];
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyPointer < commandLog.length - 1) {
        historyPointer += 1;
        commandInput.value = commandLog[historyPointer];
      } else {
        historyPointer = commandLog.length;
        commandInput.value = '';
      }
    }
  });

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
  let mapInitialized = false;
  let lastDataset = null;
  let busListOpen = false;

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
    if (lastDataset) TheBusLiveMap.drawStaticData(lastDataset);

    // Routes/stops (colored lines + dots) always draw from the offline
    // dataset regardless of connectivity -- only the street-map
    // background underneath them and live bus positions actually need a
    // network. Said outright rather than left for the rider to notice a
    // plain dark map on their own: the whole point of "works offline" is
    // that the app is honest about the one part of this view that
    // genuinely can't be.
    if (!navigator.onLine) {
      mapStatus.textContent = 'OFFLINE -- SHOWING ROUTES/STOPS ONLY (NO STREET MAP, NO LIVE BUSES)';
    } else {
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
      });
    }
  }

  tabTerminal.addEventListener('click', showTerminal);
  tabMap.addEventListener('click', showMap);

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
  function activateDataset(data) {
    TheBusQueryEngine.setDataset(data);
    lastDataset = data;
    // Covers the case where the rider switched to the map tab before this
    // ran -- the map would've drawn with no routes/stops yet otherwise.
    if (mapInitialized && !mapView.hidden) TheBusLiveMap.drawStaticData(lastDataset);
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
})();
