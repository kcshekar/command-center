import type { NextConfig } from "next";

const API_ORIGIN = process.env.API_ORIGIN ?? "http://localhost:3001";

const nextConfig: NextConfig = {
  // Proxy keeps the browser talking same-origin to /api/* — the session
  // cookie (SameSite=Lax, no CORS) just works, no cross-origin credential
  // handling needed.
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${API_ORIGIN}/api/:path*` }];
  },
};

export default nextConfig;
