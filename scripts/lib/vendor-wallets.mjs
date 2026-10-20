// Strings only a vendor wallet SDK's bundle contains. Never a connector id or display name, which Homerun's own
// source carries. test/startup-downloads.mjs fails when a page downloads any of them before an interaction.
/** @type {[label: string, markers: string[]][]} */
export const vendorWallets = [
  ['WalletConnect', ['walletconnect.org', 'wc@2:', '@reown/appkit']],
  ['Coinbase Wallet', ['CoinbaseWalletSDK', 'keys.coinbase.com', 'walletlink']],
  ['Safe', ['safe-apps-provider', 'SafeAppProvider']],
]
