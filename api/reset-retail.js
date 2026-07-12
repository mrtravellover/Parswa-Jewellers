// /api/reset-retail.js
// Vercel serverless function — admin-only (requires Firebase Auth ID token).
// Removes any custom instrument links pointing at goldHajar or silverChorsa,
// across every backend source (Ratnam, KJ Bullion, Shri Shyam). Does NOT
// touch MCX/Comex/USD-INR links — those stay exactly as configured. Premiums
// are reset separately, client-side, since those live in the main settings
// document the owner already has direct write access to.
//
// Writes go through raw REST (see _firestoreRest.js) instead of the Admin
// SDK's Firestore client — see save-settings.js for the full reasoning.

const admin = require('firebase-admin');
const { firestoreGet, firestoreSet } = require('./_firestoreRest');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
  });
}

const SOURCES = ['ratnam', 'kjbullion', 'shrishyam'];
const RETAIL_TARGETS = ['goldHajar', 'silverChorsa'];

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
    const removed = [];
    for (const source of SOURCES) {
      const path = 'liveMarket/' + source + '_customMapping';
      const data = await firestoreGet(path);
      if (!data) continue;
      const remaining = {};
      for (const [name, target] of Object.entries(data)) {
        if (RETAIL_TARGETS.includes(target)) {
          removed.push({ source, name, target });
          continue;
        }
        remaining[name] = target;
      }
      await firestoreSet(path, remaining);
    }
    return res.status(200).json({ ok: true, removed });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to reset retail links: ' + err.message });
  }
};
