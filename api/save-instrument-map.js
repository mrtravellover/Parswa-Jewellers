// /api/save-instrument-map.js
// Vercel serverless function — admin-only (requires Firebase Auth ID token).
// Writes to Firestore via raw REST (see _firestoreRest.js) instead of the
// Admin SDK's Firestore client — see save-settings.js for the full reasoning.

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
  console.log('[save-instrument-map] invoked, method:', req.method);
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
    console.log('[save-instrument-map] no token provided');
    return res.status(401).json({ error: 'Missing Authorization: Bearer <idToken> header' });
  }

  console.log('[save-instrument-map] verifying token');
  try {
    await withTimeout(admin.auth().verifyIdToken(token), 6000, 'verify');
    console.log('[save-instrument-map] token verified');
  } catch (e) {
    console.log('[save-instrument-map] token verify failed:', e.message);
    return res.status(401).json({ error: 'Invalid or expired login token: ' + e.message });
  }

  try {
    console.log('[save-instrument-map] parsing body');
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const instrumentMap = body && body.instrumentMap;
    if (!instrumentMap || typeof instrumentMap !== 'object') {
      console.log('[save-instrument-map] missing instrumentMap in body');
      return res.status(400).json({ error: 'Missing instrumentMap object' });
    }

    console.log('[save-instrument-map] writing to firestore via REST');
    await withTimeout(firestoreSet('ownerConfig/instrumentMap', instrumentMap), 10000, 'firestore-write');
    console.log('[save-instrument-map] write complete');

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.log('[save-instrument-map] error:', err.message);
    return res.status(500).json({ error: 'Failed to save instrument map: ' + err.message });
  }
};
