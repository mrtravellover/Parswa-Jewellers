// /api/link-instrument.js
// Vercel serverless function — admin-only (requires Firebase Auth ID token).
// Lets the owner assign a previously-unrecognized instrument name to one of
// the canonical cards (mcxGold, mcxSilver, comexGold, comexSilver, usdInr,
// goldHajar, silverChorsa) directly from the Instrument Manager panel — no
// code change needed. Works for any backend source (Ratnam, KJ Bullion, or
// Shri Shyam) via the "source" field, each keeping its own separate mapping
// in Firestore. Pass action:"unlink" with a target to remove whatever
// instrument is currently linked to that card instead of adding a new link.

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
// Forces plain HTTP requests instead of a persistent gRPC connection —
// long-lived gRPC connections can go silently stale between invocations
// on serverless platforms (the function freezes, the connection dies, but
// the SDK doesn't notice until the next write hangs forever waiting on a
// dead connection). preferRest makes every call a fresh, independent HTTP
// request instead, which can't have this staleness problem.
db.settings({ preferRest: true });

const VALID_TARGETS = ['mcxGold', 'mcxSilver', 'comexGold', 'comexSilver', 'usdInr', 'goldHajar', 'silverChorsa'];
const VALID_SOURCES = ['ratnam', 'kjbullion', 'shrishyam'];

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
    const target = body && body.target;
    const source = (body && body.source) || 'ratnam';
    const action = (body && body.action) || 'link';

    if (!VALID_SOURCES.includes(source)) {
      return res.status(400).json({ error: 'Invalid source — must be one of ' + VALID_SOURCES.join(', ') });
    }
    if (!target || !VALID_TARGETS.includes(target)) {
      return res.status(400).json({ error: 'Invalid target — must be one of ' + VALID_TARGETS.join(', ') });
    }

    const prefix = source + '_';
    const customRef = db.collection('liveMarket').doc(prefix + 'customMapping');

    if (action === 'unlink') {
      // Remove whichever instrument name currently points at this target
      const snap = await customRef.get();
      const data = snap.exists ? snap.data() : {};
      const remaining = {};
      let removedName = null;
      for (const [name, mappedTarget] of Object.entries(data)) {
        if (mappedTarget === target) {
          removedName = name;
          continue;
        }
        remaining[name] = mappedTarget;
      }
      await customRef.set(remaining);
      return res.status(200).json({ ok: true, unlinked: removedName, target: target, source: source });
    }

    const rawName = body && body.name;
    if (!rawName) {
      return res.status(400).json({ error: 'Missing name' });
    }
    const normalized = normalizeName(rawName);

    // Save the link
    await customRef.set({ [normalized]: target }, { merge: true });

    // Remove it from that source's unknown-instruments log — it's identified now
    const unknownRef = db.collection('liveMarket').doc(prefix + 'unknownInstruments');
    const unknownSnap = await unknownRef.get();
    if (unknownSnap.exists) {
      const items = unknownSnap.data().items || {};
      if (items[normalized]) {
        delete items[normalized];
        await unknownRef.set({ items: items });
      }
    }

    return res.status(200).json({ ok: true, name: normalized, target: target, source: source });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to save link' });
  }
};
