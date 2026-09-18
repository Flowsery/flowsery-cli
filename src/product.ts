export const PRODUCT = {
  id: 'flowsery',
  displayName: 'Flowsery',
  binName: 'flowsery',
  altBinName: 'fsy',
  npmPackage: '@flowsery/cli',
  envPrefix: 'FLOWSERY',
  defaultApiUrl: 'https://analytics.flowsery.com/analytics/api/v1',
  appUrl: 'https://flowsery.com',
  tokensUrl: 'https://flowsery.com/api-tokens',
  tokenPrefixes: ['flow_ws_', 'flow_'],
  verifyPath: '/websites',
} as const;
