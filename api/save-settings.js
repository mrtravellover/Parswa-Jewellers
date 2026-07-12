// /api/save-settings.js
// Vercel serverless function — admin-only (requires Firebase Auth ID token).
//
// IMPORTANT: this now writes to Firestore via a raw REST call (see
// _firestoreRest.js) instead of the firebase-admin SDK's Firestore client.
// Every write through the SDK's client has been hanging indefinitely on
// this deployment — on both warm and cold starts, despite confirmed-correct
// credentials and IAM permissions — while Auth token verification (a
// different, REST-based code path within the same SDK) has always worked
// reliably. This routes the actual database write around that entirely,
// as both a diagnostic test and a likely real fix. Token verification still
// uses firebase-admin, since that part was never the problem.

const admin = require('firebase-admin');
const { firestoreSet } = require('./_firestoreRest');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
  });
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label + '-timeout')), ms)),
  ]);
}

module.exports = async (req, res) => {
  console.log('[save-settings] invoked, method:', req.method);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    console.log('[save-settings] no token provided');
    return res.status(401).json({ error: 'Missing Authorization: Bearer <idToken> header' });
  }

  console.log('[save-settings] verifying token');
  try {
    await withTimeout(admin.auth().verifyIdToken(token), 6000, 'verify');
    console.log('[save-settings] token verified');
  } catch (e) {
    console.log('[save-settings] token verify failed:', e.message);
    return res.status(401).json({ error: 'Invalid or expired login token: ' + e.message });
  }

  try {
    console.log('[save-settings] parsing body');
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const settings = body && body.settings;
    if (!settings || typeof settings !== 'object') {
      console.log('[save-settings] missing settings in body');
      return res.status(400).json({ error: 'Missing settings object' });
    }

    console.log('[save-settings] writing to firestore via REST');
    await withTimeout(firestoreSet('ownerConfig/settings', settings), 10000, 'firestore-write');
    console.log('[save-settings] write complete');

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.log('[save-settings] error:', err.message);
    return res.status(500).json({ error: 'Failed to save settings: ' + err.message });
  }
};
