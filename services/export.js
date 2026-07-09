function generateGPX(legs, routeName = "Strava Segment Route") {
  const trkpts = [];

  for (const leg of legs) {
    const coords = leg.coords || [];
    const startIndex = trkpts.length > 0 ? 1 : 0;
    for (let j = startIndex; j < coords.length; j++) {
      trkpts.push({
        lat: coords[j][0],
        lon: coords[j][1],
        type: leg.type,
      });
    }
  }

  let gpxContent = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Strava Segment Route Planner" xmlns="http://www.topografix.com/GPX/1/1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>${escapeXml(routeName)}</name>
    <desc>Planned route connecting segments with targeted rest periods</desc>
    <time>${new Date().toISOString()}</time>
  </metadata>
  <trk>
    <name>${escapeXml(routeName)}</name>
    <desc>Route with segments and rest sections</desc>
    <trkseg>
`;

  for (const pt of trkpts) {
    gpxContent += `      <trkpt lat="${pt.lat.toFixed(6)}" lon="${pt.lon.toFixed(6)}">\n`;
    gpxContent += `        <desc>${pt.type === "segment" ? "Effort Segment" : "Rest Period"}</desc>\n`;
    gpxContent += `      </trkpt>\n`;
  }

  gpxContent += `    </trkseg>
  </trk>
</gpx>
`;

  return gpxContent;
}

function generateSVG(graph, legs, width = 1200, height = 1200) {
  return graph.generateSVG(width, height, { legs });
}

function escapeXml(unsafe) {
  return unsafe.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

module.exports = { generateGPX, generateSVG };
