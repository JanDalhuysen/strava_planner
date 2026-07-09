// Application State
const state = {
  cityKey: null,
  cityName: "",
  cityBbox: null,
  ways: [], // All roads in the city
  segments: [], // [{ name, startNode, endNode, coords, distance, path }]
  routeLegs: [], // Stitched legs of the generated route

  // Selection state when drawing a segment
  isDrawing: false,
  drawStep: "start", // 'start' or 'end'
  tempStartNode: null,
  tempEndNode: null,
  tempPathCoords: [],
  tempPathNodes: [],
  tempDistance: 0,

  // Map layers
  roadsLayerGroup: null,
  segmentsLayerGroup: null,
  routeLayerGroup: null,
  tempLayerGroup: null,

  // Map markers
  startMarker: null,
  endMarker: null,
};

let map;

// Initialize the Application
document.addEventListener("DOMContentLoaded", () => {
  // Initialize Lucide Icons
  lucide.createIcons();

  // Initialize Map
  initMap();

  // Bind UI Events
  setupEventListeners();
});

// Initialize Leaflet Map
function initMap() {
  map = L.map("map", {
    zoomControl: true,
    attributionControl: true,
  }).setView([-33.96, 18.83], 12);

  // Light map tiles (OSM standard)
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  }).addTo(map);

  // Create layer groups to manage layers easily
  state.roadsLayerGroup = L.layerGroup().addTo(map);
  state.segmentsLayerGroup = L.layerGroup().addTo(map);
  state.routeLayerGroup = L.layerGroup().addTo(map);
  state.tempLayerGroup = L.layerGroup().addTo(map);
}

// Bind UI event listeners
function setupEventListeners() {
  const citySearchInput = document.getElementById("city-search-input");
  const citySearchBtn = document.getElementById("city-search-btn");
  const searchResults = document.getElementById("search-results");

  citySearchBtn.addEventListener("click", performCitySearch);
  citySearchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") performCitySearch();
  });

  document.addEventListener("click", (e) => {
    if (!citySearchInput.contains(e.target) && !searchResults.contains(e.target)) {
      searchResults.classList.add("hidden");
    }
  });

  const btnDrawSegment = document.getElementById("btn-draw-segment");
  const btnCancelDraw = document.getElementById("btn-cancel-draw");

  btnDrawSegment.addEventListener("click", startSegmentDrawing);
  btnCancelDraw.addEventListener("click", cancelSegmentDrawing);

  map.on("click", handleMapClick);

  const restSlider = document.getElementById("rest-distance");
  const restSliderVal = document.getElementById("rest-distance-val");
  restSlider.addEventListener("input", (e) => {
    restSliderVal.textContent = parseFloat(e.target.value).toFixed(1);
  });

  const btnGenerateRoute = document.getElementById("btn-generate-route");
  btnGenerateRoute.addEventListener("click", generateRoute);

  document.getElementById("btn-download-gpx").addEventListener("click", downloadGPX);
  document.getElementById("btn-download-svg").addEventListener("click", downloadSVG);
}

// Show Toast message
function showToast(message, isError = false) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.className = "toast";
  if (isError) toast.classList.add("error");
  toast.classList.remove("hidden");

  setTimeout(() => {
    toast.classList.add("hidden");
  }, 4000);
}

// Show / Hide loading spinner
function setLoading(isLoading, text = "Loading...") {
  const loader = document.getElementById("loading-overlay");
  const loaderText = document.getElementById("loading-text");
  loaderText.textContent = text;

  if (isLoading) {
    loader.classList.remove("hidden");
  } else {
    loader.classList.add("hidden");
  }
}

// Search for cities using Nominatim Geocoder via the Server
async function performCitySearch() {
  const query = document.getElementById("city-search-input").value.trim();
  if (!query) return;

  setLoading(true, "Searching for city...");
  const searchResults = document.getElementById("search-results");
  searchResults.innerHTML = "";
  searchResults.classList.add("hidden");

  try {
    const res = await fetch(`/api/cities/search?q=${encodeURIComponent(query)}`);
    if (!res.ok) throw new Error("Search failed. Nominatim service might be temporarily unavailable.");

    const cities = await res.json();
    setLoading(false);

    if (cities.length === 0) {
      showToast("No cities found with that name.", true);
      return;
    }

    cities.forEach((city) => {
      const item = document.createElement("div");
      item.className = "search-result-item";

      const nameParts = city.displayName.split(",");
      const title = nameParts[0] + (nameParts[1] ? `, ${nameParts[1]}` : "");
      const subtitle = nameParts.slice(2).join(",").trim();

      item.innerHTML = `
        <span class="result-title">${title}</span>
        <span class="result-subtitle">${subtitle || city.displayName}</span>
      `;

      item.addEventListener("click", () => selectCity(city));
      searchResults.appendChild(item);
    });

    searchResults.classList.remove("hidden");
  } catch (err) {
    setLoading(false);
    showToast(err.message, true);
  }
}

// Select a city and request its road network
async function selectCity(city) {
  document.getElementById("search-results").classList.add("hidden");
  document.getElementById("city-search-input").value = city.displayName.split(",")[0];

  const bbox = city.bbox;
  const cityName = city.displayName.split(",")[0];

  setLoading(true, `Downloading roads for ${cityName}...`);

  try {
    const url = `/api/cities/load?osmType=${city.osmType}&osmId=${city.osmId}&south=${bbox.minLat}&north=${bbox.maxLat}&west=${bbox.minLon}&east=${bbox.maxLon}&cityName=${encodeURIComponent(cityName)}`;
    const res = await fetch(url);
    if (!res.ok) {
      const errData = await res.json();
      throw new Error(errData.error || "Failed to download roads.");
    }
    const data = await res.json();

    // Update global state
    state.cityKey = data.cityKey;
    state.cityName = cityName;
    state.cityBbox = bbox;
    state.ways = data.ways;
    state.segments = [];
    state.routeLegs = [];

    // Reset layers
    state.roadsLayerGroup.clearLayers();
    state.segmentsLayerGroup.clearLayers();
    state.routeLayerGroup.clearLayers();
    state.tempLayerGroup.clearLayers();

    // Render the road network on map
    renderRoadNetwork();

    // Zoom to city bounds
    map.fitBounds([
      [bbox.minLat, bbox.minLon],
      [bbox.maxLat, bbox.maxLon],
    ]);

    // Update UI Stats
    document.getElementById("loaded-city-name").textContent = cityName;
    document.getElementById("node-count").textContent = data.nodeCount.toLocaleString();
    document.getElementById("way-count").textContent = data.wayCount.toLocaleString();

    document.getElementById("city-status").classList.remove("hidden");

    // Enable Segment Planner section
    document.getElementById("section-planner").classList.remove("disabled");
    document.getElementById("section-results").classList.add("hidden");

    updateSegmentsList();

    setLoading(false);
    showToast(`Loaded ${data.ways.length} roads! You can now mark your segments.`);
  } catch (error) {
    console.error("[cities/load]", error);
    setLoading(false);
    showToast(error.message, true);
  }
}

// Render the city roads as background polylines on the Leaflet Canvas
function renderRoadNetwork() {
  const canvasRenderer = L.canvas({ padding: 0.2 });

  state.ways.forEach((way) => {
    L.polyline(way.coords, {
      color: "#1c1c24", // Subtle road color
      weight: 1.5,
      opacity: 0.8,
      renderer: canvasRenderer,
      interactive: false,
    }).addTo(state.roadsLayerGroup);
  });
}

// Start Segment Drawing Mode
function startSegmentDrawing() {
  state.isDrawing = true;
  state.drawStep = "start";
  state.tempStartNode = null;
  state.tempEndNode = null;
  state.tempPathCoords = [];
  state.tempPathNodes = [];
  state.tempDistance = 0;

  state.tempLayerGroup.clearLayers();

  document.getElementById("btn-draw-segment").classList.add("hidden");
  const banner = document.getElementById("draw-instructions");
  banner.classList.remove("hidden");

  document.getElementById("draw-status-text").innerHTML = '<i data-lucide="map-pin"></i> Click on the map to set the Segment <strong>START</strong> point';
  lucide.createIcons();
  map.getContainer().style.cursor = "crosshair";

  // Create hover marker and guide line for selection guidance
  state.hoverMarker = L.marker([0, 0], {
    icon: L.divIcon({ className: "hidden-marker-icon", html: "", iconSize: [0, 0] }),
    interactive: false,
  }).addTo(state.tempLayerGroup);

  state.hoverMarker.bindTooltip("Click to set START point", {
    permanent: true,
    direction: "right",
    className: "guide-tooltip",
    offset: [10, 0],
  });

  state.guideLine = L.polyline([], {
    color: "#fc4c02",
    weight: 2,
    dashArray: "5, 8",
    opacity: 0.6,
    interactive: false,
  }).addTo(state.tempLayerGroup);

  map.on("mousemove", handleMapMouseMove);

  showToast("Drawing mode active. Click any point along a street.");
}

// Handle Mouse Move during drawing to update guidelines and tooltips
function handleMapMouseMove(e) {
  if (!state.isDrawing || !state.hoverMarker) return;

  state.hoverMarker.setLatLng(e.latlng);

  if (state.drawStep === "end" && state.tempStartNode) {
    state.guideLine.setLatLngs([[state.tempStartNode.lat, state.tempStartNode.lon], e.latlng]);
  }
}

// Cancel Segment Drawing Mode
function cancelSegmentDrawing() {
  state.isDrawing = false;

  map.off("mousemove", handleMapMouseMove);
  state.hoverMarker = null;
  state.guideLine = null;

  state.tempLayerGroup.clearLayers();

  document.getElementById("btn-draw-segment").classList.remove("hidden");
  document.getElementById("draw-instructions").classList.add("hidden");
  map.getContainer().style.cursor = "";

  showToast("Segment drawing cancelled.");
}

// Map Click Handler
async function handleMapClick(e) {
  if (!state.isDrawing) return;

  const { lat, lng } = e.latlng;
  setLoading(true, "Finding nearest road point...");

  try {
    const res = await fetch("/api/planner/nearest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cityKey: state.cityKey,
        lat,
        lon: lng,
      }),
    });

    if (!res.ok) throw new Error("Could not find a road near this point.");
    const node = await res.json();
    setLoading(false);

    if (state.drawStep === "start") {
      state.tempStartNode = node;

      // Place start marker
      L.circleMarker([node.lat, node.lon], {
        radius: 8,
        fillColor: "#fc4c02",
        color: "#ffffff",
        weight: 2,
        fillOpacity: 1,
      })
        .bindTooltip("Segment Start Point", { permanent: false })
        .addTo(state.tempLayerGroup);

      state.drawStep = "end";
      document.getElementById("draw-status-text").innerHTML = '<i data-lucide="flag"></i> Click on the map to set the Segment <strong>END</strong> point';
      lucide.createIcons();

      // Update hover tooltip for end selection
      if (state.hoverMarker) {
        state.hoverMarker.setTooltipContent("Click to set END point");
      }

      showToast("Start point set. Now click on the map to set the End point.");
    } else if (state.drawStep === "end") {
      state.tempEndNode = node;

      // Place end marker
      L.circleMarker([node.lat, node.lon], {
        radius: 8,
        fillColor: "#ff8a50",
        color: "#ffffff",
        weight: 2,
        fillOpacity: 1,
      })
        .bindTooltip("Segment End Point", { permanent: false })
        .addTo(state.tempLayerGroup);

      setLoading(true, "Calculating shortest route...");

      // Request path between start and end nodes
      const pathRes = await fetch("/api/planner/path", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cityKey: state.cityKey,
          startNode: state.tempStartNode,
          endNode: state.tempEndNode,
        }),
      });

      setLoading(false);

      if (!pathRes.ok) {
        throw new Error("Could not find a continuous road route between these two points. Try different locations.");
      }

      const pathData = await pathRes.json();

      state.tempPathCoords = pathData.coords;
      state.tempPathNodes = pathData.path;
      state.tempDistance = pathData.distance;

      // Render preview path
      L.polyline(pathData.coords, {
        color: "#fc4c02",
        weight: 5,
        opacity: 0.8,
      }).addTo(state.tempLayerGroup);

      // Confirm segment addition
      const segName = `Segment ${state.segments.length + 1}`;
      saveCurrentSegment(segName);
    }
  } catch (err) {
    setLoading(false);
    showToast(err.message, true);
    // Keep in same drawing step so user can try clicking again
  }
}

// Save the drawn segment
function saveCurrentSegment(name) {
  const newSegment = {
    name,
    startNode: state.tempStartNode,
    endNode: state.tempEndNode,
    coords: state.tempPathCoords,
    path: state.tempPathNodes,
    distance: state.tempDistance,
  };

  state.segments.push(newSegment);

  map.off("mousemove", handleMapMouseMove);
  state.hoverMarker = null;
  state.guideLine = null;

  // Clear temporary layers
  state.tempLayerGroup.clearLayers();

  // Redraw permanent segments
  drawAllSegments();

  // Update list
  updateSegmentsList();

  // Exit drawing mode
  state.isDrawing = false;
  document.getElementById("btn-draw-segment").classList.remove("hidden");
  document.getElementById("draw-instructions").classList.add("hidden");
  map.getContainer().style.cursor = "";

  showToast(`Added segment: "${name}" (${(newSegment.distance / 1000).toFixed(2)} km)`);
}

// Redraw all saved segments on the map
function drawAllSegments() {
  state.segmentsLayerGroup.clearLayers();

  state.segments.forEach((seg, index) => {
    // Draw the path
    L.polyline(seg.coords, {
      color: "#fc4c02",
      weight: 5,
      opacity: 0.9,
      dashArray: null,
    })
      .bindTooltip(`Segment ${index + 1}: ${seg.name}`, { sticky: true })
      .addTo(state.segmentsLayerGroup);

    // Start Marker (Green Circle)
    L.circleMarker([seg.startNode.lat, seg.startNode.lon], {
      radius: 6,
      fillColor: "#fc4c02",
      color: "#ffffff",
      weight: 2,
      fillOpacity: 1,
    })
      .bindPopup(`<b>${seg.name} Start</b>`)
      .addTo(state.segmentsLayerGroup);

    // End Marker (Dark Red Circle)
    L.circleMarker([seg.endNode.lat, seg.endNode.lon], {
      radius: 6,
      fillColor: "#bf360c",
      color: "#ffffff",
      weight: 2,
      fillOpacity: 1,
    })
      .bindPopup(`<b>${seg.name} End</b>`)
      .addTo(state.segmentsLayerGroup);
  });

  // Re-create icons for the new elements
  lucide.createIcons();
}

// Update the segment cards in the sidebar
function updateSegmentsList() {
  const list = document.getElementById("segments-list");
  list.innerHTML = "";

  if (state.segments.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <i data-lucide="map-pin" class="empty-icon"></i>
        <p>No segments added yet. Click "Mark New Segment" above to select a section of street on the map.</p>
      </div>
    `;
    lucide.createIcons();
    return;
  }

  state.segments.forEach((seg, idx) => {
    const card = document.createElement("div");
    card.className = "segment-card";

    card.innerHTML = `
      <div class="segment-card-header">
        <div class="segment-title-group">
          <span class="segment-number">${idx + 1}</span>
          <input type="text" class="segment-name" value="${seg.name}" data-index="${idx}">
        </div>
        <div class="segment-card-actions">
          <button class="icon-btn btn-reverse" title="Reverse segment direction" data-index="${idx}">
            <i data-lucide="arrow-left-right" style="width: 14px; height: 14px;"></i>
          </button>
          <button class="icon-btn btn-up" title="Move Up" data-index="${idx}" ${idx === 0 ? 'disabled style="opacity: 0.3;"' : ""}>
            <i data-lucide="chevron-up" style="width: 14px; height: 14px;"></i>
          </button>
          <button class="icon-btn btn-down" title="Move Down" data-index="${idx}" ${idx === state.segments.length - 1 ? 'disabled style="opacity: 0.3;"' : ""}>
            <i data-lucide="chevron-down" style="width: 14px; height: 14px;"></i>
          </button>
          <button class="icon-btn icon-btn-delete btn-delete" title="Delete segment" data-index="${idx}">
            <i data-lucide="trash-2" style="width: 14px; height: 14px;"></i>
          </button>
        </div>
      </div>
      <div class="segment-card-body">
        <div class="segment-direction">
          <i data-lucide="navigation-2" style="width: 12px; height: 12px; transform: rotate(45deg);"></i>
          <span>Directed effort</span>
        </div>
        <span class="segment-distance">${(seg.distance / 1000).toFixed(2)} km</span>
      </div>
    `;

    list.appendChild(card);
  });

  list.querySelectorAll(".segment-name").forEach((input) => {
    input.addEventListener("change", (e) => {
      const idx = parseInt(e.target.dataset.index);
      state.segments[idx].name = e.target.value;
      drawAllSegments();
    });
  });

  list.querySelectorAll(".btn-reverse").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const idx = parseInt(e.currentTarget.dataset.index);
      reverseSegment(idx);
    });
  });

  list.querySelectorAll(".btn-up").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const idx = parseInt(e.currentTarget.dataset.index);
      moveSegment(idx, -1);
    });
  });

  list.querySelectorAll(".btn-down").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const idx = parseInt(e.currentTarget.dataset.index);
      moveSegment(idx, 1);
    });
  });

  list.querySelectorAll(".btn-delete").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const idx = parseInt(e.currentTarget.dataset.index);
      deleteSegment(idx);
    });
  });

  lucide.createIcons();
}

// Reverse the direction of a segment
async function reverseSegment(idx) {
  const seg = state.segments[idx];
  setLoading(true, `Reversing segment: ${seg.name}...`);

  try {
    const tempNode = seg.startNode;
    const res = await fetch("/api/planner/path", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cityKey: state.cityKey,
        startNode: seg.endNode,
        endNode: tempNode,
      }),
    });

    setLoading(false);
    if (!res.ok) throw new Error("Could not find a path in the opposite direction (might be oneway restrictions).");

    const pathData = await res.json();

    seg.startNode = seg.endNode;
    seg.endNode = tempNode;
    seg.coords = pathData.coords;
    seg.path = pathData.path;
    seg.distance = pathData.distance;

    drawAllSegments();
    updateSegmentsList();
    showToast(`Reversed direction of segment: "${seg.name}"`);
  } catch (err) {
    setLoading(false);
    showToast(err.message, true);
  }
}

// Move a segment up or down in the sequence
function moveSegment(idx, offset) {
  const targetIdx = idx + offset;
  if (targetIdx < 0 || targetIdx >= state.segments.length) return;

  const temp = state.segments[idx];
  state.segments[idx] = state.segments[targetIdx];
  state.segments[targetIdx] = temp;

  drawAllSegments();
  updateSegmentsList();
}

// Delete a segment
function deleteSegment(idx) {
  const name = state.segments[idx].name;
  state.segments.splice(idx, 1);

  drawAllSegments();
  updateSegmentsList();
  showToast(`Deleted segment: "${name}"`);
}

// Call server to generate final route with segment efforts and detour rest periods
async function generateRoute() {
  if (state.segments.length === 0) {
    showToast("Please add at least one segment first.", true);
    return;
  }

  const restKm = parseFloat(document.getElementById("rest-distance").value);
  const restMeters = restKm * 1000;

  setLoading(true, "Synthesizing route with easy riding rest intervals...");

  try {
    const payload = {
      cityKey: state.cityKey,
      segments: state.segments.map((seg) => ({
        name: seg.name,
        startNode: seg.startNode,
        endNode: seg.endNode,
      })),
      restDistanceMeters: restMeters,
    };

    const res = await fetch("/api/planner/route", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    setLoading(false);

    if (!res.ok) throw new Error(data.error || "Failed to generate route.");

    state.routeLegs = data.legs;

    renderRoute(data.legs);

    document.getElementById("stat-total-dist").textContent = `${(data.totalDistance / 1000).toFixed(2)} km`;
    document.getElementById("stat-segment-dist").textContent = `${(data.totalSegmentDistance / 1000).toFixed(2)} km`;
    document.getElementById("stat-rest-dist").textContent = `${(data.totalRestDistance / 1000).toFixed(2)} km`;
    document.getElementById("stat-rest-count").textContent = data.legs.filter((l) => l.type === "rest").length;

    document.getElementById("section-results").classList.remove("hidden");

    showToast("Route generated successfully! Check map and stats.");
  } catch (err) {
    setLoading(false);
    showToast(err.message, true);
  }
}

// Render the final route onto the map
function renderRoute(legs) {
  state.segmentsLayerGroup.clearLayers();
  state.routeLayerGroup.clearLayers();

  const bounds = L.latLngBounds();
  let segmentIndex = 1;

  legs.forEach((leg) => {
    const isSegment = leg.type === "segment";

    leg.coords.forEach((coord) => bounds.extend(coord));

    L.polyline(leg.coords, {
      color: isSegment ? "#fc4c02" : "#2196f3",
      weight: isSegment ? 6 : 3.5,
      opacity: 0.95,
      dashArray: isSegment ? null : "8, 6",
      lineCap: "round",
      lineJoin: "round",
    })
      .bindTooltip(isSegment ? `<b>Segment effort:</b> ${leg.name}` : `<b>Rest section:</b> ${(leg.distance / 1000).toFixed(2)} km`, { sticky: true })
      .addTo(state.routeLayerGroup);

    if (isSegment) {
      const startCoord = leg.coords[0];
      const endCoord = leg.coords[leg.coords.length - 1];

      L.marker(startCoord, {
        icon: L.divIcon({
          className: "custom-div-icon",
          html: `<div class="marker-pill start-pill">${segmentIndex}S</div>`,
          iconSize: [26, 26],
          iconAnchor: [13, 13],
        }),
      })
        .bindPopup(`<b>Start of segment: ${leg.name}</b>`)
        .addTo(state.routeLayerGroup);

      L.marker(endCoord, {
        icon: L.divIcon({
          className: "custom-div-icon",
          html: `<div class="marker-pill end-pill">${segmentIndex}E</div>`,
          iconSize: [26, 26],
          iconAnchor: [13, 13],
        }),
      })
        .bindPopup(`<b>End of segment: ${leg.name}</b>`)
        .addTo(state.routeLayerGroup);

      segmentIndex++;
    }
  });

  map.fitBounds(bounds, { padding: [50, 50] });
}

// Download the GPX File
async function downloadGPX() {
  if (state.routeLegs.length === 0) return;

  setLoading(true, "Generating GPX file...");

  try {
    const res = await fetch("/api/exports/gpx", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        legs: state.routeLegs,
        routeName: `${state.cityName} Segment Planner Route`,
      }),
    });

    if (!res.ok) throw new Error("Failed to export GPX.");

    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${state.cityName.toLowerCase().replace(/[^a-z0-9]/g, "_")}_route.gpx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);

    setLoading(false);
    showToast("GPX route downloaded! Load it into your bike computer.");
  } catch (err) {
    setLoading(false);
    showToast(err.message, true);
  }
}

// Download the city SVG Map with Route Overlay
async function downloadSVG() {
  if (!state.cityKey) return;

  setLoading(true, "Rendering SVG map...");

  try {
    const res = await fetch("/api/exports/svg", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cityKey: state.cityKey,
        legs: state.routeLegs,
      }),
    });

    if (!res.ok) throw new Error("Failed to export SVG.");

    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `map_${state.cityKey}.svg`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);

    setLoading(false);
    showToast("SVG map exported and downloaded!");
  } catch (err) {
    setLoading(false);
    showToast(err.message, true);
  }
}
