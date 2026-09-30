const test = require('node:test');
const assert = require('node:assert/strict');
const { loadModules } = require('./helpers');

loadModules('i18n.js');
const i18n = global.TheBusI18n;

test('t() returns the current language, falling back to English then the key itself', () => {
  i18n.setLang('en');
  assert.equal(i18n.t('planner.go'), '[ PLAN ]');
  i18n.setLang('es');
  assert.equal(i18n.t('planner.go'), '[ PLANEAR ]');
  assert.equal(i18n.t('tab.map'), '[ MAPA EN VIVO ]');
  // Unknown key -> returned verbatim (visible-but-safe), never throws.
  assert.equal(i18n.t('does.not.exist'), 'does.not.exist');
  i18n.setLang('en');
});

test('setLang only accepts en/es and defaults anything else to en', () => {
  i18n.setLang('es');
  assert.equal(i18n.getLang(), 'es');
  i18n.setLang('fr');
  assert.equal(i18n.getLang(), 'en');
  i18n.setLang('en');
});

test('every Spanish key has an English counterpart (no orphan translations)', () => {
  const enKeys = Object.keys(i18n.STRINGS.en);
  const esKeys = Object.keys(i18n.STRINGS.es);
  for (const k of esKeys) {
    assert.ok(enKeys.includes(k), `es key "${k}" is missing from en`);
  }
  // And English is fully translated to Spanish (so nothing silently falls back).
  for (const k of enKeys) {
    assert.ok(esKeys.includes(k), `en key "${k}" has no es translation`);
  }
});
