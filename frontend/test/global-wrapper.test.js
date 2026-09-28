const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Regression guard for a whole CLASS of "green in CI, dead on device" bug.
 *
 * Every frontend module runs in the browser/Android WebView, where `global`
 * is NOT a defined identifier -- so any file that references `global` must
 * receive it as an IIFE parameter (the codebase convention is
 * `(function (global) { ... })(window)`). If a file references bare `global`
 * WITHOUT declaring that parameter, it works in Node (where `global` is a
 * built-in, so these unit tests pass) but throws `ReferenceError: global is
 * not defined` the instant that line runs in the app -- which, when it's a
 * top-level reference, aborts the whole script before boot() ever runs.
 *
 * That is exactly what broke app.js once (it referenced global.TheBus* at
 * top level but was wrapped as `(function () {`), freezing the app at
 * "INITIALIZING OFFLINE DATASET..." with a dead map. This test would have
 * caught it.
 */
test('every www/js module that uses `global` declares it as an IIFE parameter', () => {
  const jsDir = path.join(__dirname, '..', 'www', 'js');
  const files = fs.readdirSync(jsDir).filter((f) => f.endsWith('.js'));
  assert.ok(files.length > 0, 'expected to find frontend js modules');

  const offenders = [];
  for (const file of files) {
    const src = fs.readFileSync(path.join(jsDir, file), 'utf8');
    // Does the file reference the `global` identifier (property access like
    // `global.X` or a bare `global`), as opposed to it never appearing?
    const usesGlobal = /\bglobal\b/.test(src);
    if (!usesGlobal) continue;
    // If it does, it must take `global` as a function parameter somewhere,
    // e.g. `(function (global) {` or `function (global, ...)`. Without that
    // declaration a browser ReferenceError is guaranteed.
    const declaresGlobalParam = /function\s*\([^)]*\bglobal\b[^)]*\)/.test(src);
    if (!declaresGlobalParam) offenders.push(file);
  }

  assert.deepEqual(
    offenders,
    [],
    `these modules reference \`global\` without declaring it as a parameter, `
      + `which throws ReferenceError in the browser: ${offenders.join(', ')}`
  );
});
