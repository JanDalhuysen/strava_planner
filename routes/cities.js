const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const { geocodeCity } = require("../services/geocoder");
const { fetchRoadsForCity, getCachedRoadsByKey, cacheKeyFor } = require("../services/overpass");
const { Graph } = require("../services/graph");

const CACHE_DIR = path.join(__dirname, "..", "data");
const graphCache = new Map();

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
    const graph = getOrBuildGraph({ city, nodes: overpassData.nodes, ways: overpassData.ways });

    const clientWays = graph.ways.map((w) => ({
      id: w.id,
      highway: w.tags.highway || "residential",
      name: w.tags.name || "",
      coords: w.geometry.map((g) => [g.lat, g.lon]),
    }));

    res.json({
      cityKey,
      nodeCount: Object.keys(graph.nodes).length,
      wayCount: graph.ways.length,
      ways: clientWays,
    });
  } catch (error) {
    console.error("[cities/load]", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/:cityKey", (req, res) => {
  const cityKey = req.params.cityKey;
  const filePath = path.join(CACHE_DIR, `osm_${cityKey}.json`);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "City data not found" });
  }

  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const graph = getOrBuildGraph(data);

    res.json({
      cityKey,
      nodeCount: Object.keys(graph.nodes).length,
      wayCount: graph.ways.length,
      ways: graph.ways.map((w) => ({
        id: w.id,
        highway: w.tags.highway || "residential",
        name: w.tags.name || "",
        coords: w.geometry.map((g) => [g.lat, g.lon]),
      })),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
