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
//
// Uses raw REST for Firestore (see _firestoreRest.js) instead of the Admin
// SDK's Firestore client — every write via the SDK client was hanging
// indefinitely on this deployment, even on fresh cold starts.

const { firestoreGet, firestoreSet, firestoreAdd } = require('./_firestoreRest');

const UPSTREAM_URL =
  'http://bcast.shrishyambullion.com:7767/VOTSBroadcastStreaming/Services/xml/GetLiveRateByTemplateID/shrishyam';

// Canonical output keys, matched by instrument NAME with ALL internal
// whitespace/dots stripped — so formatting quirks in exactly how the feed
// writes a name don't break matching. Owner-linked instruments (via the
// Instrument Manager panel) merge on top of this at request time.
const REQUIRED = {
  'GOLDFUTURE': 'mcxGold',
  'SILVERFUTURE': 'mcxSilver',
  'GOLD($)': 'comexGold',
  'SILVER($)': 'comexSilver',
  'INR': 'usdInr',
};

function normalizeName(name) {
  // Strip whitespace AND periods/ellipsis characters — the live feed sends
  // "GOLD($) .." (with trailing dots) rather than the clean "GOLD($)" from
  // the sample data, so exact-matching on raw spacing alone isn't enough.
  return name.trim().toUpperCase().replace(/[.\u2026\s]+/g, '');
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
let memCache = { payload: null, mapping: null, unknown: null, customMapping: null };

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  let rows = [];
  let fetchOk = false;
  let rawText = '';

  try {
    const upstream = await fetch(UPSTREAM_URL, { method: 'GET' });
    rawText = await upstream.text();
    rows = parseRows(rawText);
    fetchOk = rows.length > 0;
  } catch (err) {
    fetchOk = false;
  }

  // Owner-linked instruments (via the Instrument Manager UI) merge on top of
  // the built-in REQUIRED names — this is what lets the owner assign a new
  // or renamed instrument to a card without any code change.
  if (!memCache.customMapping) {
    memCache.customMapping = (await firestoreGet('liveMarket/shrishyam_customMapping')) || {};
  }
  const effectiveRequired = Object.assign({}, REQUIRED, memCache.customMapping);

  // Debug mode — visit /api/live-market?debug=1 to see exactly what the
  // upstream feed sends, character-for-character, including every
  // instrument name whether or not it matched one of our required ones.
  if (req.query && req.query.debug) {
    return res.status(200).json({
      fetchOk: fetchOk,
      rawTextSample: rawText.slice(0, 3000),
      parsedRows: rows.map((r) => ({
        id: r.id, rawName: r.rawName, normalizedName: r.name, current: r.current,
      })),
      requiredKeys: Object.keys(effectiveRequired),
    });
  }

  if (!fetchOk) {
    if (memCache.payload) {
      const staleOutput = {};
      for (const key of Object.values(effectiveRequired)) {
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
    memCache.mapping = (await firestoreGet('liveMarket/shrishyam_instrumentMapping')) || {};
  }
  if (!memCache.unknown) {
    const unknownDoc = await firestoreGet('liveMarket/shrishyam_unknownInstruments');
    memCache.unknown = (unknownDoc && unknownDoc.items) || {};
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
        rolloverEvents.push({ source: 'shrishyam', name: row.rawName, oldId: known.id, newId: row.id, detectedAt: now });
        mapping[row.name] = { id: row.id, lastSeen: now, rawName: row.rawName, status: 'ACTIVE' };
        mappingChanged = true;
      } else {
        mapping[row.name].lastSeen = now;
      }
    } else if (effectiveRequired[row.name]) {
      mapping[row.name] = { id: row.id, lastSeen: now, rawName: row.rawName, status: 'ACTIVE' };
      mappingChanged = true;
      // This name is now known (built-in or just linked by the owner) — make
      // sure it's not still sitting in the unknown list from before.
      if (unknownList[row.name]) {
        delete unknownList[row.name];
        unknownChanged = true;
      }
    } else if (!unknownList[row.name]) {
      unknownList[row.name] = {
        id: row.id, rawName: row.rawName, current: row.current, high: row.high, low: row.low,
        firstSeen: now, lastSeen: now,
      };
      unknownChanged = true;
    } else {
      // Already logged as unknown — keep its live price fresh so the owner
      // can identify it by current value in the Instrument Manager panel.
      unknownList[row.name].current = row.current;
      unknownList[row.name].high = row.high;
      unknownList[row.name].low = row.low;
      unknownList[row.name].lastSeen = now;
      unknownChanged = true;
    }
  }

  // Only hit Firestore for writes when something actually changed —
  // this is the part that used to run every single poll regardless.
  // Fire-and-forget (not awaited) — a slow/failed write here shouldn't
  // delay the actual rate response going back to the browser.
  if (mappingChanged) {
    firestoreSet('liveMarket/shrishyam_instrumentMapping', mapping).catch(() => {});
  }
  if (unknownChanged) {
    firestoreSet('liveMarket/shrishyam_unknownInstruments', { items: unknownList }).catch(() => {});
  }
  for (const ev of rolloverEvents) {
    firestoreAdd('liveMarket/meta/rolloverLog', ev).catch(() => {});
  }

  const prevPayload = memCache.payload || {};
  const output = {};
  for (const [name, key] of Object.entries(effectiveRequired)) {
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
      bidRef: row.bidRef,
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
