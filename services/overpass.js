const fs = require("fs");
const path = require("path");

const USER_AGENT = "StravaSegmentPlanner/1.0 (https://github.com/JanDalhuysen/strava_planner)";

const OVERPASS_MIRRORS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter", "https://overpass.openstreetmap.ru/api/interpreter"];
const OVERPASS_TIMEOUT_MS = 25000 * 2;
const QUERY_TIMEOUT = 180 * 2;

const HIGHWAY_TYPES =
  "motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|" +
  "tertiary|tertiary_link|unclassified|residential|service|living_street|cycleway|path|track|footway";

const CACHE_DIR = path.join(__dirname, "..", "data");
const MAX_CACHE_AGE_MS = 24 * 60 * 60 * 1000;

function cacheFile(cacheKey) {
  return path.join(CACHE_DIR, `osm_${cacheKey}.json`);
}

function getCachedRoadsByKey(cacheKey) {
  const file = cacheFile(cacheKey);
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));

    // Validate that the cache is in the processed format and is not empty or corrupt
    if (!data || !data.fetchedAt || !data.nodes || !data.ways || !Array.isArray(data.ways) || data.ways.length === 0) {
      console.warn(`[overpass] Cache file ${file} is invalid or in raw/outdated format. Deleting cache.`);
      try {
        fs.unlinkSync(file);
      } catch (err) {
        console.error(`[overpass] Failed to delete invalid cache file ${file}:`, err);
      }
      return null;
    }

    const ageMs = Date.now() - new Date(data.fetchedAt).getTime();
    if (ageMs > MAX_CACHE_AGE_MS) return null;
    return data;
  } catch {
    return null;
  }
}

function validateBbox(bbox) {
  const { minLat, maxLat, minLon, maxLon } = bbox;
  const latSpan = maxLat - minLat;
  const lonSpan = maxLon - minLon;
  if (latSpan > 0.25 || lonSpan > 0.35) {
    throw new Error(`Area too large (${latSpan.toFixed(3)}° x ${lonSpan.toFixed(3)}°). Try a more specific name like "Somerset West, South Africa".`);
  }
}

async function fetchRoadsForCity(city) {
  const cacheKey = cacheKeyFor(city);
  const cached = getCachedRoadsByKey(cacheKey);
  if (cached) {
    console.log(`[overpass] Cache hit for ${cacheKey}`);
    return cached;
  }

  validateBbox(city.bbox);
  const { minLat, maxLat, minLon, maxLon } = city.bbox;

  const overpassQuery = `
[out:json][timeout:${QUERY_TIMEOUT}];
(
  way["highway"~"^(${HIGHWAY_TYPES})$"](${minLat},${minLon},${maxLat},${maxLon});
);
out geom;
  `.trim();

  let data = null;
  let lastErr = null;

  for (const mirror of OVERPASS_MIRRORS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OVERPASS_TIMEOUT_MS);
    try {
      console.log(`[overpass] Trying ${mirror}`);
      const start = Date.now();
      const resp = await fetch(mirror, {
        method: "POST",
        body: `data=${encodeURIComponent(overpassQuery)}`,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          "User-Agent": USER_AGENT,
        },
        signal: controller.signal,
      });

      if (!resp.ok) throw new Error(`status code ${resp.status}`);

      data = await resp.json();
      console.log(`[overpass] Success with ${mirror} in ${Date.now() - start}ms`);
      break;
    } catch (err) {
      const reason = err.name === "AbortError" ? `timed out after ${OVERPASS_TIMEOUT_MS}ms` : err.message;
      console.warn(`[overpass] ${mirror} failed (${reason}), trying next...`);
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
  }
  if (!data) throw lastErr || new Error("All Overpass mirrors failed");

  if (!data.elements?.length) {
    throw new Error("No roads found in the selected region.");
  }

  const nodes = {};
  const ways = [];

  for (const el of data.elements) {
    if (el.type !== "way" || !el.nodes?.length || !el.geometry?.length) continue;

    for (let i = 0; i < el.nodes.length; i++) {
      const pt = el.geometry[i];
      if (pt) nodes[el.nodes[i]] = { lat: pt.lat, lon: pt.lon };
    }

    ways.push({ id: el.id, nodeRefs: el.nodes, tags: el.tags || {} });
  }

  const result = { city, nodes, ways, fetchedAt: new Date().toISOString() };
  fs.writeFileSync(cacheFile(cacheKey), JSON.stringify(result));
  console.log(`[overpass] Cached to ${cacheFile(cacheKey)}`);
  return result;
}

function cacheKeyFor(city) {
  if (city.osmType && city.osmId) return `${city.osmType}_${city.osmId}`;
  return city.displayName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "_")
    .replace(/_+/g, "_");
}

module.exports = { fetchRoadsForCity, getCachedRoadsByKey, cacheKeyFor };
