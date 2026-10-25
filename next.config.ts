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
  // microphone=(self): the Hub's own pages may ask for the mic (Ops Chat 🎤 / Talk, employee Chat / Talk — speech is
  // transcribed in the browser; only text reaches the Hub). Still denied to every other origin, and the browser still
  // asks the owner. Hub prod 2026-10-23: `microphone=()` blocked voice entirely, whatever the browser setting.
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(self), geolocation=(), payment=()' },
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

  // Keep the pg driver out of the bundler's dependency graph analysis. The Ops Chat attachment
  // extractors (pdf.js via unpdf, mammoth, exceljs) also load as plain Node packages at runtime —
  // exactly the code path the extraction tests exercise — rather than being re-bundled.
  serverExternalPackages: ['postgres', 'unpdf', 'mammoth', 'exceljs'],

  // File tracing misses the `require.mjs` conditional-export files deep in exceljs's dependency
  // chain (async-function, generator-function — the only two packages that ship one), which breaks
  // `require('exceljs')` in the standalone image. Include them whole for the upload route (verified by
  // loading exceljs from .next/standalone).
  outputFileTracingIncludes: {
    '/api/ops-chat/attachments': ['./node_modules/generator-function/**/*', './node_modules/async-function/**/*'],
  },

  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
