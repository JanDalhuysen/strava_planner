const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const { geocodeCity } = require("../services/geocoder");
const { fetchRoadsForCity, getCachedRoadsByKey, cacheKeyFor } = require("../services/overpass");
const { Graph } = require("../services/graph");

const CACHE_DIR = path.join(__dirname, "..", "data");
const graphCache = new Map();

function formatRoadData(roadData, cityKey) {
  const graph = getOrBuildGraph(roadData);

  return {
    cityKey,
    nodeCount: Object.keys(graph.nodes).length,
    wayCount: graph.ways.length,
    ways: graph.ways.map((w) => ({
      id: w.id,
      highway: w.tags.highway || "residential",
      name: w.tags.name || "",
      coords: w.geometry.map((g) => [g.lat, g.lon]),
    })),
  };
}

function getOrBuildGraph(roadData) {
  const key = cacheKeyFor(roadData.city);
  let graph = graphCache.get(key);
  if (!graph) {
    graph = new Graph(roadData);
    graphCache.set(key, graph);
  }
  return graph;
}

router.get("/search", async (req, res) => {
  const query = req.query.q?.trim();
  if (!query) return res.status(400).json({ error: "Search query required" });

  try {
    const city = await geocodeCity(query);
    res.json([city]);
  } catch (err) {
    console.error("[cities/search]", err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get("/cached", (req, res) => {
  try {
    const cities = fs
      .readdirSync(CACHE_DIR)
      .filter((file) => /^osm_[A-Za-z0-9_-]+\.json$/.test(file))
      .map((file) => {
        const cityKey = file.slice(4, -5);
        const data = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, file), "utf8"));

        if (!data?.city?.displayName || !data.city.bbox || !data.nodes || !Array.isArray(data.ways) || data.ways.length === 0) {
          return null;
        }

        return {
          cityKey,
          displayName: data.city.displayName,
          bbox: data.city.bbox,
          osmType: data.city.osmType,
          osmId: data.city.osmId,
          fetchedAt: data.fetchedAt || null,
          nodeCount: Object.keys(data.nodes).length,
          wayCount: data.ways.length,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.displayName.localeCompare(b.displayName));

    res.json(cities);
  } catch (error) {
    console.error("[cities/cached]", error);
    res.status(500).json({ error: "Could not list cached cities" });
  }
});

router.get("/load", async (req, res) => {
  const { osmType, osmId, south, north, west, east, cityName } = req.query;

  if (!osmType || !osmId || !south || !north || !west || !east) {
    return res.status(400).json({ error: "Missing osmType, osmId, or bounding box coordinates" });
  }

  const cityKey = `${osmType}_${osmId}`;

  try {
    // Build city object for the overpass service
    const city = {
      displayName: cityName || cityKey,
      bbox: {
        minLat: parseFloat(south),
        maxLat: parseFloat(north),
        minLon: parseFloat(west),
        maxLon: parseFloat(east),
      },
      osmType,
      osmId,
    };

    // Use the robust overpass service with multi-mirror retry and caching
    const overpassData = await fetchRoadsForCity(city);

    // Build graph from the fetched data
    res.json(formatRoadData({ city, nodes: overpassData.nodes, ways: overpassData.ways }, cityKey));
  } catch (error) {
    console.error("[cities/load]", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/:cityKey", (req, res) => {
  const cityKey = req.params.cityKey;
  if (!/^[A-Za-z0-9_-]+$/.test(cityKey)) {
    return res.status(400).json({ error: "Invalid city key" });
  }
  const filePath = path.join(CACHE_DIR, `osm_${cityKey}.json`);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "City data not found" });
  }

  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    res.json(formatRoadData(data, cityKey));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
