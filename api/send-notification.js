// /api/send-notification.js
// Vercel serverless function — admin-only (requires Firebase Auth ID token).
// Sends a web push notification to every stored subscription in Firestore.
// Automatically removes subscriptions that are dead/expired (410/404 responses).
//
// Uses raw REST for Firestore (see _firestoreRest.js) instead of the Admin
// SDK's Firestore client — see save-settings.js for the full reasoning.

const admin = require('firebase-admin');
const webpush = require('web-push');
const { firestoreListCollection, firestoreDelete } = require('./_firestoreRest');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
  });
}

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

    const subscriptions = await firestoreListCollection('pushSubscriptions');

    let sent = 0;
    let failed = 0;
    const deadDocs = [];

    await Promise.all(
      subscriptions.map(async ({ id, data }) => {
        const sub = data.subscription;
        try {
          await webpush.sendNotification(sub, payload);
          sent++;
        } catch (err) {
          failed++;
          // 404/410 means the subscription is gone for good — clean it up
          if (err && (err.statusCode === 404 || err.statusCode === 410)) {
            deadDocs.push(id);
          }
        }
      })
    );

    // Clean up dead subscriptions so future sends don't waste time on them
    await Promise.all(
      deadDocs.map((id) => firestoreDelete('pushSubscriptions/' + id).catch(() => {}))
    );

    return res.status(200).json({ ok: true, sent: sent, failed: failed, removed: deadDocs.length, totalSubscribers: subscriptions.length });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to send notifications: ' + err.message });
  }
};
