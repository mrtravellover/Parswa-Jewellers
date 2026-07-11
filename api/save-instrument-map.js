// /api/save-instrument-map.js
// Vercel serverless function — admin-only (requires Firebase Auth ID token).
// Saves the Hajar Bajar instrument map (app/instrumentMap) via the Admin
// SDK instead of a direct client-side Firestore write — same reasoning as
// /api/save-settings.js: some networks block/hang the browser's direct
// Firestore write channel even while reads work fine.

const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
  });
}

const db = admin.firestore();

module.exports = async (req, res) => {
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
    return res.status(401).json({ error: 'Missing Authorization: Bearer <idToken> header' });
  }
  try {
    await admin.auth().verifyIdToken(token);
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired login token' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const instrumentMap = body && body.instrumentMap;
    if (!instrumentMap || typeof instrumentMap !== 'object') {
      return res.status(400).json({ error: 'Missing instrumentMap object' });
    }

    await db.collection('app').doc('instrumentMap').set(instrumentMap, { merge: true });

    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to save instrument map' });
  }
};
