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

  /**
   * Some Android keyboards (confirmed on-device: Gboard, likely others)
   * lose track of the real caret position on this hidden input and
   * reset it to 0 between keystrokes -- each new character then gets
   * INSERTED AT THE START instead of appended, so typing "when" one
   * letter at a time produces "w" -> "hw" -> "ehw" -> "nehw". Forcing
   * the selection back to the end after every change is a direct,
   * reliable fix regardless of why the keyboard loses the caret.
   */
  function pinCursorToEnd() {
    const len = hiddenInput.value.length;
    hiddenInput.setSelectionRange(len, len);
  }

  function submitAndClear() {
    const value = hiddenInput.value;
    hiddenInput.value = '';
    renderInputText();
    handleSubmit(value);
  }

  hiddenInput.addEventListener('input', (e) => {
    // Many Android soft keyboards (Gboard, SwiftKey) submit via a plain
    // `input` event carrying this inputType instead of ever firing a
    // real `keydown` Enter -- the keydown handler below alone misses
    // those entirely. The IME may have already inserted a literal
    // newline into the value before this fires; strip it either way.
    if (e.inputType === 'insertLineBreak') {
      hiddenInput.value = hiddenInput.value.replace(/\n/g, '');
      submitAndClear();
      return;
    }
    renderInputText();
    pinCursorToEnd();
  });

  hiddenInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitAndClear();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (historyPointer > 0) {
        historyPointer -= 1;
        hiddenInput.value = commandLog[historyPointer];
        renderInputText();
        pinCursorToEnd();
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
      pinCursorToEnd();
    }
  });

  // Tapping anywhere on the screen refocuses the hidden input, since it's
  // the only thing actually capable of receiving keystrokes / opening the
  // mobile keyboard.
  document.getElementById('screen').addEventListener('click', () => hiddenInput.focus());

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
    bootStatus.classList.add('ready');
    setStatus(status === 'synced' ? 'DATASET SYNCED -- READY' : 'READY (OFFLINE CACHE)');

    appendEntry('sys', 'TYPE A QUESTION BELOW, E.G. "WHEN IS THE NEXT BUS AT AVALON PUBLIX?"');
    hiddenInput.focus();
  }

  boot();
})();
