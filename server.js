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
const RATE_LIMIT_MAX = 30;

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

const inFlightByMode = {};

const MODE_CONFIG = {
  deals: { queryParams: 'specials=1', requireDiscount: true, requireTagId: null },
  horror: { queryParams: 'tags=1667', requireDiscount: false, requireTagId: 1667 }
};

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

    // Steam's tag-based search matches ANY of a game's tags, including ones
    // buried far down its full tag list. Restricting to a game's own
    // top-shown tags (the ones in this same search result) keeps a themed
    // list (e.g. Horror) to games where that's actually a defining tag,
    // not an incidental one.
    if (requireTagId !== null) {
      let tagIds = [];
      try {
        tagIds = tagIdsMatch ? JSON.parse(tagIdsMatch[1]) : [];
      } catch (e) {
        tagIds = [];
      }
      if (!tagIds.includes(requireTagId)) continue;
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

async function enrichWithAppDetails(items) {
  const appdetailsCache = cache.loadJson('appdetails-cache.json', {});
  const now = Date.now();

  await mapWithConcurrency(items, 5, async (item) => {
    const cached = appdetailsCache[item.appid];
    if (cached && now - cached.cachedAt <= APPDETAILS_TTL_MS) return;

    let details = await fetchAppDetails(item.appid);
    if (!details) {
      await new Promise((r) => setTimeout(r, 400));
      details = await fetchAppDetails(item.appid);
    }
    // Only persist successful lookups; a failed/rate-limited fetch is retried
    // on the next refresh instead of being baked in as "no data" for 30 days.
    if (details) appdetailsCache[item.appid] = { ...details, cachedAt: now };
  });

  cache.saveJson('appdetails-cache.json', appdetailsCache);

  for (const item of items) {
    const d = appdetailsCache[item.appid];
    item.genres = d && d.genres ? d.genres : [];
    item.shortDescription = d && d.shortDescription ? d.shortDescription : '';
    item.multiplayer = !!(d && d.multiplayer);
    item.singleplayer = !!(d && d.singleplayer);
    item.metacritic = d && d.metacritic ? d.metacritic : null;
  }
}

async function enrichWithItad(items, apiKey) {
  if (!apiKey) {
    for (const item of items) item.allTimeLowCut = null;
    return;
  }

  const itadCache = cache.loadJson('itad-cache.json', {});
  const now = Date.now();

  await mapWithConcurrency(items, 3, async (item) => {
    const entry = itadCache[item.appid];
    if (entry && entry.itadId) return;
    try {
      const itadId = await itad.lookupGameId(item.appid, apiKey);
      itadCache[item.appid] = { itadId, storeLow: null, storeLowCachedAt: 0 };
    } catch (e) {
      // leave uncached on failure (network error / rate limit) so it retries next refresh
    }
  });

  const idsNeedingLow = Object.entries(itadCache)
    .filter(([appid, e]) => e.itadId && (now - (e.storeLowCachedAt || 0) > ITAD_STORELOW_TTL_MS))
    .filter(([appid]) => items.some((it) => it.appid === appid));

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

  for (const item of items) {
    const entry = itadCache[item.appid];
    item.allTimeLowCut = entry && entry.storeLow ? entry.storeLow.cut : null;
  }
}

function applyRecordTracking(items) {
  const record = cache.loadJson('record-history.json', {});

  for (const item of items) {
    const prevCut = record[item.appid];
    item.isNewAllTimeLow =
      item.allTimeLowCut !== null &&
      item.allTimeLowCut !== undefined &&
      prevCut !== null &&
      prevCut !== undefined &&
      item.allTimeLowCut > prevCut;
    record[item.appid] = item.allTimeLowCut;
  }

  cache.saveJson('record-history.json', record);
}

function applyHistory(items) {
  const history = cache.loadJson('history.json', {});
  const now = new Date().toISOString();

  for (const item of items) {
    const prev = history[item.appid];
    item.previousDiscount = prev ? prev.discount : null;
    item.discountDelta = prev ? item.discount - prev.discount : null;
    history[item.appid] = { discount: item.discount, finalPrice: item.finalPrice, fetchedAt: now };
  }

  cache.saveJson('history.json', history);
}

async function buildListResponse(count, mode) {
  const { queryParams, requireDiscount, requireTagId } = MODE_CONFIG[mode];
  // A quality filter (like requireTagId) can reject a large share of each raw
  // page, so keep pulling further pages from Steam until we have enough
  // qualifying items — up to a safety cap so a narrow filter can't spin
  // forever if Steam's supply of matches runs out.
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
    all = all.concat(parseResults(data.results_html, { requireDiscount, requireTagId }));
    start += 100;
  }
  all = all.slice(0, count);

  const config = loadConfig();
  applyHistory(all);
  await enrichWithAppDetails(all);
  await enrichWithItad(all, config.itadApiKey);
  applyRecordTracking(all);

  return { fetchedAt: new Date().toISOString(), itadEnabled: !!config.itadApiKey, items: all };
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://localhost:${PORT}`);
  const ip = req.socket.remoteAddress || 'unknown';

  const mode = reqUrl.pathname === '/api/deals' ? 'deals' : reqUrl.pathname === '/api/horror' ? 'horror' : null;

  if (mode) {
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

    try {
      const count = Math.min(parseInt(reqUrl.searchParams.get('count') || '150', 10), 300);
      if (!inFlightByMode[mode]) {
        inFlightByMode[mode] = buildListResponse(count, mode).finally(() => {
          inFlightByMode[mode] = null;
        });
      }
      const payload = await inFlightByMode[mode];
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
