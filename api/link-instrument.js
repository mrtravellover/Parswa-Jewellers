// /api/link-instrument.js
// Vercel serverless function — admin-only (requires Firebase Auth ID token).
// Lets the owner assign a previously-unrecognized instrument name to one of
// the 5 canonical cards (mcxGold, mcxSilver, comexGold, comexSilver, usdInr)
// directly from the Instrument Manager panel — no code change needed.

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

const VALID_TARGETS = ['mcxGold', 'mcxSilver', 'comexGold', 'comexSilver', 'usdInr', 'goldHajar', 'silverChorsa'];

function normalizeName(name) {
  return name.trim().toUpperCase().replace(/[.\u2026\s]+/g, '');
}

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

  // ── Verify the caller is a logged-in owner ──────────────────────
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
    const rawName = body && body.name;
    const target = body && body.target;

    if (!rawName || !target) {
      return res.status(400).json({ error: 'Missing name or target' });
    }
    if (!VALID_TARGETS.includes(target)) {
      return res.status(400).json({ error: 'Invalid target — must be one of ' + VALID_TARGETS.join(', ') });
    }

    const normalized = normalizeName(rawName);

    // Save the link
    await db.collection('liveMarket').doc('customMapping').set(
      { [normalized]: target },
      { merge: true }
    );

    // Remove it from the unknown-instruments log — it's identified now
    const unknownRef = db.collection('liveMarket').doc('unknownInstruments');
    const unknownSnap = await unknownRef.get();
    if (unknownSnap.exists) {
      const items = unknownSnap.data().items || {};
      if (items[normalized]) {
        delete items[normalized];
        await unknownRef.set({ items: items });
      }
    }

    return res.status(200).json({ ok: true, name: normalized, target: target });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to save link' });
  }
};
