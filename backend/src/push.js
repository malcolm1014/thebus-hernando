/**
 * Firebase Cloud Messaging (FCM) sender -- the server half of "notify a
 * rider on a followed route even when the app is fully closed."
 *
 * Uses the FCM HTTP v1 API directly with Node's built-in crypto (a
 * service-account JWT -> OAuth2 access token -> messages:send), so there's
 * NO heavy firebase-admin dependency -- consistent with this backend's
 * dependency-light design. Entirely gated on config.fcmServiceAccount:
 * with no credentials it's a no-op (isConfigured() === false), exactly like
 * every other optional integration here (Swiftly, Groq, Geoapify...).
 *
 * SETUP (see README "Push notifications server"): create a Firebase project,
 * add an Android app with this app id (com.savvysecurity.thebus), download
 * the service-account JSON, and set it as the FCM_SERVICE_ACCOUNT env var
 * (the whole JSON, one line). The client half (@capacitor/push-notifications)
 * registers each device's token via POST /api/push/register.
 *
 * Free-tier caveat: the alert-check cron only runs while the Render instance
 * is awake, so keep it warm (external pinger) or use a paid instance for
 * reliable delivery -- same constraint the ETL cron documents.
 */
const crypto = require('crypto');
const config = require('./config');

const OAUTH_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

function serviceAccount() {
  return config.fcmServiceAccount || null;
}

function projectId() {
  const sa = serviceAccount();
  return sa && sa.project_id ? sa.project_id : null;
}

function isConfigured() {
  const sa = serviceAccount();
  return !!(sa && sa.client_email && sa.private_key && projectId());
}

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** Builds a signed service-account JWT assertion (RS256). Pure/testable. */
function buildAssertion(sa, nowSec = Math.floor(Date.now() / 1000)) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: sa.client_email,
    scope: OAUTH_SCOPE,
    aud: sa.token_uri || 'https://oauth2.googleapis.com/token',
    iat: nowSec,
    exp: nowSec + 3600,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = crypto.createSign('RSA-SHA256').update(signingInput).sign(sa.private_key);
  return `${signingInput}.${b64url(signature)}`;
}

/** Shapes an FCM HTTP v1 message body for one device token. Pure/testable. */
function buildMessage(token, { title, body, data } = {}) {
  const message = {
    token,
    notification: { title: title || 'Service alert', body: body || '' },
    android: { priority: 'HIGH', notification: { channel_id: 'service-alerts' } },
  };
  if (data && typeof data === 'object') {
    // FCM data values must be strings.
    message.data = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)]));
  }
  return { message };
}

let tokenCache = { accessToken: null, expiresAt: 0 };

async function getAccessToken(now = Date.now()) {
  if (!isConfigured()) throw new Error('FCM not configured (FCM_SERVICE_ACCOUNT)');
  if (tokenCache.accessToken && now < tokenCache.expiresAt) return tokenCache.accessToken;

  const sa = serviceAccount();
  const assertion = buildAssertion(sa, Math.floor(now / 1000));
  const res = await fetch(sa.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${encodeURIComponent(assertion)}`,
  });
  if (!res.ok) throw new Error(`FCM token exchange failed: HTTP ${res.status}`);
  const json = await res.json();
  const ttlMs = (Number(json.expires_in) || 3600) * 1000;
  tokenCache = { accessToken: json.access_token, expiresAt: now + ttlMs - 60 * 1000 }; // refresh a minute early
  return tokenCache.accessToken;
}

/**
 * Sends one notification to one device token. Returns { ok, status,
 * unregister } -- unregister:true means the token is dead (FCM 404/
 * UNREGISTERED) and the caller should drop it.
 */
async function sendToToken(token, notification) {
  const accessToken = await getAccessToken();
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId()}/messages:send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildMessage(token, notification)),
  });
  return { ok: res.ok, status: res.status, unregister: res.status === 404 };
}

module.exports = { isConfigured, projectId, buildAssertion, buildMessage, getAccessToken, sendToToken };
