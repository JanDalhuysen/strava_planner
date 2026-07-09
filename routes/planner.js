const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const { Graph } = require("../services/graph");
const { orderSegments, buildSegmentPaths, stitchRoute } = require("../services/routing");
const { fetchRoadsForCity, getCachedRoadsByKey, cacheKeyFor } = require("../services/overpass");
const { generateGPX } = require("../services/export");

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

function loadSegments() {
  const file = path.join(CACHE_DIR, "segments.json");
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

router.post("/nearest", (req, res) => {
  const { cityKey, lat, lon } = req.body || {};
  if (!cityKey || lat === undefined || lon === undefined) {
    return res.status(400).json({ error: "Missing cityKey, lat, or lon" });
  }

  const filePath = path.join(CACHE_DIR, `osm_${cityKey}.json`);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "City road network not loaded" });
  }

  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const graph = getOrBuildGraph(data);
    const nearest = graph.findNearestNodeOrSnappedPoint(lat, lon);

    if (!nearest) {
      return res.status(404).json({ error: "No road found near this point" });
    }

    res.json(nearest);
  } catch (error) {
    console.error("[planner/nearest]", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/path", (req, res) => {
  const { cityKey, startNodeId, endNodeId, startNode, endNode } = req.body || {};

  const fromId = startNode?.id || startNodeId;
  const toId = endNode?.id || endNodeId;

  if (!cityKey || !fromId || !toId) {
    return res.status(400).json({ error: "Missing cityKey, startNodeId/startNode, or endNodeId/endNode" });
  }

  const filePath = path.join(CACHE_DIR, `osm_${cityKey}.json`);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "City road network not loaded" });
  }

  const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const graph = getOrBuildGraph(data);

  const virtualNodes = [];
  if (startNode && startNode.isVirtual) virtualNodes.push(startNode);
  if (endNode && endNode.isVirtual) virtualNodes.push(endNode);

  try {
    const overlay = graph.buildVirtualOverlay(virtualNodes);
    const result = graph.aStar(fromId, toId, overlay);

    if (!result) {
      return res.status(404).json({ error: "No path found between these points" });
    }

    res.json({
      distance: result.distance,
      coords: result.coords,
      path: result.path,
    });
  } catch (error) {
    console.error("[planner/path]", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/route", async (req, res) => {
  const { cityKey, segments, restDistanceMeters } = req.body || {};

  if (!cityKey || !segments?.length || restDistanceMeters === undefined) {
    return res.status(400).json({ error: "Missing cityKey, segments, or restDistanceMeters" });
  }

  const filePath = path.join(CACHE_DIR, `osm_${cityKey}.json`);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "City road network not loaded" });
  }

  const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const graph = getOrBuildGraph(data);

  const virtualNodes = [];
  for (const seg of segments) {
    if (seg.startNode && seg.startNode.isVirtual) virtualNodes.push(seg.startNode);
    if (seg.endNode && seg.endNode.isVirtual) virtualNodes.push(seg.endNode);
  }

  try {
    const overlay = graph.buildVirtualOverlay(virtualNodes);

    const ordered = orderSegments(graph, segments, overlay);

    const { segmentPaths, segmentEdges } = await buildSegmentPaths(graph, ordered, overlay);

    const legs = stitchRoute(graph, segmentPaths, restDistanceMeters, segmentEdges, overlay);

    const totalDistance = legs.reduce((sum, leg) => sum + leg.distance, 0);
    const totalSegmentDistance = legs.filter((l) => l.type === "segment").reduce((sum, leg) => sum + leg.distance, 0);
    const totalRestDistance = legs.filter((l) => l.type === "rest").reduce((sum, leg) => sum + leg.distance, 0);

    res.json({
      legs,
      totalDistance,
      totalSegmentDistance,
      totalRestDistance,
    });
  } catch (error) {
    console.error("[planner/route]", error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
