import type { NextConfig } from 'next'
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants'
const config: NextConfig = {
  // Next 16 blocks a numeric-loopback Origin on the development HMR socket by
  // default. Local browser tests use both aliases; keep the allowlist narrow.
  allowedDevOrigins: ['127.0.0.1'],
  outputFileTracingRoot: process.cwd(),
  experimental: { optimizePackageImports: ['@bananapus/nana-sdk-core'] },
  output: 'standalone', poweredByHeader: false, reactStrictMode: true,
  webpack(config, { isServer }) {
    // Next's client defaults (20 KB minimum chunk, 25 initial requests) copy modules several routes share into each
    // route's chunks. Smaller shared chunks and more initial requests (cheap over HTTP/2) load less per route.
    if (!isServer && config.optimization.splitChunks) {
      Object.assign(config.optimization.splitChunks, { minSize: 5000, maxInitialRequests: 60 })
    }
    return config
  },
  async redirects() { return [
    { source: '/demo.html', destination: '/founderhaus', permanent: true },
    { source: '/founderhaus/index.html', destination: '/founderhaus', permanent: true },
    { source: '/founderhause', destination: '/founderhaus', permanent: true },
    { source: '/founderhause/index.html', destination: '/founderhaus', permanent: true },
  ] },
  async headers() { return [
    { source: '/center/callback', headers: [{ key: 'Cache-Control', value: 'no-store' }, { key: 'Referrer-Policy', value: 'strict-origin' }] },
    { source: '/:path*', headers: [{ key: 'X-Content-Type-Options', value: 'nosniff' }] },
    // Safe reads this public manifest before opening a custom app in its frame.
    { source: '/manifest.json', headers: [{ key: 'Access-Control-Allow-Origin', value: '*' }] },
  ] },
}
export default function nextConfig(phase: string): NextConfig {
  return {
    ...config,
    distDir: process.env.NEXT_DIST_DIR || (phase === PHASE_DEVELOPMENT_SERVER ? '.next-dev' : '.next'),
  }
}
