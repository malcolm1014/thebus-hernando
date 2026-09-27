const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

// A throwaway RSA keypair so we can build and verify a real JWT assertion
// without any real Firebase credentials.
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const SERVICE_ACCOUNT = {
  client_email: 'svc@tribus.iam.gserviceaccount.com',
  private_key: PRIVATE_PEM,
  project_id: 'tribus-test',
  token_uri: 'https://oauth2.googleapis.com/token',
};

function freshPush(env) {
  const prev = process.env.FCM_SERVICE_ACCOUNT;
  if (env === undefined) delete process.env.FCM_SERVICE_ACCOUNT;
  else process.env.FCM_SERVICE_ACCOUNT = env;
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/push')];
  const mod = require('../src/push');
  return { mod, restore() { if (prev === undefined) delete process.env.FCM_SERVICE_ACCOUNT; else process.env.FCM_SERVICE_ACCOUNT = prev; } };
}

function b64urlToBuf(s) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

test('isConfigured reflects whether valid FCM credentials are present', () => {
  let { mod, restore } = freshPush(undefined);
  assert.equal(mod.isConfigured(), false);
  restore();
  ({ mod, restore } = freshPush(JSON.stringify(SERVICE_ACCOUNT)));
  assert.equal(mod.isConfigured(), true);
  assert.equal(mod.projectId(), 'tribus-test');
  restore();
});

test('buildAssertion produces a JWT with correct claims and a verifiable RS256 signature', () => {
  const { mod, restore } = freshPush(JSON.stringify(SERVICE_ACCOUNT));
  try {
    const jwt = mod.buildAssertion(SERVICE_ACCOUNT, 1_000_000);
    const [h, c, sig] = jwt.split('.');
    const header = JSON.parse(b64urlToBuf(h).toString('utf8'));
    const claims = JSON.parse(b64urlToBuf(c).toString('utf8'));
    assert.equal(header.alg, 'RS256');
    assert.equal(claims.iss, SERVICE_ACCOUNT.client_email);
    assert.equal(claims.aud, SERVICE_ACCOUNT.token_uri);
    assert.equal(claims.scope, 'https://www.googleapis.com/auth/firebase.messaging');
    assert.equal(claims.iat, 1_000_000);
    assert.equal(claims.exp, 1_000_000 + 3600);
    const ok = crypto.createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, b64urlToBuf(sig));
    assert.equal(ok, true);
  } finally { restore(); }
});

test('buildMessage shapes an FCM v1 body with the alerts channel and stringified data', () => {
  const { mod, restore } = freshPush(JSON.stringify(SERVICE_ACCOUNT));
  try {
    const { message } = mod.buildMessage('devtoken', { title: 'Route 5: DETOUR', body: 'Skips Main', data: { alertId: 7 } });
    assert.equal(message.token, 'devtoken');
    assert.equal(message.notification.title, 'Route 5: DETOUR');
    assert.equal(message.android.notification.channel_id, 'service-alerts');
    assert.equal(message.data.alertId, '7'); // FCM data values must be strings
  } finally { restore(); }
});
