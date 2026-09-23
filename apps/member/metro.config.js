const { getDefaultConfig } = require('expo/metro-config');

/**
 * Metro in an npm workspace.
 *
 * Since SDK 52, expo/metro-config detects the workspace root on its own:
 * it watches sibling packages and resolves modules hoisted to the repo
 * root, so @outcome/shared bundles without help. The manual watchFolders /
 * nodeModulesPaths / disableHierarchicalLookup overrides this file used to
 * carry are gone; expo-doctor flags the last one, and with one React across
 * the workspace there is nothing left for it to guard against.
 */
module.exports = getDefaultConfig(__dirname);
