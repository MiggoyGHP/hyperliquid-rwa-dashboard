// Loader for the pre-baked JSON (stock candles + options), refreshed daily
// by GitHub Actions. Paths are relative so the site works at any base URL.
const cache = new Map();

async function getJson(path) {
  if (cache.has(path)) return cache.get(path);
  const p = fetch(path).then(res => {
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.json();
  });
  cache.set(path, p);
  p.catch(() => cache.delete(path));
  return p;
}

export const getMeta = () => getJson("data/meta.json");
export const getOhlc = sym => getJson(`data/ohlc/${sym}.json`);
export const getOptions = sym => getJson(`data/options/${sym}.json`);
// Append-only OI/volume snapshots; 404s until the first post-deploy bake runs
// (the promise cache evicts on rejection, so a later bake is picked up).
export const getOiSnapshots = () => getJson("data/oi/snapshots.json");
