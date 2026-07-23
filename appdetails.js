const https = require('https');

const SINGLEPLAYER_CATEGORY_ID = 2;
const MULTIPLAYER_CATEGORY_IDS = new Set([1, 9, 20, 27, 36, 37, 38, 39, 47, 48, 49]);

function decodeEntities(str) {
  return (str || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

function fetchAppDetails(appid) {
  const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&cc=kr&l=korean`;
  return new Promise((resolve, reject) => {
    https.get(
      url,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
        }
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          try {
            const json = JSON.parse(raw);
            const entry = json[appid];
            if (!entry || !entry.success) {
              resolve(null);
              return;
            }
            const data = entry.data;
            const categoryIds = (data.categories || []).map((c) => c.id);
            const isMultiplayer = categoryIds.some((id) => MULTIPLAYER_CATEGORY_IDS.has(id));
            const isSingleplayer = categoryIds.includes(SINGLEPLAYER_CATEGORY_ID);
            resolve({
              genres: (data.genres || []).map((g) => g.description),
              shortDescription: decodeEntities(data.short_description),
              multiplayer: isMultiplayer,
              singleplayer: isSingleplayer,
              metacritic: data.metacritic ? { score: data.metacritic.score, url: data.metacritic.url } : null
            });
          } catch (e) {
            resolve(null);
          }
        });
      }
    ).on('error', () => resolve(null));
  });
}

module.exports = { fetchAppDetails };
