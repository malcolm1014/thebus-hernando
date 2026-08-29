const test = require('node:test');
const assert = require('node:assert/strict');
const { createRateLimiter } = require('../src/rateLimit');

/** Minimal Express-shaped req/res stand-ins -- the middleware only ever touches req.ip and res.status/setHeader/json. */
function mockReqRes(ip) {
  const req = { ip };
  const res = {
    statusCode: null,
    headers: {},
    body: null,
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  return { req, res };
}

test('allows requests under the limit', () => {
  const limit = createRateLimiter({ windowMs: 60000, max: 3 });
  const { req, res } = mockReqRes('1.2.3.4');
  let nextCalls = 0;
  for (let i = 0; i < 3; i++) limit(req, res, () => { nextCalls += 1; });
  assert.equal(nextCalls, 3);
  assert.equal(res.statusCode, null);
});

test('blocks the request that exceeds the limit with a 429', () => {
  const limit = createRateLimiter({ windowMs: 60000, max: 2 });
  const { req, res } = mockReqRes('1.2.3.4');
  let nextCalls = 0;
  const next = () => { nextCalls += 1; };
  limit(req, res, next);
  limit(req, res, next);
  limit(req, res, next); // third request in the window, over max: 2
  assert.equal(nextCalls, 2);
  assert.equal(res.statusCode, 429);
  assert.ok(res.headers['Retry-After']);
});

test('tracks separate IPs independently -- one client hitting the limit does not block another', () => {
  const limit = createRateLimiter({ windowMs: 60000, max: 1 });
  const a = mockReqRes('1.1.1.1');
  const b = mockReqRes('2.2.2.2');
  let nextCalls = 0;
  const next = () => { nextCalls += 1; };
  limit(a.req, a.res, next);
  limit(a.req, a.res, next); // blocked -- second request from the SAME ip within the window
  limit(b.req, b.res, next); // a different ip's first request -- unaffected by a's limit
  assert.equal(nextCalls, 2);
  assert.equal(a.res.statusCode, 429);
  assert.equal(b.res.statusCode, null);
});

test('a request outside the window is allowed again once the window has passed', async () => {
  const limit = createRateLimiter({ windowMs: 50, max: 1 });
  const { req, res } = mockReqRes('1.2.3.4');
  let nextCalls = 0;
  const next = () => { nextCalls += 1; };
  limit(req, res, next);
  limit(req, res, next); // blocked, still inside the 50ms window
  await new Promise((resolve) => setTimeout(resolve, 60));
  limit(req, res, next); // window has rolled forward -- allowed again
  assert.equal(nextCalls, 2);
});
