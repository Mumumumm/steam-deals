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

let inFlightDeals = null;

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

function fetchSteamHtml(count, start) {
  const url = `https://store.steampowered.com/search/results/?query&start=${start}&count=${count}&specials=1&infinite=1&cc=kr&l=korean`;
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

function parseResults(html) {
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

    if (!appidMatch || !nameMatch || !discountMatch || !origMatch || !finalMatch) continue;
    if (parseInt(discountMatch[1], 10) <= 0) continue;

    items.push({
      appid: appidMatch[1],
      name: decodeEntities(nameMatch[1]),
      image: imgMatch ? imgMatch[1] : '',
      discount: parseInt(discountMatch[1], 10),
      originalPrice: origMatch ? decodeEntities(origMatch[1]) : '',
      finalPrice: finalMatch ? decodeEntities(finalMatch[1]) : '',
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

async function buildDealsResponse(count) {
  const pages = Math.ceil(count / 100);
  let all = [];
  for (let p = 0; p < pages; p++) {
    let data;
    try {
      data = await fetchSteamHtml(Math.min(100, count - p * 100), p * 100);
    } catch (e) {
      await new Promise((r) => setTimeout(r, 800));
      data = await fetchSteamHtml(Math.min(100, count - p * 100), p * 100);
    }
    all = all.concat(parseResults(data.results_html));
  }

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

    try {
      const count = Math.min(parseInt(reqUrl.searchParams.get('count') || '150', 10), 300);
      if (!inFlightDeals) {
        inFlightDeals = buildDealsResponse(count).finally(() => {
          inFlightDeals = null;
        });
      }
      const payload = await inFlightDeals;
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
