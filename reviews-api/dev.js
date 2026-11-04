// Run the API on your machine with reviews in a local file:
//   REVIEWS_FILE=reviews.local.json SITE_URL=http://localhost:5000 node dev.js
// Sign-in also needs GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET from a GitHub
// OAuth app whose callback is http://localhost:8787/api/auth/callback.
// then point site/reviews-config.json at {"api": "http://localhost:8787"}.

import { createServer } from "node:http";

const routes = {
  "/api/reviews": await import("./api/reviews.js"),
  "/api/counts": await import("./api/counts.js"),
  "/api/admin": await import("./api/admin.js"),
  "/api/leaderboard": await import("./api/leaderboard.js"),
  "/api/auth/login": await import("./api/auth/login.js"),
  "/api/auth/callback": await import("./api/auth/callback.js"),
};
const port = Number(process.env.PORT || 8787);

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  const handler = routes[url.pathname]?.[req.method];
  if (!handler) {
    res.writeHead(404).end();
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const request = new Request(url, {
    method: req.method,
    headers: { ...req.headers, "x-forwarded-for": req.socket.remoteAddress },
    body: ["GET", "HEAD", "OPTIONS"].includes(req.method) ? undefined : Buffer.concat(chunks),
  });
  const response = await handler(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, () => console.log(`reviews API on http://localhost:${port}`));
