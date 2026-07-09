// /api/live-market.js
// Vercel serverless function.
// Polls Shri Shyam Bullion's HTTP feed (called fresh on every request — see note in chat
// about why this isn't a standing background daemon on the free tier), parses the
// tab-separated response, tracks instrument rollovers by NAME (not ID), caches the last
// good snapshot in Firestore for fallback, and returns clean JSON for the 5 required
// instruments only.

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

// Canonical output keys, matched by instrument NAME — never by ID.
// This is the whole point: IDs roll over on contract expiry, names generally don't.
const REQUIRED = {
  'GOLD FUTURE': 'mcxGold',
  'SILVER FUTURE': 'mcxSilver',
  'GOLD($)': 'comexGold',
  'SILVER ($)': 'comexSilver',
  INR: 'usdInr',
};

function normalizeName(name) {
  return name.trim().toUpperCase().replace(/\s+/g, ' ');
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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const mappingRef = db.collection('liveMarket').doc('instrumentMapping');
  const cacheRef = db.collection('liveMarket').doc('cache');
  const unknownRef = db.collection('liveMarket').doc('unknownInstruments');
  const rolloverLogRef = db.collection('liveMarket').collection('rolloverLog');

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
    // Upstream is down or gave garbage — serve the last known-good snapshot instead
    // of breaking the site, and say clearly that it's stale.
    try {
      const cacheSnap = await cacheRef.get();
      if (cacheSnap.exists && cacheSnap.data().payload) {
        const staleOutput = {};
        for (const key of Object.values(REQUIRED)) {
          if (cacheSnap.data().payload[key]) {
            staleOutput[key] = Object.assign({}, cacheSnap.data().payload[key], { status: 'STALE' });
          }
        }
        return res.status(200).json(Object.assign({}, staleOutput, { source: 'cache', fetchedAt: Date.now() }));
      }
    } catch (e) {
      // fall through to hard error below
    }
    return res.status(502).json({ error: 'Upstream unavailable and no cache found yet' });
  }

  // Load existing name -> id mapping and the unknown-instrument log
  const mappingSnap = await mappingRef.get();
  const mapping = mappingSnap.exists ? mappingSnap.data() : {};

  const unknownSnap = await unknownRef.get();
  const unknownList = unknownSnap.exists ? unknownSnap.data().items || {} : {};

  const rolloverEvents = [];
  const now = Date.now();
  const byName = {};

  for (const row of rows) {
    byName[row.name] = row;
    const known = mapping[row.name];

    if (known) {
      if (String(known.id) !== String(row.id)) {
        // Same instrument name, different ID => contract rolled over
        rolloverEvents.push({
          name: row.rawName,
          oldId: known.id,
          newId: row.id,
          detectedAt: now,
        });
        mapping[row.name] = { id: row.id, lastSeen: now, rawName: row.rawName, status: 'ACTIVE' };
      } else {
        mapping[row.name].lastSeen = now;
        mapping[row.name].status = 'ACTIVE';
      }
    } else if (REQUIRED[row.name]) {
      // First time seeing one of our 5 required instruments — map it directly
      mapping[row.name] = { id: row.id, lastSeen: now, rawName: row.rawName, status: 'ACTIVE' };
    } else {
      // Genuinely new/unrecognized instrument — log for admin review, never shown publicly
      unknownList[row.name] = {
        id: row.id,
        rawName: row.rawName,
        current: row.current,
        high: row.high,
        low: row.low,
        firstSeen: unknownList[row.name] ? unknownList[row.name].firstSeen : now,
        lastSeen: now,
      };
    }
  }

  await mappingRef.set(mapping, { merge: true });
  if (Object.keys(unknownList).length) {
    await unknownRef.set({ items: unknownList }, { merge: true });
  }
  for (const ev of rolloverEvents) {
    await rolloverLogRef.add(ev);
  }

  // Build clean output, computing change/direction against the last cached values
  const cacheSnap = await cacheRef.get();
  const prevPayload = (cacheSnap.exists && cacheSnap.data().payload) || {};

  const output = {};
  for (const [name, key] of Object.entries(REQUIRED)) {
    const row = byName[name];
    if (!row) {
      // Missing from this particular poll — keep showing the last value, marked MISSING
      if (prevPayload[key]) {
        output[key] = Object.assign({}, prevPayload[key], { status: 'MISSING' });
      }
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

  await cacheRef.set({ payload: output, updatedAt: now }, { merge: true });

  return res.status(200).json(
    Object.assign({}, output, {
      rolloverEvents: rolloverEvents,
      fetchedAt: now,
    })
  );
};
