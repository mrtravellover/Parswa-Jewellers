// /api/live-market.js
// Vercel serverless function.
// Polls Shri Shyam Bullion's HTTP feed fresh on every request, parses the
// tab-separated response, tracks instrument rollovers by NAME (not ID), and
// returns clean JSON for the 5 required instruments only.
//
// Speed note: change/direction/"last known value on failure" are handled
// using an in-memory cache local to this warm function instance (fast, no
// network round trip) rather than Firestore on every single request — that
// was adding two extra network calls to every poll for no real benefit.
// Firestore is still used, but only for things that are genuinely rare:
// the name->id mapping and the unknown-instrument log, and only written
// when something actually changes.

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

const UPSTREAM_URL =
  'http://bcast.shrishyambullion.com:7767/VOTSBroadcastStreaming/Services/xml/GetLiveRateByTemplateID/shrishyam';

// Canonical output keys, matched by instrument NAME with ALL internal
// whitespace stripped — so "GOLD($)", "GOLD ($)", "GOLD  ($)" etc. all match
// the same way regardless of exactly how the upstream feed formats it.
const REQUIRED = {
  'GOLDFUTURE': 'mcxGold',
  'SILVERFUTURE': 'mcxSilver',
  'GOLD($)': 'comexGold',
  'SILVER($)': 'comexSilver',
  'INR': 'usdInr',
};

function normalizeName(name) {
  return name.trim().toUpperCase().replace(/\s+/g, '');
}

function parseRows(raw) {
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  const rows = [];
  for (const line of lines) {
    const cols = line.split('\t').map((c) => c.trim());
    if (cols.length < 6) continue;
    const [id, name, current, bidRef, high, low] = cols;
    const currentNum = parseFloat(current);
    if (isNaN(currentNum)) continue;
    rows.push({
      id: id,
      name: normalizeName(name),
      rawName: name,
      current: currentNum,
      bidRef: parseFloat(bidRef),
      high: parseFloat(high),
      low: parseFloat(low),
    });
  }
  return rows;
}

// Module-level (per warm instance) memory — survives between requests as
// long as Vercel keeps this function instance warm, which is the common
// case under regular polling traffic. Not guaranteed across cold starts,
// which is fine: worst case we just lose the "previous value" for one poll.
let memCache = { payload: null, mapping: null, unknown: null };

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  let rows = [];
  let fetchOk = false;

  try {
    const upstream = await fetch(UPSTREAM_URL, { method: 'GET' });
    const text = await upstream.text();
    rows = parseRows(text);
    fetchOk = rows.length > 0;
  } catch (err) {
    fetchOk = false;
  }

  if (!fetchOk) {
    if (memCache.payload) {
      const staleOutput = {};
      for (const key of Object.values(REQUIRED)) {
        if (memCache.payload[key]) {
          staleOutput[key] = Object.assign({}, memCache.payload[key], { status: 'STALE' });
        }
      }
      return res.status(200).json(Object.assign({}, staleOutput, { source: 'memcache', fetchedAt: Date.now() }));
    }
    return res.status(502).json({ error: 'Upstream unavailable and no cache found yet' });
  }

  // Load mapping/unknown from memory if we have it, otherwise from Firestore (cold start)
  if (!memCache.mapping) {
    const mappingSnap = await db.collection('liveMarket').doc('instrumentMapping').get();
    memCache.mapping = mappingSnap.exists ? mappingSnap.data() : {};
  }
  if (!memCache.unknown) {
    const unknownSnap = await db.collection('liveMarket').doc('unknownInstruments').get();
    memCache.unknown = unknownSnap.exists ? unknownSnap.data().items || {} : {};
  }

  const mapping = memCache.mapping;
  const unknownList = memCache.unknown;
  const rolloverEvents = [];
  const now = Date.now();
  const byName = {};
  let mappingChanged = false;
  let unknownChanged = false;

  for (const row of rows) {
    byName[row.name] = row;
    const known = mapping[row.name];

    if (known) {
      if (String(known.id) !== String(row.id)) {
        rolloverEvents.push({ name: row.rawName, oldId: known.id, newId: row.id, detectedAt: now });
        mapping[row.name] = { id: row.id, lastSeen: now, rawName: row.rawName, status: 'ACTIVE' };
        mappingChanged = true;
      } else {
        mapping[row.name].lastSeen = now;
      }
    } else if (REQUIRED[row.name]) {
      mapping[row.name] = { id: row.id, lastSeen: now, rawName: row.rawName, status: 'ACTIVE' };
      mappingChanged = true;
    } else if (!unknownList[row.name]) {
      unknownList[row.name] = {
        id: row.id, rawName: row.rawName, current: row.current, high: row.high, low: row.low,
        firstSeen: now, lastSeen: now,
      };
      unknownChanged = true;
    }
  }

  // Only hit Firestore for writes when something actually changed —
  // this is the part that used to run every single poll regardless.
  if (mappingChanged) {
    db.collection('liveMarket').doc('instrumentMapping').set(mapping, { merge: true }).catch(() => {});
  }
  if (unknownChanged) {
    db.collection('liveMarket').doc('unknownInstruments').set({ items: unknownList }, { merge: true }).catch(() => {});
  }
  for (const ev of rolloverEvents) {
    db.collection('liveMarket').doc('meta').collection('rolloverLog').add(ev).catch(() => {});
  }

  const prevPayload = memCache.payload || {};
  const output = {};
  for (const [name, key] of Object.entries(REQUIRED)) {
    const row = byName[name];
    if (!row) {
      if (prevPayload[key]) output[key] = Object.assign({}, prevPayload[key], { status: 'MISSING' });
      continue;
    }
    const prev = prevPayload[key] ? prevPayload[key].current : null;
    const change = prev !== null && !isNaN(prev) ? row.current - prev : 0;
    let direction = 'UNCHANGED';
    if (change > 0) direction = 'UP';
    else if (change < 0) direction = 'DOWN';

    output[key] = {
      instrumentId: row.id,
      instrumentName: row.rawName,
      current: row.current,
      high: row.high,
      low: row.low,
      previous: prev !== null ? prev : row.current,
      change: Number(change.toFixed(3)),
      changePercent: prev ? Number(((change / prev) * 100).toFixed(3)) : 0,
      direction: direction,
      updatedAt: now,
      status: 'LIVE',
    };
  }

  memCache.payload = output;

  return res.status(200).json(Object.assign({}, output, { rolloverEvents: rolloverEvents, fetchedAt: now }));
};
