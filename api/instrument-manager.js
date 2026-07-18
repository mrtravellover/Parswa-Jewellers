// /api/instrument-manager.js
// Vercel serverless function — admin-only.
// Returns the current instrument mapping (name -> id, status, last seen), the
// unknown-instrument log, the owner's custom card links, and recent rollover
// events, for the Owner Panel's Instrument Manager screen. Requires a valid
// Firebase Auth ID token. Pass ?source=ratnam / kjbullion / shrishyam to pick
// which backend's data to read — each source keeps entirely separate records.
// Pass ?light=1 to skip customMapping + rollover history (1 Firestore read
// instead of 3) — used by the Instrument Assignments picker, which only
// needs instrument names, not rollover history.
//
// mapping + unknown live together in one "_data" document now (see
// live-market.js for why); customMapping stays separate deliberately since
// a different file owns writing it. This keeps reads down to 2 total
// (1 in light mode) instead of the original 4.
//
// Uses raw REST for Firestore (see _firestoreRest.js) instead of the Admin
// SDK's Firestore client — see save-settings.js for the full reasoning.

const admin = require('firebase-admin');
const { firestoreGet, firestoreListCollection } = require('./_firestoreRest');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
  });
}

const VALID_SOURCES = ['ratnam', 'kjbullion', 'shrishyam'];

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('verify-timeout')), ms)),
  ]);
}

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
    await withTimeout(admin.auth().verifyIdToken(token), 6000);
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired login token' });
  }

  const source = VALID_SOURCES.includes(req.query && req.query.source) ? req.query.source : 'ratnam';
  const prefix = source + '_';
  const light = !!(req.query && req.query.light);

  // ── Gather data (in parallel, not one-at-a-time) ─────────────────
  try {
    if (light) {
      const data = await firestoreGet('liveMarket/' + prefix + 'data');
      return res.status(200).json({
        source,
        mapping: (data && data.mapping) || {},
        unknown: (data && data.unknown) || {},
      });
    }

    const [data, customMapping, rolloverDocs] = await Promise.all([
      firestoreGet('liveMarket/' + prefix + 'data'),
      firestoreGet('liveMarket/' + prefix + 'customMapping'),
      firestoreListCollection('liveMarket/meta/rolloverLog'),
    ]);

    // Rollover events for all sources live in one shared subcollection,
    // tagged by a "source" field — filter/sort/limit here in JS rather than
    // in the query, keeping this on the simple REST list-and-filter path.
    const rollovers = rolloverDocs
      .map(({ id, data }) => Object.assign({ id }, data))
      .filter((ev) => (ev.source || 'ratnam') === source)
      .sort((a, b) => (b.detectedAt || 0) - (a.detectedAt || 0))
      .slice(0, 20);

    return res.status(200).json({
      source,
      mapping: (data && data.mapping) || {},
      unknown: (data && data.unknown) || {},
      customMapping: customMapping || {},
      rollovers,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load instrument manager data: ' + err.message });
  }
};
