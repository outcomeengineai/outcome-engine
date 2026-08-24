const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

/**
 * Metro in an npm workspace.
 *
 * Two things Metro does not do on its own: watch sibling workspace packages,
 * and resolve modules hoisted to the repo root. Without both, importing
 * @outcome/shared fails at bundle time even though TypeScript is happy.
 */
const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];

config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

// Prefer the app's own copy of a duplicated dependency, so React is never
// loaded twice.
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
