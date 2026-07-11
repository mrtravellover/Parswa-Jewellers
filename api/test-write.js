// /api/test-write.js
// Pure diagnostic endpoint — no auth check, no business logic, does exactly
// one thing: writes a single field to a brand new test document and reports
// how long it took. Visit this directly in your browser (GET request) —
// no login needed. This isolates whether ANY Firestore write can succeed
// from this Vercel project at all, stripped of every other variable.

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
  const startedAt = Date.now();
  try {
    await db.collection('diagnosticTest').doc('ping').set({ test: startedAt, hello: 'world' });
    const durationMs = Date.now() - startedAt;
    return res.status(200).json({ ok: true, durationMs: durationMs, message: 'Write succeeded' });
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    return res.status(500).json({ ok: false, durationMs: durationMs, error: err.message, code: err.code || null });
  }
};
