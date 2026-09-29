const https = require('https');

const SINGLEPLAYER_CATEGORY_ID = 2;
const MULTIPLAYER_CATEGORY_IDS = new Set([1, 9, 20, 27, 36, 37, 38, 39, 47, 48, 49]);

// Steam has no player-count field, so instead of a numeric range we break
// multiplayer down by the categories it actually publishes (IDs verified
// against live appdetails responses for L4D2, Overcooked 2, PUBG, AoE2 DE):
//   9  Co-op                 38 Online Co-op          39 Split Screen Co-op   48 LAN Co-op
//   49 PvP                   36 Online PvP            37 Split Screen PvP     47 LAN PvP
//   20 MMO   27 Cross-Platform Multiplayer   24 Shared/Split Screen (general)
const COOP_CATEGORY_IDS = new Set([9, 38, 39, 48]);
const PVP_CATEGORY_IDS = new Set([49, 36, 37, 47]);
const ONLINE_CATEGORY_IDS = new Set([20, 27, 36, 38]);
const LOCAL_CATEGORY_IDS = new Set([24, 37, 39]);
// Separate from ONLINE_CATEGORY_IDS (which id 27 also counts toward) because
// this answers a specific question — can a PC player and a console player
// play together — that "online" alone doesn't.
const CROSS_PLATFORM_CATEGORY_ID = 27;

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
              coop: categoryIds.some((id) => COOP_CATEGORY_IDS.has(id)),
              pvp: categoryIds.some((id) => PVP_CATEGORY_IDS.has(id)),
              onlineMulti: categoryIds.some((id) => ONLINE_CATEGORY_IDS.has(id)),
              localMulti: categoryIds.some((id) => LOCAL_CATEGORY_IDS.has(id)),
              crossPlatform: categoryIds.includes(CROSS_PLATFORM_CATEGORY_ID),
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
