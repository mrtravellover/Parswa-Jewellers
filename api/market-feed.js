// /api/market-feed.js
// Vercel serverless function — powers the "Complete Market Rates" toggle
// view, per the Live Market Rate Board spec (built for Shah Jewellers,
// reused here with the same provider chain).
//
// Rather than reimplementing the raw MCXLive parsing/rollover logic from
// scratch (which would mean guessing at the raw provider's field names —
// data.liveapi.uk gates access by Origin/Referer, so its true raw response
// was never actually seen here), this proxies the already-deployed, already
// battle-tested Shah Jewellers feed endpoint, which implements the exact
// same spec and returns the exact contract this project needs. Same owner
// controls both projects, so this isn't a risky external dependency the
// way a random third-party API would be.
//
// A second layer of resilience is added on top regardless: retries, a
// timeout, and an in-memory last-known-good cache — so a momentary hiccup
// on the upstream proxy still doesn't take this down.

const UPSTREAM_URL = 'https://feed-nine-xi.vercel.app/api/feed.js';
const TIMEOUT_MS = 5000;
const MAX_RETRIES = 3;

let memCache = { payload: null };

async function fetchWithRetry() {
  let lastError;
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      const resp = await fetch(UPSTREAM_URL, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!resp.ok) throw new Error('Upstream returned HTTP ' + resp.status);
      const json = await resp.json();
      if (!json || json.success !== true || !Array.isArray(json.contracts)) {
        throw new Error('Upstream response missing expected shape');
      }
      return json;
    } catch (err) {
      lastError = err;
      console.error('Market feed attempt ' + (i + 1) + '/' + MAX_RETRIES + ' failed:', err.message);
      if (i < MAX_RETRIES - 1) {
        await new Promise((resolve) => setTimeout(resolve, 300 * (i + 1)));
      }
    }
  }
  throw lastError;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 'no-store');

  try {
    const json = await fetchWithRetry();
    memCache.payload = json;
    return res.status(200).json(json);
  } catch (err) {
    if (memCache.payload) {
      return res.status(200).json(Object.assign({}, memCache.payload, { stale: true }));
    }
    return res.status(502).json({ success: false, error: 'Market feed unavailable and no cache found yet' });
  }
};
