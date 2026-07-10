// /api/instrument-manager.js
// Vercel serverless function — admin-only.
// Returns the current instrument mapping (name -> id, status, last seen), the
// unknown-instrument log, the owner's custom card links, and recent rollover
// events, for the Owner Panel's Instrument Manager screen. Requires a valid
// Firebase Auth ID token. Pass ?source=ratnam / kjbullion / shrishyam to pick
// which backend's data to read — each source keeps entirely separate records.

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
const VALID_SOURCES = ['ratnam', 'kjbullion', 'shrishyam'];

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

  const source = VALID_SOURCES.includes(req.query && req.query.source) ? req.query.source : 'ratnam';
  const prefix = source + '_';

  // ── Gather data ──────────────────────────────────────────────────
  try {
    const mappingSnap = await db.collection('liveMarket').doc(prefix + 'instrumentMapping').get();
    const mapping = mappingSnap.exists ? mappingSnap.data() : {};

    const unknownSnap = await db.collection('liveMarket').doc(prefix + 'unknownInstruments').get();
    const unknown = unknownSnap.exists ? unknownSnap.data().items || {} : {};

    const customSnap = await db.collection('liveMarket').doc(prefix + 'customMapping').get();
    const customMapping = customSnap.exists ? customSnap.data() : {};

    // Rollover events for all sources live in one shared log, tagged by a
    // "source" field — fetch a bit more than needed and filter/limit here
    // rather than in the Firestore query, which avoids needing a composite index.
    const rolloverSnap = await db
      .collection('liveMarket')
      .doc('meta')
      .collection('rolloverLog')
      .orderBy('detectedAt', 'desc')
      .limit(40)
      .get();
    const rollovers = rolloverSnap.docs
      .map((d) => Object.assign({ id: d.id }, d.data()))
      .filter((ev) => (ev.source || 'ratnam') === source)
      .slice(0, 20);

    return res.status(200).json({ source, mapping, unknown, customMapping, rollovers });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load instrument manager data' });
  }
};
