/**
 * Terminal UI glue: renders the fake command line + scrolling history,
 * captures keystrokes via an off-screen real <input> (so mobile soft
 * keyboards work), and drives the sync -> parse -> query pipeline.
 */
(function () {
  const historyEl = document.getElementById('history');
  const inputTextEl = document.getElementById('input-text');
  const hiddenInput = document.getElementById('hidden-input');
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

  function renderInputText() {
    inputTextEl.textContent = hiddenInput.value;
  }

  hiddenInput.addEventListener('input', renderInputText);

  hiddenInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSubmit(hiddenInput.value);
      hiddenInput.value = '';
      renderInputText();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (historyPointer > 0) {
        historyPointer -= 1;
        hiddenInput.value = commandLog[historyPointer];
        renderInputText();
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyPointer < commandLog.length - 1) {
        historyPointer += 1;
        hiddenInput.value = commandLog[historyPointer];
      } else {
        historyPointer = commandLog.length;
        hiddenInput.value = '';
      }
      renderInputText();
    }
  });

  // Tapping anywhere on the screen refocuses the hidden input, since it's
  // the only thing actually capable of receiving keystrokes / opening the
  // mobile keyboard.
  document.getElementById('screen').addEventListener('click', () => hiddenInput.focus());

  async function boot() {
    setStatus('INITIALIZING OFFLINE DATASET...');

    const { data, status } = await TheBusSync.syncData(setStatus);

    if (!data) {
      setStatus('NO DATA AVAILABLE -- CONNECT TO NETWORK AND RESTART');
      appendEntry('err', 'UNABLE TO LOAD TRANSIT DATA. THIS APP REQUIRES AT LEAST ONE ONLINE SYNC BEFORE IT CAN WORK OFFLINE.');
      return;
    }

    TheBusQueryEngine.setDataset(data);
    bootStatus.classList.add('ready');
    setStatus(status === 'synced' ? 'DATASET SYNCED -- READY' : 'READY (OFFLINE CACHE)');

    appendEntry('sys', 'TYPE A QUESTION BELOW, E.G. "WHEN IS THE NEXT BUS AT AVALON PUBLIX?"');
    hiddenInput.focus();
  }

  boot();
})();
