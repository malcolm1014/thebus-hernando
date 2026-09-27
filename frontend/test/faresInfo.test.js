const test = require('node:test');
const assert = require('node:assert/strict');
const { loadModules } = require('./helpers');

loadModules('faresInfo.js');

test('forAgency returns the right agency card', () => {
  assert.equal(TheBusFares.forAgency('hart').label, 'HART (TAMPA)');
  assert.equal(TheBusFares.forAgency('pasco').singleRide.includes('$1.50'), true);
  assert.equal(TheBusFares.forAgency('nope'), null);
});

test('matchByName maps a free-text agency name (e.g. a plan leg) to a fare card', () => {
  assert.equal(TheBusFares.matchByName('Hillsborough Area Regional Transit').label, 'HART (TAMPA)');
  assert.equal(TheBusFares.matchByName('GoPasco').label.includes('PASCO'), true);
  assert.equal(TheBusFares.matchByName('Pinellas Suncoast Transit'), null);
});

test('format includes price (or a "see official page" fallback), pay methods, and the official link', () => {
  const hart = TheBusFares.format(TheBusFares.forAgency('hart'));
  assert.match(hart, /\$2\.00/);
  assert.match(hart, /HOW TO PAY/);
  assert.match(hart, /gohart\.org/);

  // Hernando has no published single-ride price -> no invented number.
  const hern = TheBusFares.format(TheBusFares.forAgency('hernando'));
  assert.match(hern, /SEE OFFICIAL PAGE|OFFICIAL/);
  assert.doesNotMatch(hern, /\$\d/); // never fabricates a dollar amount
});

test('formatQuery narrows to one agency when named, else lists all', () => {
  assert.match(TheBusFares.formatQuery('pasco'), /PASCO/);
  assert.doesNotMatch(TheBusFares.formatQuery('pasco'), /HART \(TAMPA\)/);
  const all = TheBusFares.formatQuery('');
  assert.match(all, /HART/);
  assert.match(all, /PASCO/);
  assert.match(all, /THEBUS/);
});
