import type { NextConfig } from 'next'
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants'
import { resolve } from 'node:path'
const config: NextConfig = {
  // Next 16 blocks a numeric-loopback Origin on the development HMR socket by
  // default. Local browser tests use both aliases; keep the allowlist narrow.
  allowedDevOrigins: ['127.0.0.1'],
  outputFileTracingRoot: process.cwd(),
  experimental: { optimizePackageImports: ['@bananapus/nana-sdk-core'] },
  webpack: (webpackConfig, { webpack }) => {
    // Match the reference apps: only the configured EVM wallet SDKs are bundled.
    // Para imports `injected` from the Wagmi connector barrel; the anchored alias
    // avoids pulling unrelated optional Tempo/Porto/MetaMask peers into it.
    webpackConfig.resolve.alias['wagmi/connectors$'] = '@wagmi/core'
    for (const name of [
      '@farcaster/miniapp-sdk', '@farcaster/miniapp-wagmi-connector',
      '@getpara/cosmos-wallet-connectors', '@getpara/evm-wallet-connectors',
      '@getpara/solana-wallet-connectors', '@x402/core', '@x402/evm', '@x402/svm',
      '@react-native-async-storage/async-storage', 'pino-pretty',
      ...['alchemy', 'biconomy', 'cdp', 'gelato', 'pimlico', 'porto', 'rhinestone', 'safe', 'thirdweb', 'zerodev'].map(provider => `@getpara/aa-${provider}`),
    ]) webpackConfig.resolve.alias[name] = false
    webpackConfig.plugins.push(new webpack.NormalModuleReplacementPlugin(
      /[\\/]HeartbeatWorker(\.js)?$/,
      resolve(process.cwd(), 'src/vendor/HeartbeatWorker.js'),
    ))
    return webpackConfig
  },
  output: 'standalone', poweredByHeader: false, reactStrictMode: true,
  async redirects() { return [
    { source: '/demo.html', destination: '/founderhaus', permanent: true },
    { source: '/founderhaus/index.html', destination: '/founderhaus', permanent: true },
    { source: '/founderhause', destination: '/founderhaus', permanent: true },
    { source: '/founderhause/index.html', destination: '/founderhaus', permanent: true },
  ] },
  async headers() { return [
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
