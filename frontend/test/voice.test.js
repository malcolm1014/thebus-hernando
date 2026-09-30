const test = require('node:test');
const assert = require('node:assert/strict');
const { loadModules } = require('./helpers');

loadModules('voice.js');
const voice = global.TheBusVoice;

// Node has no SpeechRecognition, so this exercises the unsupported path --
// which is exactly the webview-without-speech case: report unavailable and
// route through onError instead of throwing.
test('voice reports unavailable and routes to onError without SpeechRecognition', () => {
  assert.equal(voice.isAvailable(), false);
  let errored = false;
  const rec = voice.listen({ onError: () => { errored = true; } });
  assert.equal(rec, null);
  assert.equal(errored, true);
});

test('voice.listen uses a provided SpeechRecognition and wires a result back', () => {
  const started = [];
  class FakeRec {
    start() { started.push(this.lang); if (this.onresult) this.onresult({ results: [[{ transcript: '  next bus at avalon  ' }]] }); if (this.onend) this.onend(); }
  }
  const prev = global.SpeechRecognition;
  global.SpeechRecognition = FakeRec;
  try {
    assert.equal(voice.isAvailable(), true);
    let got = null; let ended = false;
    voice.listen({ lang: 'es-US', onResult: (t) => { got = t; }, onEnd: () => { ended = true; } });
    assert.equal(started[0], 'es-US');
    assert.equal(got, 'next bus at avalon'); // trimmed
    assert.equal(ended, true);
  } finally {
    if (prev === undefined) delete global.SpeechRecognition; else global.SpeechRecognition = prev;
  }
});
