import type { NextConfig } from "next";
import path from "node:path";

const API_ORIGIN = process.env.API_ORIGIN ?? "http://localhost:3001";

const nextConfig: NextConfig = {
  // Minimal, self-contained build output for the Docker image — traces only
  // the node_modules actually needed instead of shipping the whole tree.
  output: "standalone",
  // Off because it was doubling every GET in the Network tab during dev.
  // Trade-off: StrictMode's double-invoke is what catches effects that
  // aren't idempotent/cleanup-safe — this repo doesn't rely on that check
  // today, but a genuinely non-idempotent effect added later won't get
  // flagged in dev anymore. It never runs in production either way.
  reactStrictMode: false,
  // Monorepo: node_modules is hoisted to the repo root, so Turbopack needs
  // telling where that root actually is (it otherwise resolves relative to
  // this app's own directory and can't find `next` in the Docker build).
  turbopack: {
    root: path.join(__dirname, "..", ".."),
  },
  // Proxy keeps the browser talking same-origin to /api/* — the session
  // cookie (SameSite=Lax, no CORS) just works, no cross-origin credential
  // handling needed.
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${API_ORIGIN}/api/:path*` }];
  },
};

export default nextConfig;
