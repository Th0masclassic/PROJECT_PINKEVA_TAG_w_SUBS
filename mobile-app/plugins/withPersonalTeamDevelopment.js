const { withEntitlementsPlist } = require('@expo/config-plugins');

/**
 * The Apple Sign In module is kept in JavaScript for the production build, but
 * a free Personal Team cannot sign an app that requests the Apple Sign In
 * entitlement. Keep local device development usable with email/Google auth;
 * set EXPO_PUBLIC_ENABLE_APPLE_SIGN_IN=true when switching to a paid Apple
 * Developer team.
 */
module.exports = function withPersonalTeamDevelopment(config) {
  const appleSignInEnabled = process.env.EXPO_PUBLIC_ENABLE_APPLE_SIGN_IN === 'true';
  return withEntitlementsPlist(config, (mod) => {
    if (!appleSignInEnabled) {
      delete mod.modResults['com.apple.developer.applesignin'];
    }
    return mod;
  });
};
