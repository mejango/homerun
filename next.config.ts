import type { NextConfig } from 'next'
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants'

const commonSecurityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
]

const config: NextConfig = {
  // Let Next reload open tabs when navigation reaches a different deployment.
  deploymentId: process.env.NEXT_PUBLIC_VERSION,
  // Next 16 blocks a numeric-loopback Origin on the development HMR socket by
  // default. Local browser tests use both aliases; keep the allowlist narrow.
  allowedDevOrigins: ['127.0.0.1'],
  outputFileTracingRoot: process.cwd(),
  experimental: { optimizePackageImports: ['@bananapus/nana-sdk-core'] },
  output: 'standalone', poweredByHeader: false, reactStrictMode: true,
  async redirects() { return [
    { source: '/demo.html', destination: '/founderhaus', permanent: true },
    { source: '/founderhaus/index.html', destination: '/founderhaus', permanent: true },
    { source: '/founderhause', destination: '/founderhaus', permanent: true },
    { source: '/founderhause/index.html', destination: '/founderhaus', permanent: true },
  ] },
  async headers() { return [
    // Signa returns inside a same-origin frame. Exclude only its exact callback,
    // with or without a trailing slash, so it receives one framing policy.
    { source: '/((?!center/callback/?$).*)', headers: [
      ...commonSecurityHeaders,
      { key: 'Content-Security-Policy', value: 'frame-ancestors https://app.safe.global https://app.5afe.dev' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    ] },
    { source: '/center/callback', headers: [
      ...commonSecurityHeaders,
      { key: 'Cache-Control', value: 'no-store' },
      { key: 'Referrer-Policy', value: 'strict-origin' },
      { key: 'Content-Security-Policy', value: "frame-ancestors 'self'" },
    ] },
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
