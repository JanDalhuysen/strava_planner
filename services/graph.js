const { haversine } = require("./haversine");

function parseNodeId(id) {
  if (id === undefined || id === null) return id;
  const parsed = parseInt(id, 10);
  return isNaN(parsed) || String(parsed) !== String(id) ? id : parsed;
}

function projectPointToSegment(p, a, b) {
  const cosLat = Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  const ax = a.lon * cosLat;
  const ay = a.lat;
  const bx = b.lon * cosLat;
  const by = b.lat;
  const px = p.lon * cosLat;
  const py = p.lat;

  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;

  if (lenSq === 0) {
    return { lat: a.lat, lon: a.lon, fraction: 0 };
  }

  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));

  const projLon = (ax + t * dx) / cosLat;
  const projLat = ay + t * dy;

  return { lat: projLat, lon: projLon, fraction: t };
}

class MinHeap {
  constructor() {
    this.h = [];
  }
  push(item) {
    this.h.push(item);
    this._up(this.h.length - 1);
  }
  pop() {
    if (this.h.length === 1) return this.h.pop();
    const top = this.h[0];
    this.h[0] = this.h.pop();
    this._down(0);
    return top;
  }
  get size() {
    return this.h.length;
  }
  _up(i) {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.h[p].p <= this.h[i].p) break;
      [this.h[p], this.h[i]] = [this.h[i], this.h[p]];
      i = p;
    }
  }
  _down(i) {
    const n = this.h.length;
    for (;;) {
      let m = i;
      const l = 2 * i + 1,
        r = l + 1;
      if (l < n && this.h[l].p < this.h[m].p) m = l;
      if (r < n && this.h[r].p < this.h[m].p) m = r;
      if (m === i) break;
      [this.h[m], this.h[i]] = [this.h[i], this.h[m]];
      i = m;
    }
  }
}

class SpatialIndex {
  constructor(cellDeg = 0.001) {
    this.cs = cellDeg;
    this.grid = new Map();
  }
  _key(lat, lon) {
    return `${Math.floor(lat / this.cs)},${Math.floor(lon / this.cs)}`;
  }
  add(id, lat, lon) {
    const k = this._key(lat, lon);
    if (!this.grid.has(k)) this.grid.set(k, []);
    this.grid.get(k).push({ id, lat, lon });
  }
  findNearest(lat, lon) {
    const cx = Math.floor(lat / this.cs);
    const cy = Math.floor(lon / this.cs);
    for (let r = 0; r <= 20; r++) {
      const candidates = [];
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (r > 0 && Math.abs(dx) < r && Math.abs(dy) < r) continue;
          const cell = this.grid.get(`${cx + dx},${cy + dy}`);
          if (cell) candidates.push(...cell);
        }
      }
      if (candidates.length) {
        candidates.sort((a, b) => haversine({ lat, lon }, a) - haversine({ lat, lon }, b));
        return candidates[0].id;
      }
    }
    return null;
  }
}

class Graph {
  constructor(overpassData) {
    this.nodes = {};
    this.adjacency = {};
    this.reverseAdjacency = {};
    this.ways = [];
    this.spatialIndex = new SpatialIndex(0.001);

    if (overpassData && overpassData.nodes && overpassData.ways) {
      this.parse(overpassData);
    }
  }

  parse(data) {
    const { nodes, ways } = data;

    for (const [id, node] of Object.entries(nodes)) {
      this.nodes[id] = { id, lat: node.lat, lon: node.lon };
      this.adjacency[id] = [];
      this.reverseAdjacency[id] = [];
      this.spatialIndex.add(id, node.lat, node.lon);
    }

    for (const way of ways) {
      const refs = way.nodeRefs.map(String);
      const tags = way.tags || {};
      const isOneway = tags.oneway === "yes" || tags.oneway === "1" || tags.junction === "roundabout";
      const isOnewayReverse = tags.oneway === "-1";

      for (let i = 0; i < refs.length - 1; i++) {
        const u = refs[i],
          v = refs[i + 1];
        const nodeU = nodes[u],
          nodeV = nodes[v];
        if (!nodeU || !nodeV) continue;

        const dist = haversine(nodeU, nodeV);

        const edgeInfo = {
          distance: dist,
          name: tags.name || "",
          highway: tags.highway || "",
          wayId: way.id,
        };

        if (!isOnewayReverse) {
          this.adjacency[u].push({ targetId: v, ...edgeInfo });
          this.reverseAdjacency[v].push({ targetId: u, ...edgeInfo });
        }
        if (!isOneway && !isOnewayReverse) {
          this.adjacency[v].push({ targetId: u, ...edgeInfo });
          this.reverseAdjacency[u].push({ targetId: v, ...edgeInfo });
        }
        if (isOnewayReverse) {
          this.adjacency[v].push({ targetId: u, ...edgeInfo });
          this.reverseAdjacency[u].push({ targetId: v, ...edgeInfo });
        }
      }

      this.ways.push({
        id: way.id,
        nodes: way.nodeRefs,
        tags: way.tags || {},
        geometry: way.geometry || way.nodeRefs.map((id) => nodes[id]).filter(Boolean),
      });
    }
  }

  findNearestNode(lat, lon) {
    const nodeId = this.spatialIndex.findNearest(lat, lon);
    if (!nodeId) return null;
    const node = this.nodes[nodeId];
    return {
      id: nodeId,
      lat: node.lat,
      lon: node.lon,
      distance: haversine({ lat, lon }, node),
    };
  }

  getCandidateWaysForPoint(lat, lon) {
    const cx = Math.floor(lat / this.spatialIndex.cs);
    const cy = Math.floor(lon / this.spatialIndex.cs);
    const nearbyNodeIds = new Set();

    // Search in a 3x3 grid around click point
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        const cell = this.spatialIndex.grid.get(`${cx + dx},${cy + dy}`);
        if (cell) {
          for (const n of cell) {
            nearbyNodeIds.add(String(n.id));
          }
        }
      }
    }

    if (nearbyNodeIds.size === 0) {
      for (let r = 3; r <= 10; r++) {
        for (let dx = -r; dx <= r; dx++) {
          for (let dy = -r; dy <= r; dy++) {
            if (Math.abs(dx) < r && Math.abs(dy) < r) continue;
            const cell = this.spatialIndex.grid.get(`${cx + dx},${cy + dy}`);
            if (cell) {
              for (const n of cell) {
                nearbyNodeIds.add(String(n.id));
              }
            }
          }
        }
        if (nearbyNodeIds.size > 0) break;
      }
    }

    const candidateWays = [];
    for (const way of this.ways) {
      let matches = false;
      for (const nid of way.nodes) {
        if (nearbyNodeIds.has(String(nid))) {
          matches = true;
          break;
        }
      }
      if (matches) {
        candidateWays.push(way);
      }
    }
    return candidateWays;
  }

  findNearestPointOnRoad(lat, lon) {
    const candidateWays = this.getCandidateWaysForPoint(lat, lon);
    let minDistance = Infinity;
    let bestPoint = null;

    const p = { lat, lon };

    const checkWays = (ways) => {
      for (const way of ways) {
        for (let i = 0; i < way.nodes.length - 1; i++) {
          const u = String(way.nodes[i]);
          const v = String(way.nodes[i + 1]);
          const nodeU = this.nodes[u];
          const nodeV = this.nodes[v];
          if (!nodeU || !nodeV) continue;

          const proj = projectPointToSegment(p, nodeU, nodeV);
          const dist = haversine(p, proj);

          if (dist < minDistance) {
            minDistance = dist;
            bestPoint = {
              lat: proj.lat,
              lon: proj.lon,
              wayId: way.id,
              u,
              v,
              fraction: proj.fraction,
            };
          }
        }
      }
    };

    checkWays(candidateWays);

    if (minDistance > 25) {
      const checked = new Set(candidateWays.map((way) => String(way.id)));
      checkWays(this.ways.filter((way) => !checked.has(String(way.id))));
    }

    if (!bestPoint) return null;
    return {
      ...bestPoint,
      distance: minDistance,
    };
  }

  findNearestNodeOrSnappedPoint(lat, lon) {
    const nearestNode = this.findNearestNode(lat, lon);

    if (nearestNode && nearestNode.distance < 10) {
      return {
        id: nearestNode.id,
        lat: nearestNode.lat,
        lon: nearestNode.lon,
        distance: nearestNode.distance,
        isVirtual: false,
      };
    }

    const nearestPoint = this.findNearestPointOnRoad(lat, lon);
    if (!nearestPoint) return nearestNode;

    if (nearestPoint.distance > 150) {
      return {
        id: nearestNode.id,
        lat: nearestNode.lat,
        lon: nearestNode.lon,
        distance: nearestNode.distance,
        isVirtual: false,
      };
    }

    const nodeU = this.nodes[nearestPoint.u];
    const nodeV = this.nodes[nearestPoint.v];
    const distToU = haversine({ lat, lon }, nodeU);
    const distToV = haversine({ lat, lon }, nodeV);

    if (distToU < 10) {
      return {
        id: nearestPoint.u,
        lat: nodeU.lat,
        lon: nodeU.lon,
        distance: distToU,
        isVirtual: false,
      };
    }
    if (distToV < 10) {
      return {
        id: nearestPoint.v,
        lat: nodeV.lat,
        lon: nodeV.lon,
        distance: distToV,
        isVirtual: false,
      };
    }

    const virtualId = `virtual_${nearestPoint.lat.toFixed(6)}_${nearestPoint.lon.toFixed(6)}`;
    return {
      id: virtualId,
      lat: nearestPoint.lat,
      lon: nearestPoint.lon,
      distance: nearestPoint.distance,
      isVirtual: true,
      u: nearestPoint.u,
      v: nearestPoint.v,
      wayId: nearestPoint.wayId,
      fraction: nearestPoint.fraction,
    };
  }

  buildVirtualOverlay(vNodes) {
    const overlay = {
      nodes: {},
      adj: {},
      rev: {},
      removedEdges: new Set(),
    };

    if (!vNodes || vNodes.length === 0) return overlay;

    const uniqueNodes = [];
    const seenIds = new Set();
    for (const vn of vNodes) {
      if (vn && vn.isVirtual && !seenIds.has(vn.id)) {
        seenIds.add(vn.id);
        uniqueNodes.push(vn);
      }
    }

    if (uniqueNodes.length === 0) return overlay;

    const edgeGroups = new Map();
    for (const vn of uniqueNodes) {
      const uStr = String(vn.u);
      const vStr = String(vn.v);
      const key = uStr < vStr ? `${uStr}->${vStr}` : `${vStr}->${uStr}`;
      const baseNodeId = uStr < vStr ? uStr : vStr;
      const otherNodeId = uStr < vStr ? vStr : uStr;

      if (!edgeGroups.has(key)) {
        edgeGroups.set(key, { u: baseNodeId, v: otherNodeId, list: [] });
      }

      let frac = vn.fraction;
      if (String(vn.u) !== baseNodeId) {
        frac = 1 - frac;
      }

      edgeGroups.get(key).list.push({ node: vn, fraction: frac });
    }

    for (const [key, group] of edgeGroups.entries()) {
      const { u, v, list } = group;
      list.sort((a, b) => a.fraction - b.fraction);

      const nodeU = this.nodes[u];
      const nodeV = this.nodes[v];
      if (!nodeU || !nodeV) continue;

      for (const item of list) {
        const vn = item.node;
        overlay.nodes[vn.id] = { id: vn.id, lat: parseFloat(vn.lat), lon: parseFloat(vn.lon) };
      }

      const getOriginalEdge = (from, to) => {
        const edges = this.adjacency[from] || [];
        return edges.find((e) => String(e.targetId) === String(to));
      };

      const origEdgeUV = getOriginalEdge(u, v);
      const origEdgeVU = getOriginalEdge(v, u);

      const chain = [u, ...list.map((item) => item.node.id), v];

      const addChainEdge = (from, to, origEdge) => {
        if (!origEdge) return;
        const nodeFrom = this.nodes[from] || overlay.nodes[from];
        const nodeTo = this.nodes[to] || overlay.nodes[to];
        if (!nodeFrom || !nodeTo) return;
        const dist = haversine(nodeFrom, nodeTo);

        if (!overlay.adj[from]) overlay.adj[from] = [];
        overlay.adj[from].push({
          targetId: to,
          distance: dist,
          name: origEdge.name,
          highway: origEdge.highway,
          wayId: origEdge.wayId,
        });

        if (!overlay.rev[to]) overlay.rev[to] = [];
        overlay.rev[to].push({
          targetId: from,
          distance: dist,
          name: origEdge.name,
          highway: origEdge.highway,
          wayId: origEdge.wayId,
        });
      };

      if (origEdgeUV) {
        overlay.removedEdges.add(`${u}->${v}`);
      }
      if (origEdgeVU) {
        overlay.removedEdges.add(`${v}->${u}`);
      }

      for (let i = 0; i < chain.length - 1; i++) {
        const from = chain[i];
        const to = chain[i + 1];
        addChainEdge(from, to, origEdgeUV);
        addChainEdge(to, from, origEdgeVU);
      }
    }

    return overlay;
  }

  dijkstra(startNodeId, endNodeId = null, excludedEdges = new Set(), isReverse = false, overlay = null) {
    if (!overlay) overlay = { nodes: {}, adj: {}, rev: {}, removedEdges: new Set() };
    startNodeId = String(startNodeId);
    if (endNodeId) endNodeId = String(endNodeId);

    const baseAdjList = isReverse ? this.reverseAdjacency : this.adjacency;
    const overlayAdjList = isReverse ? overlay.rev : overlay.adj;

    const distances = {};
    const previous = {};
    const pq = new MinHeap();

    distances[startNodeId] = 0;
    pq.push({ p: 0, id: startNodeId });

    while (pq.size > 0) {
      const { id: currentId, p: currentDist } = pq.pop();
      const knownDist = distances[currentId] ?? Infinity;
      if (currentDist > knownDist) continue;
      if (endNodeId && currentId === endNodeId) break;

      const baseEdges = baseAdjList[currentId] || [];
      const overEdges = overlayAdjList[currentId] || [];
      const neighbors = [...baseEdges, ...overEdges];

      for (const edge of neighbors) {
        const edgeKey = isReverse ? `${edge.targetId}->${currentId}` : `${currentId}->${edge.targetId}`;

        if (excludedEdges.has(edgeKey) || overlay.removedEdges.has(edgeKey)) continue;

        const newDist = currentDist + edge.distance;
        const targetDist = distances[edge.targetId] ?? Infinity;
        if (newDist < targetDist) {
          distances[edge.targetId] = newDist;
          previous[edge.targetId] = currentId;
          pq.push({ p: newDist, id: edge.targetId });
        }
      }
    }

    if (endNodeId) {
      const finalDist = distances[endNodeId] ?? Infinity;
      if (finalDist === Infinity) {
        return { distance: Infinity, path: [] };
      }
      const path = [];
      let curr = endNodeId;
      while (curr !== undefined) {
        path.push(parseNodeId(curr));
        if (curr === startNodeId) break;
        curr = previous[curr];
      }
      return {
        distance: finalDist,
        path: isReverse ? path : path.reverse(),
      };
    }

    return { distances, previous };
  }

  reconstructForwardPath(previous, start, end) {
    start = String(start);
    end = String(end);
    const path = [];
    let curr = end;
    while (curr !== undefined) {
      path.push(parseNodeId(curr));
      if (String(curr) === start) break;
      curr = previous[curr];
    }
    if (path.length === 0 || String(path[path.length - 1]) !== start) return [];
    return path.reverse();
  }

  reconstructReversePath(previous, start, end) {
    start = String(start);
    end = String(end);
    const path = [];
    let curr = start;
    while (curr !== undefined) {
      path.push(parseNodeId(curr));
      if (String(curr) === end) break;
      curr = previous[curr];
    }
    if (path.length === 0 || String(path[path.length - 1]) !== end) return [];
    return path;
  }

  findDetourPath(startNodeId, endNodeId, targetDistance, excludedEdges = new Set(), overlay = null) {
    if (!overlay) overlay = { nodes: {}, adj: {}, rev: {}, removedEdges: new Set() };
    startNodeId = String(startNodeId);
    endNodeId = String(endNodeId);
    const resFromStart = this.dijkstra(startNodeId, null, excludedEdges, false, overlay);
    const resToEnd = this.dijkstra(endNodeId, null, excludedEdges, true, overlay);

    const candidates = [];
    const allNodeIds = [...Object.keys(this.nodes), ...Object.keys(overlay.nodes)];

    for (const nodeId of allNodeIds) {
      const d1 = resFromStart.distances[nodeId];
      const d2 = resToEnd.distances[nodeId];

      if (d1 !== undefined && d1 !== Infinity && d2 !== undefined && d2 !== Infinity) {
        const totalDist = d1 + d2;
        if (totalDist >= targetDistance) {
          candidates.push({
            nodeId: parseNodeId(nodeId),
            d1,
            d2,
            totalDist,
          });
        }
      }
    }

    if (candidates.length === 0) {
      const fallbackFromStart = this.dijkstra(startNodeId, null, new Set(), false, overlay);
      const fallbackToEnd = this.dijkstra(endNodeId, null, new Set(), true, overlay);

      for (const nodeId of allNodeIds) {
        const d1 = fallbackFromStart.distances[nodeId];
        const d2 = fallbackToEnd.distances[nodeId];

        if (d1 !== undefined && d1 !== Infinity && d2 !== undefined && d2 !== Infinity) {
          const totalDist = d1 + d2;
          if (totalDist >= targetDistance) {
            candidates.push({
              nodeId: parseNodeId(nodeId),
              d1,
              d2,
              totalDist,
              fallback: true,
            });
          }
        }
      }
    }

    if (candidates.length === 0) {
      const shortestDirect = this.dijkstra(startNodeId, endNodeId, excludedEdges, false, overlay);
      if (shortestDirect.distance !== Infinity) {
        return shortestDirect;
      }
      return this.dijkstra(startNodeId, endNodeId, new Set(), false, overlay);
    }

    candidates.sort((a, b) => a.totalDist - b.totalDist);
    const topCandidates = candidates.slice(0, 30);

    const activeFromStart = candidates[0].fallback ? this.dijkstra(startNodeId, null, new Set(), false, overlay) : resFromStart;
    const activeToEnd = candidates[0].fallback ? this.dijkstra(endNodeId, null, new Set(), true, overlay) : resToEnd;

    let bestCandidate = null;
    let bestScore = Infinity;
    let bestPath = [];

    for (const cand of topCandidates) {
      const path1 = this.reconstructForwardPath(activeFromStart.previous, startNodeId, cand.nodeId);
      const path2 = this.reconstructReversePath(activeToEnd.previous, cand.nodeId, endNodeId);

      if (path1.length === 0 || path2.length === 0) continue;

      const set1 = new Set(path1.slice(1, -1));
      let overlapCount = 0;
      for (let i = 1; i < path2.length - 1; i++) {
        if (set1.has(path2[i])) overlapCount++;
      }

      const score = cand.totalDist + overlapCount * 2000;

      if (score < bestScore) {
        bestScore = score;
        bestCandidate = cand;
        bestPath = [...path1, ...path2.slice(1)];
      }
    }

    if (bestCandidate) {
      return {
        distance: bestCandidate.totalDist,
        path: bestPath,
      };
    }

    const ultimateFallback = this.dijkstra(startNodeId, endNodeId, excludedEdges, false, overlay);
    if (ultimateFallback.distance !== Infinity) {
      return ultimateFallback;
    }
    return this.dijkstra(startNodeId, endNodeId, new Set(), false, overlay);
  }

  aStar(startNodeId, endNodeId, overlay = null) {
    if (!overlay) overlay = { nodes: {}, adj: {}, rev: {}, removedEdges: new Set() };
    startNodeId = String(startNodeId);
    endNodeId = String(endNodeId);

    const startNode = this.nodes[startNodeId] || overlay.nodes[startNodeId];
    if (startNodeId === endNodeId) {
      if (!startNode) return null;
      return { coords: [[startNode.lat, startNode.lon]], distance: 0, path: [parseNodeId(startNodeId)] };
    }
    const endNode = this.nodes[endNodeId] || overlay.nodes[endNodeId];
    if (!endNode) return null;

    const h = (nodeId) => {
      const n = this.nodes[nodeId] || overlay.nodes[nodeId];
      return n ? haversine(n, endNode) : 0;
    };

    const gScore = { [startNodeId]: 0 };
    const previous = {};
    const visited = new Set();
    const pq = new MinHeap();
    pq.push({ p: h(startNodeId), id: startNodeId });

    while (pq.size > 0) {
      const { id: currentId } = pq.pop();
      if (currentId === endNodeId) break;
      if (visited.has(currentId)) continue;
      visited.add(currentId);

      const g = gScore[currentId];
      const baseEdges = this.adjacency[currentId] || [];
      const overEdges = overlay.adj[currentId] || [];

      for (const edge of [...baseEdges, ...overEdges]) {
        if (overlay.removedEdges.has(`${currentId}->${edge.targetId}`)) continue;

        if (visited.has(edge.targetId)) continue;
        const ng = g + edge.distance;
        if (ng < (gScore[edge.targetId] ?? Infinity)) {
          gScore[edge.targetId] = ng;
          previous[edge.targetId] = currentId;
          pq.push({ p: ng + h(edge.targetId), id: edge.targetId });
        }
      }
    }

    if (gScore[endNodeId] === undefined) return null;

    const coords = [];
    const path = [];
    let cur = endNodeId;
    while (cur !== undefined) {
      const n = this.nodes[cur] || overlay.nodes[cur];
      if (n) {
        coords.unshift([n.lat, n.lon]);
        path.unshift(parseNodeId(cur));
      }
      cur = previous[cur];
    }

    return { coords, path, distance: gScore[endNodeId] };
  }

  getPathCoords(nodeIds, overlay = null) {
    if (!overlay) overlay = { nodes: {} };
    return nodeIds
      .map((id) => this.nodes[id] || overlay.nodes[id])
      .filter((n) => n !== undefined)
      .map((n) => [n.lat, n.lon]);
  }

  generateSVG(width = 1200, height = 900, routeData = null) {
    const { project, toSvgCoords, roadsByClass, sortedClasses } = this._prepareSVGData(width, height);

    let roadsSvg = "";
    for (const roadClass of sortedClasses) {
      const roads = roadsByClass[roadClass] || [];
      if (roads.length === 0) continue;
      roadsSvg += `  <g class="road-group road-group-${roadClass}">\n`;
      for (const road of roads) {
        roadsSvg += `    <path d="${road.d}" class="road road-${roadClass}" data-name="${road.name}"/>\n`;
      }
      roadsSvg += `  </g>\n`;
    }

    const getProjectedNode = (id) => {
      let pNode = project[id];
      if (!pNode && typeof id === "string" && id.startsWith("virtual_")) {
        const parts = id.split("_");
        if (parts.length >= 3) {
          const lat = parseFloat(parts[1]);
          const lon = parseFloat(parts[2]);
          if (!isNaN(lat) && !isNaN(lon)) {
            pNode = this._project(lat, lon);
          }
        }
      }
      return pNode;
    };

    let routeSvg = "";
    if (routeData && routeData.legs) {
      routeSvg += `  <!-- Route Overlay -->\n  <g class="route-overlay">\n`;
      for (let i = 0; i < routeData.legs.length; i++) {
        const leg = routeData.legs[i];
        const isSegment = leg.type === "segment";

        let d = "";
        let active = false;
        for (const nodeId of leg.path) {
          const pNode = getProjectedNode(nodeId);
          if (!pNode) continue;
          const { x, y } = toSvgCoords(pNode.x, pNode.y);
          d += `${!active ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)} `;
          active = true;
        }

        if (d) {
          const strokeColor = isSegment ? "#FF5722" : "#2196F3";
          const strokeWidth = isSegment ? "5" : "3.5";
          const dashArray = isSegment ? "none" : "6,4";
          const legName = isSegment ? `Segment: ${leg.name}` : `Rest Period (${(leg.distance / 1000).toFixed(2)} km)`;

          routeSvg += `    <path d="${d.trim()}" stroke="${strokeColor}" stroke-width="${strokeWidth}" stroke-dasharray="${dashArray}" fill="none" stroke-linecap="round" stroke-linejoin="round" class="route-leg" data-leg="${escapeHtml(legName)}">\n`;
          routeSvg += `      <title>${escapeHtml(legName)}</title>\n`;
          routeSvg += `    </path>\n`;
        }
      }
      routeSvg += `  </g>\n  <!-- Route Markers -->\n  <g class="route-markers">\n`;
      let markerNum = 1;
      for (const leg of routeData.legs) {
        if (leg.type === "segment") {
          const startNodeId = leg.path[0];
          const endNodeId = leg.path[leg.path.length - 1];
          const pStart = getProjectedNode(startNodeId);
          const pEnd = getProjectedNode(endNodeId);

          if (pStart) {
            const { x, y } = toSvgCoords(pStart.x, pStart.y);
            routeSvg += `    <g class="marker marker-start" transform="translate(${x.toFixed(1)}, ${y.toFixed(1)})">\n`;
            routeSvg += `      <circle r="12" fill="#E65100" stroke="#FFFFFF" stroke-width="2"/>\n`;
            routeSvg += `      <text y="4" text-anchor="middle" fill="#FFFFFF" font-family="system-ui, sans-serif" font-weight="bold" font-size="10">${markerNum}S</text>\n`;
            routeSvg += `      <title>Start of Segment: ${escapeHtml(leg.name)}</title>\n`;
            routeSvg += `    </g>\n`;
          }

          if (pEnd) {
            const { x, y } = toSvgCoords(pEnd.x, pEnd.y);
            routeSvg += `    <g class="marker marker-end" transform="translate(${x.toFixed(1)}, ${y.toFixed(1)})">\n`;
            routeSvg += `      <circle r="12" fill="#FF5722" stroke="#FFFFFF" stroke-width="2"/>\n`;
            routeSvg += `      <text y="4" text-anchor="middle" fill="#FFFFFF" font-family="system-ui, sans-serif" font-weight="bold" font-size="10">${markerNum}E</text>\n`;
            routeSvg += `      <title>End of Segment: ${escapeHtml(leg.name)}</title>\n`;
            routeSvg += `    </g>\n`;
          }
          markerNum++;
        }
      }
      routeSvg += `  </g>\n`;
    }

    return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" height="100%">
  <style>
    svg { background-color: #f5f5f5; }
    .road { fill: none; stroke: #cccccc; stroke-width: 1.2; stroke-linecap: round; stroke-linejoin: round; }
    .road-motorway, .road-motorway_link { stroke: #999999; stroke-width: 2.2; }
    .road-trunk, .road-trunk_link { stroke: #aaaaaa; stroke-width: 2.0; }
    .road-primary, .road-primary_link { stroke: #bbbbbb; stroke-width: 1.8; }
    .road-secondary, .road-secondary_link { stroke: #cccccc; stroke-width: 1.5; }
    .road-tertiary, .road-tertiary_link { stroke: #dddddd; stroke-width: 1.3; }
    .road-residential, .road-living_street { stroke: #eeeeee; stroke-dasharray: none; }
    .road-service { stroke: #f0f0f0; stroke-width: 0.9; }
    .road-cycleway { stroke: #00796B; stroke-width: 1.0; stroke-dasharray: 2,3; }
    .road:hover { stroke: #888888; cursor: pointer; }
    .route-leg:hover { stroke-width: 7; cursor: help; }
  </style>
  <!-- Base Road Network -->
  <g class="road-network">
${roadsSvg}  </g>
${routeSvg}</svg>`;
  }

  _prepareSVGData(width, height) {
    const project = {};
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;

    for (const [id, node] of Object.entries(this.nodes)) {
      const { x, y } = this._project(node.lat, node.lon);
      project[id] = { x, y };
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }

    const mapWidth = maxX - minX;
    const mapHeight = maxY - minY;
    const scale = Math.min(width / mapWidth, height / mapHeight);
    const xOffset = (width - mapWidth * scale) / 2;
    const yOffset = (height - mapHeight * scale) / 2;

    const toSvgCoords = (x, y) => ({
      x: xOffset + (x - minX) * scale,
      y: height - (yOffset + (y - minY) * scale),
    });

    const roadsByClass = {};
    for (const way of this.ways) {
      const roadClass = way.tags?.highway || "residential";
      if (!roadsByClass[roadClass]) roadsByClass[roadClass] = [];

      let d = "";
      let active = false;
      for (let i = 0; i < way.nodes.length; i++) {
        const pNode = project[way.nodes[i]];
        if (!pNode) continue;
        const { x, y } = toSvgCoords(pNode.x, pNode.y);
        d += `${!active ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)} `;
        active = true;
      }
      if (d) {
        roadsByClass[roadClass].push({
          d: d.trim(),
          name: escapeHtml(way.tags?.name || ""),
        });
      }
    }

    const sortedClasses = [
      "service",
      "residential",
      "living_street",
      "unclassified",
      "tertiary",
      "tertiary_link",
      "secondary",
      "secondary_link",
      "primary",
      "primary_link",
      "trunk",
      "trunk_link",
      "motorway",
      "motorway_link",
      "cycleway",
    ];

    return { project, toSvgCoords, roadsByClass, sortedClasses };
  }

  _project(lat, lon) {
    const x = lon;
    const y = Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) / (Math.PI / 180);
    return { x, y };
  }
}

function escapeHtml(unsafe) {
  return unsafe.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

module.exports = { Graph, MinHeap, SpatialIndex };
