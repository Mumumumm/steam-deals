const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const itad = require('./itad');
const { fetchAppDetails } = require('./appdetails');
const cache = require('./cache');

const PORT = process.env.PORT || 8787;
const ITAD_COUNTRY = 'KR';
const APPDETAILS_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ITAD_STORELOW_TTL_MS = 12 * 60 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
// Raised from 30: the client now polls every few seconds while enrichment
// fills in in the background, so one normal page load legitimately makes
// several dozen requests. This still only guards our own server's compute —
// polling doesn't add extra Steam/ITAD calls beyond what background
// enrichment already needs to do once.
const RATE_LIMIT_MAX = 150;
const BASE_LIST_FRESH_MS = 60 * 1000;

const CONFIG_PATH = path.join(__dirname, 'config.json');

// Env vars (used on hosted deploys like Render) take priority over the local
// config.json file (used for local dev). Only the local-file path generates
// and persists a new access code — a hosted deploy must set SITE_ACCESS_CODE
// explicitly, otherwise the code would change every time the instance restarts.
function loadConfig() {
  let fileConfig;
  try {
    fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    fileConfig = {};
  }

  const config = {
    itadApiKey: process.env.ITAD_API_KEY || fileConfig.itadApiKey || '',
    siteAccessCode: process.env.SITE_ACCESS_CODE || fileConfig.siteAccessCode || ''
  };

  if (!process.env.SITE_ACCESS_CODE && !fileConfig.siteAccessCode) {
    config.siteAccessCode = crypto.randomBytes(9).toString('base64url');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...fileConfig, siteAccessCode: config.siteAccessCode }, null, 2));
    console.log(`Generated a new site access code: ${config.siteAccessCode}`);
    console.log(`Share this link with friends: http://localhost:${PORT}/?code=${config.siteAccessCode}`);
  }

  return config;
}

const requestCounts = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const timestamps = (requestCounts.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  timestamps.push(now);
  requestCounts.set(ip, timestamps);
  return timestamps.length > RATE_LIMIT_MAX;
}

// Steam community tag ids, verified against its own tag reference
// (store.steampowered.com/tagdata/populartags/koreana and /english) and by
// live search queries — never guessed. The first 12 are the same categories
// appdetails calls "genres"; the rest are tags with no official-genre
// equivalent (Horror, Roguelike, ...). Both use the same tags= search param
// on Steam's end, so one dropdown and one query path covers all of them.
const GENRE_TAGS = [
  { id: 19, label: '액션' },
  { id: 21, label: '어드벤처' },
  { id: 122, label: 'RPG' },
  { id: 9, label: '전략' },
  { id: 597, label: '캐주얼' },
  { id: 599, label: '시뮬레이션' },
  { id: 701, label: '스포츠' },
  { id: 699, label: '레이싱' },
  { id: 492, label: '인디' },
  { id: 113, label: '무료 플레이' },
  { id: 493, label: '앞서 해보기' },
  { id: 128, label: '대규모 멀티플레이어' },
  { id: 1667, label: '공포' },
  { id: 1716, label: '로그라이크' },
  { id: 1695, label: '오픈 월드' },
  { id: 1685, label: '협동' },
  { id: 1628, label: '메트로배니아' },
  { id: 29482, label: '소울라이크' },
  { id: 3799, label: '비주얼 노벨' },
  { id: 1659, label: '좀비' }
];
const GENRE_TAG_IDS = new Set(GENRE_TAGS.map((t) => t.id));

function keyFor(tagId) {
  return tagId ? String(tagId) : 'deals';
}

const inFlightByKey = {};

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

function fetchSteamHtml(count, start, queryParams) {
  const url = `https://store.steampowered.com/search/results/?query&start=${start}&count=${count}&${queryParams}&infinite=1&cc=kr&l=korean`;
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
      }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

function parseResults(html, { requireDiscount = true, requireTagId = null } = {}) {
  const blocks = html.split('<a href="https://store.steampowered.com/app/').slice(1);
  const items = [];
  for (const block of blocks) {
    const appidMatch = block.match(/^(\d+)/);
    const nameMatch = block.match(/<span class="title">([^<]*)<\/span>/);
    const imgMatch = block.match(/<div class="search_capsule"><img src="([^"]+)"/);
    const discountMatch = block.match(/data-discount="(\d+)"/);
    const origMatch = block.match(/<div class="discount_original_price">([^<]+)<\/div>/);
    const finalMatch = block.match(/<div class="discount_final_price">([^<]+)<\/div>/);
    const releasedMatch = block.match(/<div class="search_released responsive_secondrow">\s*([^<]*?)\s*<\/div>/);
    const reviewMatch = block.match(/<span class="search_review_summary ([^"]*)"[^>]*data-tooltip-html="([^"]*)"/);
    const tagIdsMatch = block.match(/data-ds-tagids="(\[[^\]]*\])"/);

    if (!appidMatch || !nameMatch || !finalMatch) continue;

    const discount = discountMatch ? parseInt(discountMatch[1], 10) : 0;
    if (requireDiscount && (!origMatch || discount <= 0)) continue;

    // Steam's tags= search matches ANY of a game's tags, including ones
    // buried far down its full tag list (verified live: a tags=19 "액션"
    // query surfaced PUBG, whose own top-7 shown tags don't even include
    // 19). Restricting to a game's own top-shown tags keeps a filtered list
    // to games where that's actually a defining trait, not an incidental one.
    if (requireTagId !== null) {
      let tagIds = [];
      try {
        tagIds = tagIdsMatch ? JSON.parse(tagIdsMatch[1]) : [];
      } catch (e) {
        tagIds = [];
      }
      if (!tagIds.slice(0, 7).includes(requireTagId)) continue;
    }

    items.push({
      appid: appidMatch[1],
      name: decodeEntities(nameMatch[1]),
      image: imgMatch ? imgMatch[1] : '',
      discount,
      // Steam omits the "original price" markup entirely when an item isn't
      // discounted, since original and final price are the same.
      originalPrice: origMatch ? decodeEntities(origMatch[1]) : decodeEntities(finalMatch[1]),
      finalPrice: decodeEntities(finalMatch[1]),
      released: releasedMatch ? decodeEntities(releasedMatch[1]) : '',
      reviewClass: reviewMatch ? reviewMatch[1].trim() : '',
      reviewText: reviewMatch ? decodeEntities(reviewMatch[2].split('&lt;br&gt;')[0]) : '',
      url: `https://store.steampowered.com/app/${appidMatch[1]}/`
    });
  }
  return items;
}

// Each enrichment source is split into a synchronous "apply whatever's
// already cached" half (fast, used on every request) and an async "go fetch
// what's missing" half (used only by the background job below). This is
// what lets the HTTP response return immediately even when some items have
// never been seen before or their ITAD data has gone stale.

function applyAppDetailsFromCache(items) {
  const appdetailsCache = cache.loadJson('appdetails-cache.json', {});
  const now = Date.now();
  const pending = [];
  for (const item of items) {
    const d = appdetailsCache[item.appid];
    // d.crossPlatform is undefined for entries cached before that field was
    // added — treat those as stale too so they refetch instead of showing a
    // blank crossPlatform chip for up to 30 days.
    const fresh = d && now - d.cachedAt <= APPDETAILS_TTL_MS && d.crossPlatform !== undefined;
    item.genres = (d && d.genres) || [];
    item.shortDescription = (d && d.shortDescription) || '';
    item.multiplayer = !!(d && d.multiplayer);
    item.singleplayer = !!(d && d.singleplayer);
    item.coop = !!(d && d.coop);
    item.pvp = !!(d && d.pvp);
    item.onlineMulti = !!(d && d.onlineMulti);
    item.localMulti = !!(d && d.localMulti);
    item.crossPlatform = !!(d && d.crossPlatform);
    item.metacritic = (d && d.metacritic) || null;
    if (!fresh) pending.push(item);
  }
  return pending;
}

async function fetchMissingAppDetails(pendingItems) {
  if (!pendingItems.length) return;
  const appdetailsCache = cache.loadJson('appdetails-cache.json', {});
  const now = Date.now();

  await mapWithConcurrency(pendingItems, 5, async (item) => {
    let details = await fetchAppDetails(item.appid);
    if (!details) {
      await new Promise((r) => setTimeout(r, 400));
      details = await fetchAppDetails(item.appid);
    }
    // Only persist successful lookups; a failed/rate-limited fetch is retried
    // on the next cycle instead of being baked in as "no data" for 30 days.
    if (details) appdetailsCache[item.appid] = { ...details, cachedAt: now };
  });

  cache.saveJson('appdetails-cache.json', appdetailsCache);
}

function applyItadFromCache(items) {
  const itadCache = cache.loadJson('itad-cache.json', {});
  const now = Date.now();
  const pending = [];
  for (const item of items) {
    const e = itadCache[item.appid];
    item.allTimeLowCut = e && e.storeLow ? e.storeLow.cut : null;

    if (!e) {
      pending.push(item); // never looked up
      continue;
    }
    if (!e.itadId) {
      // Confirmed "not on ITAD" — nothing more to fetch for it, so this
      // only needs an occasional recheck (ITAD's catalog does grow), not
      // a retry on every single background cycle.
      if (now - (e.lookupCachedAt || 0) > APPDETAILS_TTL_MS) pending.push(item);
      continue;
    }
    if (now - (e.storeLowCachedAt || 0) > ITAD_STORELOW_TTL_MS) pending.push(item);
  }
  return pending;
}

async function fetchMissingItad(pendingItems, apiKey) {
  if (!apiKey || !pendingItems.length) return;
  const itadCache = cache.loadJson('itad-cache.json', {});
  const now = Date.now();

  await mapWithConcurrency(pendingItems, 3, async (item) => {
    const entry = itadCache[item.appid];
    // Already have a valid id, or a "not found" result that's still within
    // its recheck window — skip re-querying ITAD for it.
    if (entry && (entry.itadId || now - (entry.lookupCachedAt || 0) <= APPDETAILS_TTL_MS)) return;
    try {
      const itadId = await itad.lookupGameId(item.appid, apiKey);
      itadCache[item.appid] = { itadId, storeLow: null, storeLowCachedAt: 0, lookupCachedAt: now };
    } catch (e) {
      // leave uncached on failure (network error / rate limit) so it retries next cycle
    }
  });

  const idsNeedingLow = pendingItems
    .map((item) => [item.appid, itadCache[item.appid]])
    .filter(([, e]) => e && e.itadId);

  if (idsNeedingLow.length) {
    try {
      const lows = await itad.getStoreLows(idsNeedingLow.map(([, e]) => e.itadId), apiKey, ITAD_COUNTRY);
      for (const [appid, e] of idsNeedingLow) {
        e.storeLow = lows[e.itadId] || null;
        e.storeLowCachedAt = now;
      }
    } catch (e) {
      // leave stale/cached values as-is on failure
    }
  }

  cache.saveJson('itad-cache.json', itadCache);
}

function applyHistoryFromCache(items) {
  const history = cache.loadJson('history.json', {});
  for (const item of items) {
    const prev = history[item.appid];
    item.previousDiscount = prev ? prev.discount : null;
    item.discountDelta = prev ? item.discount - prev.discount : null;
  }
}

function writeHistory(items) {
  const history = cache.loadJson('history.json', {});
  const now = new Date().toISOString();
  for (const item of items) {
    // Genre/theme browsing (unlike the deals list) includes games that
    // aren't currently on sale. Recording a 0% snapshot for one would give
    // a real future sale a bogus "last discount" to compare against, so
    // only genuine sale observations count as history here.
    if (item.discount <= 0) continue;
    history[item.appid] = { discount: item.discount, finalPrice: item.finalPrice, fetchedAt: now };
  }
  cache.saveJson('history.json', history);
}

function applyRecordFromCache(items) {
  const record = cache.loadJson('record-history.json', {});
  for (const item of items) {
    const prevCut = record[item.appid];
    item.isNewAllTimeLow =
      item.allTimeLowCut !== null &&
      item.allTimeLowCut !== undefined &&
      prevCut !== null &&
      prevCut !== undefined &&
      item.allTimeLowCut > prevCut;
  }
}

function writeRecordTracking(items) {
  const record = cache.loadJson('record-history.json', {});
  for (const item of items) record[item.appid] = item.allTimeLowCut;
  cache.saveJson('record-history.json', record);
}

// No tag (the default homepage view) means "current deals": on-sale items
// only. A tag means "browse this genre/theme": Steam's full catalog for that
// tag, sale or not — a discount is then just one more fact shown per game,
// not a requirement to appear at all.
async function fetchBaseList(count, tagId) {
  const queryParams = tagId ? `tags=${tagId}` : 'specials=1';
  const requireDiscount = !tagId;
  const MAX_RAW_PAGES = 10;
  let all = [];
  let start = 0;
  for (let page = 0; page < MAX_RAW_PAGES && all.length < count; page++) {
    let data;
    try {
      data = await fetchSteamHtml(100, start, queryParams);
    } catch (e) {
      await new Promise((r) => setTimeout(r, 800));
      data = await fetchSteamHtml(100, start, queryParams);
    }
    if (!data.results_html || !data.results_html.includes('search_result_row')) break;
    all = all.concat(parseResults(data.results_html, { requireDiscount, requireTagId: tagId }));
    start += 100;
  }
  all = all.slice(0, count);

  if (all.length === 0) {
    console.warn(`[${new Date().toISOString()}] WARNING: /api/deals (tag=${tagId || 'none'}) returned 0 items — Steam markup may have changed, or the request may be blocked/rate-limited.`);
  }
  return all;
}

// Reusing the same live scrape across requests within this window is what
// makes rapid enrichment polling cheap — a poll doesn't need to hit Steam
// again, just re-read our own on-disk caches. Keyed per tag since each is a
// genuinely different Steam query, not just a client-side view of one list.
const baseListCache = {};

async function getBaseList(count, tagId) {
  const key = keyFor(tagId);
  const cached = baseListCache[key];
  if (cached && Date.now() - cached.fetchedAt < BASE_LIST_FRESH_MS && cached.items.length >= count) {
    return cached.items.slice(0, count).map((i) => ({ ...i }));
  }
  if (!inFlightByKey[key]) {
    inFlightByKey[key] = fetchBaseList(count, tagId).finally(() => {
      inFlightByKey[key] = null;
    });
  }
  const items = await inFlightByKey[key];
  baseListCache[key] = { items, fetchedAt: Date.now() };
  return items.map((i) => ({ ...i }));
}

const backgroundJobByKey = {};

// Fire-and-forget: fetches whatever appdetails/ITAD data was missing, then
// persists history/record-tracking once that's done. Never awaited by the
// request handler — the next poll just re-reads the caches this updates.
function runBackgroundEnrichment(key, items, pendingDetails, pendingItad, apiKey) {
  if (backgroundJobByKey[key]) return;
  backgroundJobByKey[key] = Promise.resolve()
    .then(async () => {
      await fetchMissingAppDetails(pendingDetails);
      await fetchMissingItad(pendingItad, apiKey);
      applyAppDetailsFromCache(items);
      applyItadFromCache(items);
      writeHistory(items);
      writeRecordTracking(items);
    })
    .catch((e) => {
      console.warn(`[${new Date().toISOString()}] Background enrichment failed: ${e.message}`);
    })
    .finally(() => {
      backgroundJobByKey[key] = null;
    });
}

async function buildResponse(count, tagId) {
  const config = loadConfig();
  const items = await getBaseList(count, tagId);

  applyHistoryFromCache(items);
  const pendingDetails = applyAppDetailsFromCache(items);
  const pendingItad = applyItadFromCache(items);
  applyRecordFromCache(items);

  const pendingAppids = new Set([...pendingDetails, ...pendingItad].map((i) => i.appid));
  const enriched = pendingAppids.size === 0;
  if (!enriched) {
    runBackgroundEnrichment(keyFor(tagId), items, pendingDetails, pendingItad, config.itadApiKey);
  }

  return {
    fetchedAt: new Date().toISOString(),
    itadEnabled: !!config.itadApiKey,
    enriched,
    pendingCount: pendingAppids.size,
    items
  };
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://localhost:${PORT}`);
  const ip = req.socket.remoteAddress || 'unknown';

  if (reqUrl.pathname === '/api/genres') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ genres: GENRE_TAGS }));
    return;
  }

  if (reqUrl.pathname === '/api/deals') {
    const config = loadConfig();
    const code = req.headers['x-access-code'] || reqUrl.searchParams.get('code') || '';
    if (code !== config.siteAccessCode) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '접근 코드가 필요합니다' }));
      return;
    }
    if (isRateLimited(ip)) {
      res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '요청이 너무 잦습니다. 잠시 후 다시 시도해주세요.' }));
      return;
    }

    const rawTag = reqUrl.searchParams.get('tag');
    let tagId = null;
    if (rawTag) {
      const parsed = parseInt(rawTag, 10);
      if (!GENRE_TAG_IDS.has(parsed)) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '알 수 없는 장르/테마입니다' }));
        return;
      }
      tagId = parsed;
    }

    try {
      const count = Math.min(parseInt(reqUrl.searchParams.get('count') || '150', 10), 300);
      const payload = await buildResponse(count, tagId);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(payload));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  let filePath = reqUrl.pathname === '/' ? '/index.html' : reqUrl.pathname;
  filePath = path.join(__dirname, 'public', filePath);

  const ext = path.extname(filePath);
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': (types[ext] || 'text/plain') + '; charset=utf-8' });
    res.end(content);
  });
});

server.listen(PORT, () => {
  console.log(`Steam deals server running at http://localhost:${PORT}`);
});

// Safety net for the fire-and-forget background enrichment job: it already
// catches its own errors, but an uncaught rejection anywhere would otherwise
// crash the whole process on newer Node versions.
process.on('unhandledRejection', (err) => {
  console.warn(`[${new Date().toISOString()}] Unhandled rejection: ${err && err.message}`);
});
