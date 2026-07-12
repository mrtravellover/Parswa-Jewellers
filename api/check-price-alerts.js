// /api/check-price-alerts.js
// Vercel serverless function — public (no login needed), triggered
// periodically by the frontend while anyone has the site open (there's no
// always-on background server in this setup, so this is the realistic
// ceiling for a web app without a paid dedicated always-on service).
//
// For each push subscriber, compares the current price of whichever metric
// they chose against the price the last time THEY were notified, and sends
// a personal alert only once their own threshold is crossed.
//
// Uses raw REST for Firestore (see _firestoreRest.js) — the Admin SDK's
// Firestore client was hanging indefinitely on this deployment.
//
// CACHING: this endpoint is triggered independently by every visitor's
// browser, so with even a handful of people on the site at once, uncached
// reads here multiply fast — and were the single biggest contributor to
// exceeding the Firestore free-tier daily quota. Important detail: listing
// N documents in a collection counts as N reads against quota, not 1 — so
// re-fetching the full subscriber list is the expensive part specifically,
// scaling with subscriber count, not visitor count. Cached for 5 minutes
// (not just a few seconds) specifically to keep this comfortably inside the
// free tier even with real usage — the goal here is genuinely staying free,
// not just "using less." A 5-minute-old alert baseline is a fine tradeoff
// for a feature that was never meant to be millisecond-precise anyway.
//
// Known limitation: if a metric's active source is Hajar Bajar, this can't
// check it — Hajar Bajar's live prices only exist in the visitor's own
// browser (via WebSocket), not anywhere accessible server-side.

const webpush = require('web-push');
const { firestoreGet, firestoreSet, firestoreDelete, firestoreListCollection } = require('./_firestoreRest');

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

const CACHE_TTL_MS = 300000; // 5 minutes — see reasoning below
let cache = {
  settings: null, settingsExpiry: 0,
  subscriptions: null, subscriptionsExpiry: 0,
};

async function getCachedSettings() {
  const now = Date.now();
  if (cache.settings && cache.settingsExpiry > now) return cache.settings;
  const settings = (await firestoreGet('ownerConfig/settings')) || {};
  cache.settings = settings;
  cache.settingsExpiry = now + CACHE_TTL_MS;
  return settings;
}

async function getCachedSubscriptions() {
  const now = Date.now();
  if (cache.subscriptions && cache.subscriptionsExpiry > now) return cache.subscriptions;
  const subs = await firestoreListCollection('pushSubscriptions');
  cache.subscriptions = subs;
  cache.subscriptionsExpiry = now + CACHE_TTL_MS;
  return subs;
}

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

    const settings = await getCachedSettings();
    const mcxSource = settings.mcxSource || 'ratnam';
    const goldHajarSource = settings.goldHajarSource || 'hajarbajar';
    const silverChorsaSource = settings.silverChorsaSource || 'hajarbajar';
    const goldSellPremium = settings.goldSellPremium || 0;
    const silverSellPremium = settings.silverSellPremium || 0;

    // Fetch data from whichever sources are actually needed, once each —
    // not once per subscriber. (These hit the already-cached live-market
    // endpoints, not Firestore directly, so no additional quota cost here.)
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
    const subscriptions = await getCachedSubscriptions();
    let checked = 0, notified = 0, removed = 0;

    await Promise.all(subscriptions.map(async ({ id, data }) => {
      const metric = data.metric || 'mcxGold';
      const threshold = data.threshold || 500;
      const current = currentValues[metric];
      if (current === undefined || current === null) return; // can't check this metric right now
      checked++;

      const docPath = 'pushSubscriptions/' + id;
      const lastPrice = data.lastNotifiedPrice;
      if (lastPrice === null || lastPrice === undefined) {
        // First time seeing this subscriber (or preference just changed) —
        // set the baseline, don't fire on the very first check.
        await firestoreSet(docPath, { lastNotifiedPrice: current, lastNotifiedAt: Date.now() });
        return;
      }

      const change = current - lastPrice;
      if (Math.abs(change) < threshold) return;

      const direction = change > 0 ? 'up' : 'down';
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
        await firestoreSet(docPath, { lastNotifiedPrice: current, lastNotifiedAt: Date.now() });
      } catch (err) {
        if (err && (err.statusCode === 404 || err.statusCode === 410)) {
          await firestoreDelete(docPath).catch(() => {});
          removed++;
        }
      }
    }));

    return res.status(200).json({ ok: true, checked, notified, removed });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to check price alerts: ' + err.message });
  }
};
