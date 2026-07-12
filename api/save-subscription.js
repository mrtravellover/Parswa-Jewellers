// /api/save-subscription.js
// Vercel serverless function — public, no auth required.
// Stores a visitor's browser push subscription in Firestore, along with
// their own personal price-alert preference (which metric to watch, and
// how much it needs to move before they're notified).
//
// Writes go through raw REST (see _firestoreRest.js) instead of the Admin
// SDK's Firestore client — see save-settings.js for the full reasoning.

const { firestoreGet, firestoreSet } = require('./_firestoreRest');

const VALID_METRICS = ['mcxGold', 'mcxSilver', 'goldHajar', 'silverChorsa'];

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const subscription = body && body.subscription;
    const metric = VALID_METRICS.includes(body && body.metric) ? body.metric : 'mcxGold';
    const threshold = (body && typeof body.threshold === 'number' && body.threshold > 0) ? body.threshold : 500;

    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: 'Missing subscription' });
    }

    // Use the endpoint URL itself (hashed lightly) as the document ID so
    // re-subscribing the same browser overwrites rather than duplicates.
    const docId = Buffer.from(subscription.endpoint).toString('base64').slice(0, 400);
    const path = 'pushSubscriptions/' + docId;

    const existing = await firestoreGet(path);

    await firestoreSet(path, {
      subscription: subscription,
      subscribedAt: existing ? existing.subscribedAt : Date.now(),
      metric: metric,
      threshold: threshold,
      // Reset the baseline whenever the preference changes, so the very
      // next price becomes their new "since when did it move" starting point.
      lastNotifiedPrice: null,
      lastNotifiedAt: null,
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to save subscription: ' + err.message });
  }
};
