// /api/check-price-alerts.js
// Vercel serverless function — public (no login needed), triggered
// periodically by the frontend while anyone has the site open (there's no
// always-on background server in this setup, so this is the realistic
// ceiling for a web app without a paid dedicated always-on service — see
// the chat for the full explanation of why true 24/7 background checking
// isn't possible here).
//
// For each push subscriber, compares the current price of whichever metric
// they chose against the price the last time THEY were notified, and sends
// a personal alert only once their own threshold is crossed.
//
// Known limitation: if a metric's active source is Hajar Bajar, this can't
// check it — Hajar Bajar's live prices only exist in the visitor's own
// browser (via WebSocket), not anywhere accessible server-side.

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

webpush.setVapidDetails(
  'mailto:owner@parshwajewellers.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

const METRIC_LABELS = {
  mcxGold: 'MCX Gold',
  mcxSilver: 'MCX Silver',
  goldHajar: 'Gold Hajar 24K',
  silverChorsa: 'Silver Chorsa',
};

async function fetchJson(url) {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    return await resp.json();
  } catch (e) {
    return null;
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  try {
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers.host;
    const baseUrl = protocol + '://' + host;

    // Figure out which source currently feeds each metric
    const settingsSnap = await db.collection('ownerConfig').doc('settings').get();
    const settings = settingsSnap.exists ? settingsSnap.data() : {};
    const mcxSource = settings.mcxSource || 'ratnam';
    const goldHajarSource = settings.goldHajarSource || 'hajarbajar';
    const silverChorsaSource = settings.silverChorsaSource || 'hajarbajar';
    const goldBuyPremium = settings.goldBuyPremium || 0;
    const goldSellPremium = settings.goldSellPremium || 0;
    const silverBuyPremium = settings.silverBuyPremium || 0;
    const silverSellPremium = settings.silverSellPremium || 0;

    // Fetch data from whichever sources are actually needed, once each —
    // not once per subscriber.
    const neededSources = new Set();
    if (mcxSource !== 'hajarbajar') neededSources.add(mcxSource);
    if (goldHajarSource !== 'hajarbajar' && goldHajarSource !== 'manual') neededSources.add(goldHajarSource);
    if (silverChorsaSource !== 'hajarbajar' && silverChorsaSource !== 'manual') neededSources.add(silverChorsaSource);

    const sourceData = {};
    await Promise.all(Array.from(neededSources).map(async (source) => {
      const path = source === 'ratnam' ? '/api/live-market' : '/api/live-market-' + source;
      sourceData[source] = await fetchJson(baseUrl + path);
    }));

    // Compute the current customer-facing value for each metric, the same
    // way the main site does (raw instrument price + the owner's premium).
    const currentValues = {};

    if (mcxSource !== 'hajarbajar' && sourceData[mcxSource]) {
      if (sourceData[mcxSource].mcxGold) currentValues.mcxGold = sourceData[mcxSource].mcxGold.current;
      if (sourceData[mcxSource].mcxSilver) currentValues.mcxSilver = sourceData[mcxSource].mcxSilver.current;
    }
    if (goldHajarSource !== 'hajarbajar' && goldHajarSource !== 'manual' && sourceData[goldHajarSource] && sourceData[goldHajarSource].goldHajar) {
      currentValues.goldHajar = sourceData[goldHajarSource].goldHajar.current - goldSellPremium;
    } else if (goldHajarSource === 'manual' && settings.manualGoldSell) {
      currentValues.goldHajar = settings.manualGoldSell;
    }
    if (silverChorsaSource !== 'hajarbajar' && silverChorsaSource !== 'manual' && sourceData[silverChorsaSource] && sourceData[silverChorsaSource].silverChorsa) {
      currentValues.silverChorsa = sourceData[silverChorsaSource].silverChorsa.current - silverSellPremium;
    } else if (silverChorsaSource === 'manual' && settings.manualSilverSell) {
      currentValues.silverChorsa = settings.manualSilverSell;
    }

    // Check every subscriber's personal threshold against their chosen metric
    const subsSnap = await db.collection('pushSubscriptions').get();
    let checked = 0, notified = 0, removed = 0;

    await Promise.all(subsSnap.docs.map(async (doc) => {
      const data = doc.data();
      const metric = data.metric || 'mcxGold';
      const threshold = data.threshold || 500;
      const current = currentValues[metric];
      if (current === undefined || current === null) return; // can't check this metric right now
      checked++;

      const lastPrice = data.lastNotifiedPrice;
      if (lastPrice === null || lastPrice === undefined) {
        // First time seeing this subscriber (or preference just changed) —
        // set the baseline, don't fire on the very first check.
        await doc.ref.set({ lastNotifiedPrice: current, lastNotifiedAt: Date.now() }, { merge: true });
        return;
      }

      const change = current - lastPrice;
      if (Math.abs(change) < threshold) return;

      const direction = change > 0 ? 'up' : 'down';
      const arrow = change > 0 ? '\u25b2' : '\u25bc';
      const label = METRIC_LABELS[metric] || metric;
      const payload = JSON.stringify({
        title: 'Parshwa Jewellers',
        body: label + ' moved ' + direction + ' by \u20b9' + Math.abs(Math.round(change)) + ' \u2014 now \u20b9' + Math.round(current),
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
      });

      try {
        await webpush.sendNotification(data.subscription, payload);
        notified++;
        await doc.ref.set({ lastNotifiedPrice: current, lastNotifiedAt: Date.now() }, { merge: true });
      } catch (err) {
        if (err && (err.statusCode === 404 || err.statusCode === 410)) {
          await doc.ref.delete().catch(() => {});
          removed++;
        }
      }
    }));

    return res.status(200).json({ ok: true, checked, notified, removed });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to check price alerts: ' + err.message });
  }
};
