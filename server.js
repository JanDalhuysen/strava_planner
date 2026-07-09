const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

["cache", "data"].forEach((dir) => {
  const p = path.join(__dirname, dir);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.use("/api/cities", require("./routes/cities"));
app.use("/api/segments", require("./routes/segments"));
app.use("/api/planner", require("./routes/planner"));
app.use("/api/exports", require("./routes/exports"));

app.listen(PORT, () => {
  console.log(`\n Strava Route Planner running at http://localhost:${PORT}\n`);
});
