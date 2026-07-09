const USER_AGENT = "StravaSegmentPlanner/1.0 (contact: cyclist-planner@example.com)";

const PHOTON_URL = "https://photon.komoot.io/api/";
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

async function geocodeCity(cityName) {
  try {
    return await _geocodePhoton(cityName);
  } catch (err) {
    console.warn(`[geocode] Photon failed (${err.message}), falling back to Nominatim`);
    return await _geocodeNominatim(cityName);
  }
}

async function _geocodePhoton(cityName) {
  const url = `${PHOTON_URL}?q=${encodeURIComponent(cityName)}&limit=5`;
  const resp = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!resp.ok) throw new Error(`Photon request failed with status code ${resp.status}`);

  const data = await resp.json();
  const features = data?.features;
  if (!features?.length) throw new Error(`City "${cityName}" not found`);

  const feature = features.find((f) => f.properties?.extent && f.properties?.type !== "house") || features[0];

  const props = feature.properties;
  const [lon, lat] = feature.geometry.coordinates;

  let bbox;
  if (props.extent) {
    const [lonA, latA, lonB, latB] = props.extent;
    bbox = {
      minLat: Math.min(latA, latB),
      maxLat: Math.max(latA, latB),
      minLon: Math.min(lonA, lonB),
      maxLon: Math.max(lonA, lonB),
    };
  } else {
    const d = 0.04;
    bbox = { minLat: lat - d, maxLat: lat + d, minLon: lon - d, maxLon: lon + d };
  }

  const displayName = [props.name, props.city, props.state, props.country].filter(Boolean).join(", ");

  return {
    displayName,
    bbox,
    center: { lat, lon },
    osmType: props.osm_type || null,
    osmId: props.osm_id || null,
  };
}

async function _geocodeNominatim(cityName) {
  const url = `${NOMINATIM_URL}?q=${encodeURIComponent(cityName)}&format=json&limit=5&addressdetails=1`;

  const resp = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9" },
  });
  if (!resp.ok) throw new Error(`Nominatim request failed with status code ${resp.status}`);

  const data = await resp.json();
  if (!data.length) throw new Error(`City "${cityName}" not found`);

  const result = data.find((r) => ["city", "town", "village", "suburb", "municipality"].includes(r.type)) || data[0];

  const [minLatR, maxLatR, minLonR, maxLonR] = result.boundingbox.map(parseFloat);
  return {
    displayName: result.display_name,
    bbox: {
      minLat: Math.min(minLatR, maxLatR),
      maxLat: Math.max(minLatR, maxLatR),
      minLon: Math.min(minLonR, maxLonR),
      maxLon: Math.max(minLonR, maxLonR),
    },
    center: { lat: parseFloat(result.lat), lon: parseFloat(result.lon) },
    osmType: result.osm_type ? result.osm_type[0].toUpperCase() : null,
    osmId: result.osm_id || null,
  };
}

function cacheKeyFor(city) {
  if (city.osmType && city.osmId) return `${city.osmType}_${city.osmId}`;
  return city.displayName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "_")
    .replace(/_+/g, "_");
}

module.exports = { geocodeCity, cacheKeyFor };
