export const NETWORK_ENVIRONMENTS = Object.freeze(['production', 'testnet']);

export const NETWORK_FAMILIES = Object.freeze([
  {
    id: 'ethereum', name: 'Ethereum', icon: '/assets/networks/ethereum.svg',
    production: { id: 'ethereum', name: 'Ethereum', chainId: 1 },
    testnet: { id: 'sepolia', name: 'Sepolia', chainId: 11155111 },
  },
  {
    id: 'optimism', name: 'Optimism', icon: '/assets/networks/optimism.svg',
    production: { id: 'optimism', name: 'Optimism', chainId: 10 },
    testnet: { id: 'optimism-sepolia', name: 'Optimism Sepolia', chainId: 11155420 },
  },
  {
    id: 'base', name: 'Base', icon: '/assets/networks/base.svg',
    production: { id: 'base', name: 'Base', chainId: 8453 },
    testnet: { id: 'base-sepolia', name: 'Base Sepolia', chainId: 84532 },
  },
  {
    id: 'arbitrum', name: 'Arbitrum', icon: '/assets/networks/arbitrum.svg',
    production: { id: 'arbitrum', name: 'Arbitrum', chainId: 42161 },
    testnet: { id: 'arbitrum-sepolia', name: 'Arbitrum Sepolia', chainId: 421614 },
  },
].map(family => Object.freeze({
  ...family,
  production: Object.freeze(family.production),
  testnet: Object.freeze(family.testnet),
})));

/** Resolve a validated selection to concrete chains, retaining the displayed family order. */
export function plannedNetworks({ networks, networkEnvironment }) {
  if (!NETWORK_ENVIRONMENTS.includes(networkEnvironment)) throw new TypeError('Choose production networks or testnets.');
  if (!Array.isArray(networks) || networks.length === 0
    || new Set(networks).size !== networks.length
    || networks.some(id => !NETWORK_FAMILIES.some(family => family.id === id))) {
    throw new TypeError('Choose at least one supported network, without duplicates.');
  }
  return NETWORK_FAMILIES.filter(family => networks.includes(family.id))
    .map(family => ({ ...family[networkEnvironment] }));
}
