const https = require('https');

const API_BASE = 'api.isthereanydeal.com';

function requestOnce(method, urlPath, apiKey, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        hostname: API_BASE,
        path: urlPath + (urlPath.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(apiKey),
        method,
        headers: {
          'Accept': 'application/json',
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {})
        }
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode === 429) {
            const err = new Error('ITAD rate limited');
            err.status = 429;
            err.retryAfter = parseInt(res.headers['retry-after'], 10) || 5;
            reject(err);
            return;
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`ITAD ${urlPath} → ${res.statusCode}: ${data.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function request(method, urlPath, apiKey, body) {
  try {
    return await requestOnce(method, urlPath, apiKey, body);
  } catch (e) {
    if (e.status === 429) {
      await new Promise((r) => setTimeout(r, e.retryAfter * 1000));
      return requestOnce(method, urlPath, apiKey, body);
    }
    throw e;
  }
}

async function lookupGameId(appid, apiKey) {
  const data = await request('GET', `/games/lookup/v1?appid=${appid}`, apiKey);
  return data.found ? data.game.id : null;
}

async function getStoreLows(gameIds, apiKey, country) {
  if (!gameIds.length) return {};
  const chunks = [];
  for (let i = 0; i < gameIds.length; i += 200) chunks.push(gameIds.slice(i, i + 200));

  const result = {};
  for (const chunk of chunks) {
    const data = await request('POST', `/games/storelow/v2?country=${country}`, apiKey, chunk);
    for (const entry of data) {
      const steamLow = entry.lows.find((l) => l.shop.name === 'Steam') || entry.lows[0];
      result[entry.id] = steamLow ? { cut: steamLow.cut, price: steamLow.price, timestamp: steamLow.timestamp } : null;
    }
  }
  return result;
}

module.exports = { lookupGameId, getStoreLows };
