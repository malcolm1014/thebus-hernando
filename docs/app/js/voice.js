/**
 * Voice input for the terminal: a mic button dictates a question instead of
 * typing it, via the Web Speech API (SpeechRecognition). An accessibility
 * win for low-vision riders and anyone who finds the on-screen keyboard hard,
 * and it speaks the rider's chosen UI language (English or Spanish).
 *
 * Entirely feature-detected: where SpeechRecognition isn't available the mic
 * button stays hidden and nothing changes. Best-effort -- any failure surfaces
 * through onError so the caller can restore the input, never throws upward.
 */
(function (global) {
  function ctor() {
    return global.SpeechRecognition || global.webkitSpeechRecognition || null;
  }
  function isAvailable() {
    return !!ctor();
  }

  /**
   * Start one recognition pass. Returns the recognition object (so the caller
   * can abort()) or null if unavailable.
   * @param {{lang?, onResult?, onError?, onEnd?}} opts
   */
  function listen(opts) {
    opts = opts || {};
    const C = ctor();
    if (!C) { if (opts.onError) opts.onError(new Error('speech recognition unavailable')); return null; }
    let rec;
    try {
      rec = new C();
    } catch (e) {
      if (opts.onError) opts.onError(e);
      return null;
    }
    rec.lang = opts.lang || 'en-US';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onresult = (e) => {
      const alt = e && e.results && e.results[0] && e.results[0][0];
      const transcript = alt && alt.transcript != null ? String(alt.transcript).trim() : '';
      if (opts.onResult) opts.onResult(transcript);
    };
    rec.onerror = (e) => { if (opts.onError) opts.onError(e); };
    rec.onend = () => { if (opts.onEnd) opts.onEnd(); };
    try {
      rec.start();
    } catch (e) {
      if (opts.onError) opts.onError(e);
    }
    return rec;
  }

  global.TheBusVoice = { isAvailable, listen };
})(typeof window !== 'undefined' ? window : this);
