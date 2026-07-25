import type { NextConfig } from 'next';

/**
 * Static security headers. Content-Security-Policy is NOT here: it is issued
 * per request by src/middleware.ts, which mints a nonce so production can run
 * Next's hydration bootstrap without allowing arbitrary inline script. A
 * static CSP cannot carry a nonce, and a header set here would shadow the
 * middleware's.
 */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  // Lean, self-contained server bundle for the container image (O-21).
  output: 'standalone',

  typescript: {
    // A type error is a build failure. Never relax this.
    ignoreBuildErrors: false,
  },

  // Keep the pg driver out of the bundler's dependency graph analysis.
  serverExternalPackages: ['postgres'],

  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
