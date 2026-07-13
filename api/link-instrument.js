// /api/link-instrument.js
// Vercel serverless function — admin-only (requires Firebase Auth ID token).
// Lets the owner assign a previously-unrecognized instrument name to one of
// the canonical cards (mcxGold, mcxSilver, comexGold, comexSilver, usdInr,
// goldHajar, silverChorsa) directly from the Instrument Manager panel — no
// code change needed. Works for any backend source (Ratnam, KJ Bullion, or
// Shri Shyam) via the "source" field, each keeping its own separate mapping
// in Firestore. Pass action:"unlink" with a target to remove whatever
// instrument is currently linked to that card instead of adding a new link.
//
// Writes go through raw REST (see _firestoreRest.js) instead of the Admin
// SDK's Firestore client — every write via the SDK client was hanging
// indefinitely on this deployment. See save-settings.js for full reasoning.

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

const VALID_TARGETS = ['mcxGold', 'mcxSilver', 'comexGold', 'comexSilver', 'usdInr', 'goldHajar', 'silverChorsa'];
const VALID_SOURCES = ['ratnam', 'kjbullion', 'shrishyam'];

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('verify-timeout')), ms)),
  ]);
}

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
    await withTimeout(admin.auth().verifyIdToken(token), 6000);
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
    const customPath = 'liveMarket/' + prefix + 'customMapping';

    if (action === 'unlink') {
      const data = (await firestoreGet(customPath)) || {};
      const remaining = {};
      let removedName = null;
      for (const [name, mappedTarget] of Object.entries(data)) {
        if (mappedTarget === target) {
          removedName = name;
          continue;
        }
        remaining[name] = mappedTarget;
      }
      await firestoreSet(customPath, remaining);
      return res.status(200).json({ ok: true, unlinked: removedName, target: target, source: source });
    }

    const rawName = body && body.name;
    if (!rawName) {
      return res.status(400).json({ error: 'Missing name' });
    }
    const normalized = normalizeName(rawName);

    // Save the link — first remove any OTHER instrument currently linked to
    // this same target. A card can only be fed by one instrument at a time;
    // without this, an old link and a new one could both stay active
    // simultaneously, silently fighting over which one actually feeds the
    // card (this exact bug was reported and confirmed — two different
    // instruments both linked to Gold Hajar 24K at once).
    const currentMapping = (await firestoreGet(customPath)) || {};
    for (const [existingName, existingTarget] of Object.entries(currentMapping)) {
      if (existingTarget === target && existingName !== normalized) {
        delete currentMapping[existingName];
      }
    }
    currentMapping[normalized] = target;
    await firestoreSet(customPath, currentMapping);

    // Remove it from that source's unknown-instruments log — it's identified
    // now. mapping + unknown live together in one document (see
    // live-market.js) and writes are always a full replace, so we read the
    // WHOLE thing first and write the WHOLE thing back — otherwise this
    // would silently wipe out the mapping half by only sending unknown.
    const dataPath = 'liveMarket/' + prefix + 'data';
    const data = (await firestoreGet(dataPath)) || {};
    const unknown = data.unknown || {};
    if (unknown[normalized]) {
      delete unknown[normalized];
      await firestoreSet(dataPath, { mapping: data.mapping || {}, unknown: unknown });
    }

    return res.status(200).json({ ok: true, name: normalized, target: target, source: source });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to save link: ' + err.message });
  }
};
