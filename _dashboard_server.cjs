const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = process.argv[2] || __dirname;
const PORT = parseInt(process.argv[3] || "8017", 10);
const PAGE = "index.html";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

http.createServer((req, res) => {
  try {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/" || p === "/index.html") p = "/" + PAGE;
    const fp = path.resolve(ROOT, "." + p);
    if (!fp.startsWith(path.resolve(ROOT))) { res.writeHead(403); return res.end("forbidden"); }
    if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.writeHead(404); return res.end("not found: " + p); }
    const ext = path.extname(fp).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": "no-cache" });
    fs.createReadStream(fp).pipe(res);
  } catch (e) { res.writeHead(500); res.end(String(e)); }
}).listen(PORT, "0.0.0.0", () => {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      if (ni.family === "IPv4" && !ni.internal) ips.push(ni.address);
    }
  }
  console.log("READY http://127.0.0.1:" + PORT + "/");
  for (const ip of ips) console.log("LAN http://" + ip + ":" + PORT + "/");
});
