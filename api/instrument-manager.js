// /api/instrument-manager.js
// Vercel serverless function — admin-only.
// Returns the current instrument mapping (name -> id, status, last seen), the
// unknown-instrument log, and recent rollover events, for the Owner Panel's
// Instrument Manager screen. Requires a valid Firebase Auth ID token.

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
  res.setHeader('Cache-Control', 'no-store');

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

  // ── Gather data ──────────────────────────────────────────────────
  try {
    const mappingSnap = await db.collection('liveMarket').doc('instrumentMapping').get();
    const mapping = mappingSnap.exists ? mappingSnap.data() : {};

    const unknownSnap = await db.collection('liveMarket').doc('unknownInstruments').get();
    const unknown = unknownSnap.exists ? unknownSnap.data().items || {} : {};

    const rolloverSnap = await db
      .collection('liveMarket')
      .doc('meta')
      .collection('rolloverLog')
      .orderBy('detectedAt', 'desc')
      .limit(20)
      .get();
    const rollovers = rolloverSnap.docs.map((d) => Object.assign({ id: d.id }, d.data()));

    return res.status(200).json({ mapping, unknown, rollovers });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load instrument manager data' });
  }
};
