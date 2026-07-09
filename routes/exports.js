const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const { Graph } = require("../services/graph");
const { generateGPX, generateSVG } = require("../services/export");

const CACHE_DIR = path.join(__dirname, "..", "data");
const graphCache = new Map();

function getOrBuildGraph(roadData) {
  const key = `${roadData.city.osmType}_${roadData.city.osmId}`;
  let graph = graphCache.get(key);
  if (!graph) {
    graph = new Graph(roadData);
    graphCache.set(key, graph);
  }
  return graph;
}

router.post("/gpx", (req, res) => {
  const { legs, routeName } = req.body || {};

  if (!legs?.length) {
    return res.status(400).json({ error: "No route legs provided" });
  }

  try {
    const gpxContent = generateGPX(legs, routeName);
    const safeName = (routeName || "strava-route").replace(/[^a-z0-9]/gi, "_").toLowerCase();

    res.setHeader("Content-Type", "application/gpx+xml");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}.gpx"`);
    res.send(gpxContent);
  } catch (error) {
    console.error("[exports/gpx]", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/svg", (req, res) => {
  const { cityKey, legs, width, height } = req.body || {};

  if (!cityKey) {
    return res.status(400).json({ error: "Missing cityKey" });
  }

  const filePath = path.join(CACHE_DIR, `osm_${cityKey}.json`);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "City road network not loaded" });
  }

  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const graph = getOrBuildGraph(data);
    const svgWidth = width || 1200;
    const svgHeight = height || 1200;
    const routeData = legs && legs.length > 0 ? { legs } : null;

    const svgContent = generateSVG(graph, legs, svgWidth, svgHeight);

    res.setHeader("Content-Type", "image/svg+xml");
    res.setHeader("Content-Disposition", `attachment; filename="map_${cityKey}.svg"`);
    res.send(svgContent);
  } catch (error) {
    console.error("[exports/svg]", error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
