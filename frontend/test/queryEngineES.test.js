const test = require('node:test');
const assert = require('node:assert/strict');
const { loadModules, buildMockDataset } = require('./helpers');

// Load i18n too (the English suite deliberately doesn't) so the query engine
// can localize its answers. Runs in its own process, so setting Spanish here
// never affects the English-asserting queryEngine.test.js.
loadModules('i18n.js', 'intentParser.js', 'searchIndex.js', 'queryEngine.js');

const TUESDAY_9AM_ET = new Date('2026-08-25T13:00:00Z');

test('answers come back in Spanish when the language is es, and revert to English', async () => {
  TheBusQueryEngine.setDataset(buildMockDataset());

  TheBusI18n.setLang('es');
  const es = await TheBusQueryEngine.answerQuery('when is the next bus at Avalon Publix', TUESDAY_9AM_ET);
  assert.match(es, /PRÓXIMAS LLEGADAS EN AVALON PUBLIX/);
  assert.match(es, /HACIA/);        // "TOWARD" localized
  assert.match(es, /RUTA/);         // route label localized
  assert.doesNotMatch(es, /NEXT ARRIVALS AT/);
  assert.doesNotMatch(es, /TOWARD/);

  const esFirst = await TheBusQueryEngine.answerQuery('first bus at Avalon Publix', TUESDAY_9AM_ET);
  assert.match(esFirst, /PRIMER AUTOBÚS HOY EN/);

  // Flip back: the very same query is English again (proves it's live, not baked in).
  TheBusI18n.setLang('en');
  const en = await TheBusQueryEngine.answerQuery('when is the next bus at Avalon Publix', TUESDAY_9AM_ET);
  assert.match(en, /NEXT ARRIVALS AT AVALON PUBLIX/);
  assert.match(en, /TOWARD/);
});

test('the top-level "dataset not loaded" guard is localized', async () => {
  // Fresh module with no dataset set: force the guard path.
  delete require.cache[require.resolve('../www/js/queryEngine.js')];
  loadModules('queryEngine.js');
  TheBusI18n.setLang('es');
  const msg = await TheBusQueryEngine.answerQuery('anything', TUESDAY_9AM_ET);
  assert.match(msg, /DATOS NO CARGADOS/);
  TheBusI18n.setLang('en');
});
