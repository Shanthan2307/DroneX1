import type { NextConfig } from "next";

// What the configurator's pages load: their own scripts and styles (Next inlines some), the Cartesia sockets and
// REST API (voice), the shared airspace's SpacetimeDB socket, blob/data URLs for audio and the 3D export.
function contentSecurityPolicy(): string {
  const spacetime = process.env.NEXT_PUBLIC_SPACETIME_URI?.trim() || "wss://maincloud.spacetimedb.com";
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    `connect-src 'self' https://api.cartesia.ai wss://api.cartesia.ai ${spacetime}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  // The route indicator sits bottom-left, over the configurator's current-drone bar; errors still show without it.
  devIndicators: false,
  // Basic hardening: no embedding in other sites, no MIME sniffing, no camera/location. The microphone is allowed
  // for this origin only: the Copilot page's push-to-talk streams it to Cartesia Ink.
  // In production also HSTS, and a Content-Security-Policy in Report-Only mode first (violations show in the
  // browser console; switch to enforcing once a public session reports none).
  async headers() {
    const production = process.env.NODE_ENV === "production";
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "microphone=(self), camera=(), geolocation=()" },
          ...(production
            ? [
                { key: "Strict-Transport-Security", value: "max-age=31536000" },
                { key: "Content-Security-Policy-Report-Only", value: contentSecurityPolicy() },
              ]
            : []),
        ],
      },
    ];
  },
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
