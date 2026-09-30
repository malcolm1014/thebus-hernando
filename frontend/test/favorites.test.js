const test = require('node:test');
const assert = require('node:assert/strict');
const { loadModules } = require('./helpers');

loadModules('favorites.js');
const { formatBoard } = global.TheBusFavorites;

test('formatBoard prompts to add favorites when there are none', () => {
  const out = formatBoard([]);
  assert.match(out, /NO FAVORITE STOPS YET/);
  assert.match(out, /FAVORITE/);
});

test('formatBoard lists each stop with its soonest arrivals (DUE for <=0 minutes)', () => {
  const out = formatBoard([
    { name: 'Avalon Publix', arrivals: [{ routeLabel: '6', minutesUntil: 0 }, { routeLabel: '9', minutesUntil: 12 }] },
    { name: 'Marion Transit Center', arrivals: [] },
  ]);
  assert.match(out, /YOUR STOPS/);
  assert.match(out, /AVALON PUBLIX/);
  assert.match(out, /6: DUE/);
  assert.match(out, /9: 12 MIN/);
  assert.match(out, /MARION TRANSIT CENTER/);
  assert.match(out, /NO MORE ARRIVALS TODAY/);
});

test('formatBoard caps each stop at three arrivals', () => {
  const arrivals = [1, 2, 3, 4, 5].map((m) => ({ routeLabel: 'X', minutesUntil: m }));
  const out = formatBoard([{ name: 'Busy Stop', arrivals }]);
  const shown = out.split('\n').filter((l) => /X: \d+ MIN/.test(l));
  assert.equal(shown.length, 3);
});
