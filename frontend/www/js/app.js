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

  /** Simulates old-terminal processing latency before printing the answer, per spec. */
  function withProcessingDelay(fn) {
    const processingEl = appendEntry('processing', 'PROCESSING...');
    const delay = 350 + Math.random() * 450; // 350-800ms, feels like a retro system "thinking"
    setTimeout(() => {
      processingEl.remove();
      fn();
    }, delay);
  }

  function handleSubmit(rawText) {
    const text = rawText.trim();
    if (!text) return;

    appendEntry('you', text);
    commandLog.push(text);
    historyPointer = commandLog.length;

    withProcessingDelay(() => {
      let answer;
      try {
        answer = TheBusQueryEngine.answerQuery(text, new Date());
      } catch (err) {
        console.error(err);
        answer = 'SYSTEM ERROR -- QUERY COULD NOT BE PROCESSED.';
      }
      appendEntry('sys', answer.toUpperCase());
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
  let mapInitialized = false;
  let lastDataset = null;

  function showTerminal() {
    tabTerminal.classList.add('active');
    tabTerminal.setAttribute('aria-selected', 'true');
    tabMap.classList.remove('active');
    tabMap.setAttribute('aria-selected', 'false');
    terminalView.hidden = false;
    mapView.hidden = true;
    TheBusLiveMap.stopPolling();
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

    if (!navigator.onLine) {
      mapStatus.textContent = 'OFFLINE -- LIVE BUS POSITIONS UNAVAILABLE';
    } else {
      mapStatus.textContent = 'CONNECTING TO LIVE TRACKER...';
      TheBusLiveMap.startPolling(10000, (result) => {
        if (!result.ok) {
          mapStatus.textContent = 'LIVE TRACKER UNAVAILABLE -- ROUTES/STOPS STILL SHOWN';
        } else if (result.count === 0) {
          mapStatus.textContent = 'NO BUSES CURRENTLY RUNNING';
        } else {
          mapStatus.textContent = `${result.count} BUS${result.count === 1 ? '' : 'ES'} ACTIVE`;
        }
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

  async function boot() {
    setStatus('INITIALIZING OFFLINE DATASET...');

    const { data, status } = await TheBusSync.syncData(setStatus);

    if (!data) {
      setStatus('NO DATA AVAILABLE -- CONNECT TO NETWORK AND RESTART');
      appendEntry('err', 'UNABLE TO LOAD TRANSIT DATA. THIS APP REQUIRES AT LEAST ONE ONLINE SYNC BEFORE IT CAN WORK OFFLINE.');
      return;
    }

    TheBusQueryEngine.setDataset(data);
    lastDataset = data;
    // Covers the case where the user switched to the map tab before the
    // initial sync finished -- the map would've drawn with no routes/
    // stops yet since lastDataset was still null at that point.
    if (mapInitialized && !mapView.hidden) TheBusLiveMap.drawStaticData(lastDataset);
    bootStatus.classList.add('ready');
    setStatus(status === 'synced' ? 'DATASET SYNCED -- READY' : 'READY (OFFLINE CACHE)');

    appendEntry('sys', 'TYPE A QUESTION BELOW, E.G. "WHEN IS THE NEXT BUS AT AVALON PUBLIX?"');
    commandInput.focus();
  }

  boot();
})();
