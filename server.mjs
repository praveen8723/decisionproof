import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { cool, handleApiRequest } from "./lib/decisionproof.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, "public");
const port = Number(process.env.PORT ?? 4173);
const host = process.env.HOST ?? "127.0.0.1";

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

async function serveStatic(res, pathname) {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const safePath = normalize(requested).replace(/^(\.\.(\\|\/|$))+/, "");
  const filePath = join(publicDir, safePath);
  if (!filePath.startsWith(publicDir)) return false;
  try {
    const body = await readFile(filePath);
    res.writeHead(200, {
      "content-type": contentTypes[extname(filePath)] ?? "application/octet-stream",
      "cache-control": "no-cache",
    });
    res.end(body);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? `${host}:${port}`}`);
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
    await handleApiRequest(req, res, url);
    return;
  }

  try {
    if (await serveStatic(res, url.pathname)) return;
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  } catch {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("Server error");
  }
});

server.listen(port, host, () => {
  console.log(`DecisionProof is running at http://${host}:${port}`);
});

async function shutdown() {
  server.close();
  await cool.close();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

export { server, cool };
