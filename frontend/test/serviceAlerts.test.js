const test = require('node:test');
const assert = require('node:assert/strict');
const { loadModules } = require('./helpers');

// Minimal DOM + localStorage stubs -- serviceAlerts.js only touches a tiny
// slice of each (createElement, className/textContent/hidden/appendChild/
// setAttribute/addEventListener, and getItem/setItem).
function makeEl() {
  const el = {
    className: '', _text: '', hidden: false, children: [], attrs: {}, handlers: {},
    appendChild(c) { this.children.push(c); return c; },
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(k, f) { this.handlers[k] = f; },
  };
  Object.defineProperty(el, 'textContent', {
    get() { return this._text; },
    set(v) { this._text = v; if (v === '') this.children = []; }, // '' clears, like a real node
  });
  return el;
}

function installDom() {
  global.document = { createElement: () => makeEl() };
  const store = new Map();
  global.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };
  return { store };
}

loadModules('serviceAlerts.js');

test('banner stays hidden when there are no alerts', () => {
  installDom();
  const container = makeEl();
  TheBusServiceAlerts.init(container, { pollMs: 0 });
  TheBusServiceAlerts._setForTesting([]);
  TheBusServiceAlerts.render();
  assert.equal(container.hidden, true);
  assert.equal(container.children.length, 0);
});

test('banner shows a row per active alert', () => {
  installDom();
  const container = makeEl();
  TheBusServiceAlerts.init(container, { pollMs: 0 });
  TheBusServiceAlerts._setForTesting([
    { id: 'a1', header: 'Route 5 detour', description: 'Skips Main & 1st' },
    { id: 'a2', header: 'Elevator out', description: '' },
  ]);
  TheBusServiceAlerts.render();
  assert.equal(container.hidden, false);
  assert.equal(container.children.length, 2);
});

test('dismissed alert ids are filtered out (and the banner hides when all are dismissed)', () => {
  const { store } = installDom();
  store.set('tribus_dismissed_alerts', JSON.stringify(['a1']));
  const container = makeEl();
  TheBusServiceAlerts.init(container, { pollMs: 0 });
  TheBusServiceAlerts._setForTesting([{ id: 'a1', header: 'Old detour' }]);
  TheBusServiceAlerts.render();
  assert.equal(container.hidden, true);
  assert.equal(container.children.length, 0);
});
