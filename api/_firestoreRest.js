// /api/_firestoreRest.js
// Talks to Firestore directly over its REST API using plain fetch() and a
// manually-obtained OAuth2 access token — completely bypassing the
// firebase-admin SDK's Firestore client (which uses gRPC/@google-gax
// internally). This exists specifically to test/work around a suspected
// SDK-level incompatibility: every Firestore write via firebase-admin has
// been hanging indefinitely on this Vercel deployment, on both warm and
// cold starts, despite confirmed-correct credentials and IAM permissions —
// while Firebase Admin AUTH calls (a different, REST-based code path in the
// same SDK) work reliably every time. If this file's writes succeed where
// the SDK hung, that confirms the SDK/gRPC path itself is the problem here.
//
// Not a general-purpose Firestore client — just enough to GET and SET
// (merge) single documents, which is all this project's backend needs.

let cachedToken = null;
let cachedTokenExpiry = 0;

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedTokenExpiry > now + 60) {
    return cachedToken;
  }

  const crypto = require('crypto');
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };

  const unsigned = base64url(JSON.stringify(header)) + '.' + base64url(JSON.stringify(claims));
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), privateKey);
  const jwt = unsigned + '.' + base64url(signature).replace(/=+$/, '');

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + jwt,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error('Token exchange failed: ' + resp.status + ' ' + text);
  }

  const data = await resp.json();
  cachedToken = data.access_token;
  cachedTokenExpiry = now + (data.expires_in || 3600);
  return cachedToken;
}

// Converts a plain JS value into Firestore's REST API typed-value format.
function toFirestoreValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (typeof value === 'string') return { stringValue: value };
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(toFirestoreValue) } };
  }
  if (typeof value === 'object') {
    return { mapValue: { fields: toFirestoreFields(value) } };
  }
  return { stringValue: String(value) };
}

function toFirestoreFields(obj) {
  const fields = {};
  for (const [key, value] of Object.entries(obj)) {
    fields[key] = toFirestoreValue(value);
  }
  return fields;
}

// Converts Firestore's typed-value format back into a plain JS value.
function fromFirestoreValue(value) {
  if (!value) return null;
  if ('nullValue' in value) return null;
  if ('booleanValue' in value) return value.booleanValue;
  if ('integerValue' in value) return parseInt(value.integerValue, 10);
  if ('doubleValue' in value) return value.doubleValue;
  if ('stringValue' in value) return value.stringValue;
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(fromFirestoreValue);
  if ('mapValue' in value) return fromFirestoreFields(value.mapValue.fields || {});
  return null;
}

function fromFirestoreFields(fields) {
  const obj = {};
  for (const [key, value] of Object.entries(fields || {})) {
    obj[key] = fromFirestoreValue(value);
  }
  return obj;
}

function docUrl(projectId, path) {
  return `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${path}`;
}

async function firestoreGet(path) {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const token = await getAccessToken();
  const resp = await fetch(docUrl(projectId, path), {
    headers: { Authorization: 'Bearer ' + token },
  });
  if (resp.status === 404) return null;
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error('Firestore GET failed: ' + resp.status + ' ' + text);
  }
  const data = await resp.json();
  return fromFirestoreFields(data.fields || {});
}

async function firestoreSet(path, data) {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const token = await getAccessToken();
  const fields = toFirestoreFields(data);
  const fieldPaths = Object.keys(data).map((k) => 'updateMask.fieldPaths=' + encodeURIComponent(k));
  const url = docUrl(projectId, path) + '?' + fieldPaths.join('&');

  const resp = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error('Firestore SET failed: ' + resp.status + ' ' + text);
  }
  return true;
}

module.exports = { firestoreGet, firestoreSet, getAccessToken };
