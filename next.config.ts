import type { NextConfig } from 'next';

/**
 * Content-Security-Policy.
 *
 * `'unsafe-inline'` on style-src is required by Next's inlined critical CSS.
 * script-src: Next bootstraps hydration through inline scripts, so a bare
 * 'self' silently kills ALL client-side JS (React never hydrates; the app
 * degrades to no-JS form fallbacks — found live in Sprint 3 M3). Development
 * therefore allows inline/eval (eval is also needed by HMR source maps).
 * Production must switch to nonce-based CSP before any deployment — tracked
 * as a deployment blocker alongside the others in decision #9; still
 * third-party-free either way. connect-src stays 'self': the browser never
 * talks to a model provider; all provider traffic originates from the server.
 */
const isDev = process.env.NODE_ENV !== 'production';

const csp = [
  "default-src 'self'",
  isDev ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'" : "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
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
