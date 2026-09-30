/**
 * Lightweight bilingual (English / Spanish) layer for the rider-facing UI
 * chrome -- onboarding, tab labels, the trip planner, buttons, toggles and
 * the seed system messages. Florida's Nature Coast and Tampa Bay have a
 * large Spanish-speaking population, so an English-only app leaves real
 * riders behind.
 *
 * How it works:
 *   - STRINGS holds a flat key -> text table per language.
 *   - t(key) returns the current language's text (falling back to English,
 *     then the key itself, so a missing translation degrades visibly-but-
 *     safely rather than throwing).
 *   - apply(root) walks the DOM and fills any element carrying
 *     data-i18n / data-i18n-html / data-i18n-aria-label / data-i18n-placeholder.
 *     The HTML in index.html keeps its English as the default content, so if
 *     this module ever fails to load the app still reads correctly.
 *
 * Deliberate scope: this translates the UI CHROME. The natural-language
 * QUERY parser (intentParser.js) still understands English phrasing only --
 * teaching it Spanish query vocabulary is a separate, larger pass. The
 * answers it returns are likewise English for now. This foundation makes
 * adding those straightforward later (same t()/STRINGS mechanism).
 */
(function (global) {
  const STRINGS = {
    en: {
      'tab.terminal': '[ TERMINAL ]',
      'tab.map': '[ LIVE MAP ]',
      'onboard.location.title': 'SHARE YOUR LOCATION?',
      'onboard.location.body': 'FAST PATH CAN FIND THE NEAREST STOP OR THE NEXT BUS NEAR YOU AUTOMATICALLY IF YOU SHARE YOUR LOCATION. YOU CAN ALWAYS SKIP THIS AND JUST TYPE A STOP OR PLACE NAME INSTEAD.',
      'onboard.location.yes': '[ YES, SHARE LOCATION ]',
      'onboard.location.no': '[ NOT NOW ]',
      'onboard.help.title': 'HOW TO USE FAST PATH',
      'planner.toggle': '[ PLAN A TRIP ]',
      'planner.header': 'PLAN A TRIP',
      'planner.from': 'FROM',
      'planner.to': 'TO',
      'planner.prefs': 'PREFERENCES',
      'planner.fewerTransfers': 'FEWER TRANSFERS',
      'planner.lessWalking': 'LESS WALKING',
      'planner.wheelchair': 'WHEELCHAIR ACCESSIBLE',
      'planner.bikeShare': 'ALLOW BIKE/SCOOTER SHARE',
      'planner.go': '[ PLAN ]',
      'planner.saved': 'SAVED TRIPS',
      'placeholder.stopAddrCity': 'STOP, ADDRESS, OR CITY',
      'seed.ask': 'TYPE A QUESTION BELOW, E.G. "WHEN IS THE NEXT BUS AT AVALON PUBLIX?"',
      'seed.farther': 'GOING FARTHER? TRY "PLAN TAMPA TO ORLANDO" (NEEDS A CONNECTION).',
      'seed.fares': 'FARES & TICKETS: TYPE "FARES" (OR "FARES HART").',
      'seed.favorites': 'YOUR STOPS: TYPE "FAVORITES" (STAR A STOP ON THE LIVE MAP FIRST).',
      'fx.on': '[ EFFECTS: ON ]',
      'fx.off': '[ EFFECTS: OFF ]',
      'contrast.on': '[ HIGH CONTRAST: ON ]',
      'contrast.off': '[ HIGH CONTRAST: OFF ]',
      // The language button shows the language it switches TO.
      'lang.switch': 'ESPAÑOL',
    },
    es: {
      'tab.terminal': '[ TERMINAL ]',
      'tab.map': '[ MAPA EN VIVO ]',
      'onboard.location.title': '¿COMPARTIR TU UBICACIÓN?',
      'onboard.location.body': 'FAST PATH PUEDE ENCONTRAR LA PARADA MÁS CERCANA O EL PRÓXIMO AUTOBÚS CERCA DE TI AUTOMÁTICAMENTE SI COMPARTES TU UBICACIÓN. SIEMPRE PUEDES OMITIR ESTO Y ESCRIBIR EL NOMBRE DE UNA PARADA O LUGAR.',
      'onboard.location.yes': '[ SÍ, COMPARTIR UBICACIÓN ]',
      'onboard.location.no': '[ AHORA NO ]',
      'onboard.help.title': 'CÓMO USAR FAST PATH',
      'planner.toggle': '[ PLANEAR VIAJE ]',
      'planner.header': 'PLANEAR VIAJE',
      'planner.from': 'DESDE',
      'planner.to': 'HASTA',
      'planner.prefs': 'PREFERENCIAS',
      'planner.fewerTransfers': 'MENOS TRANSBORDOS',
      'planner.lessWalking': 'CAMINAR MENOS',
      'planner.wheelchair': 'ACCESIBLE EN SILLA DE RUEDAS',
      'planner.bikeShare': 'PERMITIR BICI/SCOOTER COMPARTIDO',
      'planner.go': '[ PLANEAR ]',
      'planner.saved': 'VIAJES GUARDADOS',
      'placeholder.stopAddrCity': 'PARADA, DIRECCIÓN O CIUDAD',
      'seed.ask': 'ESCRIBE UNA PREGUNTA ABAJO, P. EJ. "WHEN IS THE NEXT BUS AT AVALON PUBLIX?"',
      'seed.farther': '¿VAS MÁS LEJOS? PRUEBA "PLAN TAMPA TO ORLANDO" (NECESITA CONEXIÓN).',
      'seed.fares': 'TARIFAS Y BOLETOS: ESCRIBE "FARES" (O "FARES HART").',
      'seed.favorites': 'TUS PARADAS: ESCRIBE "FAVORITES" (MARCA UNA PARADA EN EL MAPA PRIMERO).',
      'fx.on': '[ EFECTOS: SÍ ]',
      'fx.off': '[ EFECTOS: NO ]',
      'contrast.on': '[ ALTO CONTRASTE: SÍ ]',
      'contrast.off': '[ ALTO CONTRASTE: NO ]',
      'lang.switch': 'ENGLISH',
    },
  };

  let lang = 'en';

  function t(key) {
    const table = STRINGS[lang] || STRINGS.en;
    if (table[key] != null) return table[key];
    if (STRINGS.en[key] != null) return STRINGS.en[key];
    return key;
  }
  function getLang() { return lang; }
  function setLang(next) { lang = (next === 'es') ? 'es' : 'en'; }

  function apply(root) {
    const scope = root || (global.document || null);
    if (!scope || !scope.querySelectorAll) return;
    scope.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.getAttribute('data-i18n')); });
    scope.querySelectorAll('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.getAttribute('data-i18n-html')); });
    scope.querySelectorAll('[data-i18n-aria-label]').forEach((el) => { el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria-label'))); });
    scope.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder'))); });
    if (scope.documentElement) scope.documentElement.setAttribute('lang', lang);
  }

  global.TheBusI18n = { t, getLang, setLang, apply, STRINGS };
})(typeof window !== 'undefined' ? window : this);
