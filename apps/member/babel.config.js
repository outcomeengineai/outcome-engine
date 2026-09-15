module.exports = function (api) {
  api.cache(true);
  // Plain preset. babel-preset-expo detects expo-router by resolving it
  // from its own location, so both must live at the same node_modules
  // level -- they do now that the workspace installs a single React Native
  // and hoists the Expo packages together. If expo-router ever nests under
  // apps/member again, Metro fails on expo-router/_ctx with "Invalid call":
  // fix the install, do not register the plugin by hand.
  return { presets: ['babel-preset-expo'] };
};
