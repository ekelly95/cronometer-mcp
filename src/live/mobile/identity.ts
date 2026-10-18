/**
 * How this connector introduces itself to Cronometer's mobile API.
 *
 * The mobile API is the private JSON interface the Cronometer Android app uses;
 * there is no public one. It expects the app's own build and version numbers,
 * and Cronometer can stop accepting old ones whenever it ships a new app. These
 * are kept in one place, and each can be overridden from the environment, so a
 * breakage of that kind is a configuration change rather than a release.
 *
 * Values follow rwestergren/cronometer-api-mcp (MIT), which established the
 * protocol by inspecting the Android app; see THIRD_PARTY_NOTICES.md.
 */

export interface AppIdentity {
  readonly userAgent: string;
  readonly appVersion: string;
  readonly buildNumber: string;
  readonly device: string;
}

export function appIdentity(environment: Readonly<NodeJS.ProcessEnv> = process.env): AppIdentity {
  const pick = (name: string, fallback: string): string => {
    const value = environment[name]?.trim();
    return value === undefined || value === '' || /[\r\n]/.test(value) ? fallback : value;
  };
  return {
    userAgent: pick('CRONOMETER_APP_USER_AGENT', 'Dart/3.9 (dart:io)'),
    appVersion: pick('CRONOMETER_APP_VERSION', '4.48.2'),
    buildNumber: pick('CRONOMETER_APP_BUILD', '2807'),
    device: pick('CRONOMETER_APP_DEVICE', 'Android 14 (SDK 34), Google Pixel 6 Pro'),
  };
}
