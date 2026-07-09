const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");

const DATA_FILE = path.join(__dirname, "..", "data", "segments.json");

function loadSegments() {
  if (!fs.existsSync(DATA_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveSegments(segments) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(segments, null, 2));
}

router.get("/", (req, res) => {
  const segments = loadSegments();
  res.json(segments);
});

router.post("/", (req, res) => {
  const { name, coords, path, startNode, endNode, distance, city } = req.body;

  if (!name || !coords?.length || !path?.length) {
    return res.status(400).json({ error: "Missing required segment data" });
  }

  const segments = loadSegments();
  const newSegment = {
    id: `seg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    name,
    coords,
    path,
    startNode,
    endNode,
    distance,
    city: city || "",
    createdAt: new Date().toISOString(),
  };

  segments.push(newSegment);
  saveSegments(segments);

  res.status(201).json(newSegment);
});

router.put("/:id", (req, res) => {
  const { name, reverse, move } = req.body;
  const segments = loadSegments();
  const idx = segments.findIndex((s) => s.id === req.params.id);

  if (idx === -1) {
    return res.status(404).json({ error: "Segment not found" });
  }

  if (name !== undefined) segments[idx].name = name;

  if (reverse) {
    const seg = segments[idx];
    seg.coords = [...seg.coords].reverse();
    [seg.startNode, seg.endNode] = [seg.endNode, seg.startNode];
    seg.path = [...seg.path].reverse();
  }

  if (move !== undefined) {
    const targetIdx = idx + move;
    if (targetIdx >= 0 && targetIdx < segments.length) {
      [segments[idx], segments[targetIdx]] = [segments[targetIdx], segments[idx]];
    }
  }

  saveSegments(segments);
  res.json(segments[idx]);
});

router.delete("/:id", (req, res) => {
  const segments = loadSegments();
  const idx = segments.findIndex((s) => s.id === req.params.id);

  if (idx === -1) {
    return res.status(404).json({ error: "Segment not found" });
  }

  const deleted = segments.splice(idx, 1)[0];
  saveSegments(segments);
  res.json({ success: true, deleted });
});

module.exports = router;
