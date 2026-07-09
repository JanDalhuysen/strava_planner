const { haversine } = require("./haversine");
const { Graph } = require("./graph");

function orderSegments(graph, segments, overlay = null) {
  if (segments.length <= 1) return [...segments];
  const ordered = [segments[0]];
  const remaining = new Set(segments.slice(1));
  while (remaining.size > 0) {
    const last = ordered[ordered.length - 1];
    const lastEndId = last.endNode?.id || last.endNodeId;
    const endNode = graph.nodes[lastEndId] || (overlay && overlay.nodes[lastEndId]);
    if (!endNode) {
      // Fallback if end node not found in graph
      const next = remaining.values().next().value;
      ordered.push(next);
      remaining.delete(next);
      continue;
    }
    let nearest = null;
    let nearestDist = Infinity;
    for (const seg of remaining) {
      const segStartId = seg.startNode?.id || seg.startNodeId;
      const startNode = graph.nodes[segStartId] || (overlay && overlay.nodes[segStartId]);
      if (!startNode) continue;
      const d = haversine({ lat: endNode.lat, lon: endNode.lon }, { lat: startNode.lat, lon: startNode.lon });
      if (d < nearestDist) {
        nearestDist = d;
        nearest = seg;
      }
    }
    if (!nearest) {
      // Fallback
      nearest = remaining.values().next().value;
    }
    ordered.push(nearest);
    remaining.delete(nearest);
  }
  return ordered;
}

async function buildSegmentPaths(graph, segments, overlay = null) {
  const segmentPaths = [];
  const segmentEdges = new Set();

  for (const seg of segments) {
    const startNodeId = seg.startNode?.id || seg.startNodeId;
    const endNodeId = seg.endNode?.id || seg.endNodeId;
    const result = graph.aStar(startNodeId, endNodeId, overlay);
    if (!result) {
      throw new Error(`Could not find a path for segment "${seg.name}".`);
    }

    segmentPaths.push({
      name: seg.name,
      path: result.path || [],
      distance: result.distance,
      coords: result.coords,
    });

    // Record edges in this segment to exclude during resting
    for (let i = 0; i < result.path.length - 1; i++) {
      segmentEdges.add(`${result.path[i]}->${result.path[i + 1]}`);
    }
  }

  return { segmentPaths, segmentEdges };
}

function stitchRoute(graph, segmentPaths, restDistanceMeters, segmentEdges, overlay = null) {
  const legs = [];

  for (let i = 0; i < segmentPaths.length; i++) {
    // Add segment leg
    legs.push({
      type: "segment",
      name: segmentPaths[i].name,
      path: segmentPaths[i].path,
      distance: segmentPaths[i].distance,
      coords: segmentPaths[i].coords,
    });

    // If there is a next segment, route from end of current to start of next with detour
    if (i < segmentPaths.length - 1) {
      const currentEndNodeId = segmentPaths[i].path[segmentPaths[i].path.length - 1];
      const nextStartNodeId = segmentPaths[i + 1].path[0];

      const detour = graph.findDetourPath(currentEndNodeId, nextStartNodeId, restDistanceMeters, segmentEdges, overlay);

      if (detour.distance === Infinity) {
        throw new Error(`Could not find a path (rest detour) between Segment ${i + 1} and Segment ${i + 2}.`);
      }

      legs.push({
        type: "rest",
        name: `Rest Period`,
        path: detour.path,
        distance: detour.distance,
        coords: graph.getPathCoords(detour.path, overlay),
      });
    }
  }

  return legs;
}

module.exports = { orderSegments, buildSegmentPaths, stitchRoute };
