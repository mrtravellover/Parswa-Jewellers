// /api/save-settings.js
// Vercel serverless function — admin-only (requires Firebase Auth ID token).
// Saves the main settings document via the Admin SDK instead of a direct
// client-side Firestore write. Some networks appear to block or hang the
// browser's direct Firestore write channel while everything else (reads,
// other admin-SDK-backed writes like instrument linking) works fine — so
// routing this through the backend, same pattern as linking, sidesteps it.
//
// Every step has an internal timeout so this function can never hang
// silently — if something takes too long, it returns a clear error
// instead of letting Vercel kill it with an opaque 504.

const admin = require('firebase-admin');

console.log('[save-settings] module loading');

if (!admin.apps.length) {
  console.log('[save-settings] initializing admin app');
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
  });
  console.log('[save-settings] admin app initialized');
}

const db = admin.firestore();
console.log('[save-settings] module loaded, firestore instance ready');

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

  console.log('[save-settings] checking env vars present:',
    !!process.env.FIREBASE_PROJECT_ID, !!process.env.FIREBASE_CLIENT_EMAIL, !!process.env.FIREBASE_PRIVATE_KEY);

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

    console.log('[save-settings] writing to firestore');
    await withTimeout(db.collection('app').doc('settings').set(settings, { merge: true }), 6000, 'firestore-write');
    console.log('[save-settings] write complete');

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.log('[save-settings] error:', err.message);
    return res.status(500).json({ error: 'Failed to save settings: ' + err.message });
  }
};
