// /api/send-notification.js
// Vercel serverless function — admin-only (requires Firebase Auth ID token).
// Sends a web push notification to every stored subscription in Firestore.
// Automatically removes subscriptions that are dead/expired (410/404 responses).

const admin = require('firebase-admin');
const webpush = require('web-push');

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

webpush.setVapidDetails(
  'mailto:owner@parshwajewellers.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

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
    const title = (body && body.title) || 'Parshwa Jewellers';
    const message = (body && body.message) || '';

    if (!message) {
      return res.status(400).json({ error: 'Missing message' });
    }

    const payload = JSON.stringify({
      title: title,
      body: message,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
    });

    const snap = await db.collection('pushSubscriptions').get();

    let sent = 0;
    let failed = 0;
    const deadDocs = [];

    await Promise.all(
      snap.docs.map(async (doc) => {
        const sub = doc.data().subscription;
        try {
          await webpush.sendNotification(sub, payload);
          sent++;
        } catch (err) {
          failed++;
          // 404/410 means the subscription is gone for good — clean it up
          if (err && (err.statusCode === 404 || err.statusCode === 410)) {
            deadDocs.push(doc.id);
          }
        }
      })
    );

    // Clean up dead subscriptions so future sends don't waste time on them
    await Promise.all(
      deadDocs.map((id) => db.collection('pushSubscriptions').doc(id).delete().catch(() => {}))
    );

    return res.status(200).json({ ok: true, sent: sent, failed: failed, removed: deadDocs.length, totalSubscribers: snap.size });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to send notifications' });
  }
};
