import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where this connector keeps its configuration, session caches and downloaded
 * exports: one private directory per account, in the place each platform keeps
 * per-user application data.
 */

export const APP_DIRECTORY = 'cronometer-mcp';
/** The directory name used before the project was renamed; read once, for migration. */
export const LEGACY_APP_DIRECTORY = 'CronometerPersonalMcp';

export const KEYRING_SERVICE = 'cronometer-mcp';
export const LEGACY_KEYRING_SERVICE = 'cronometer-personal-mcp';

function base(platform: NodeJS.Platform, environment: Readonly<NodeJS.ProcessEnv>): string {
  if (platform === 'win32') {
    const local = environment['LOCALAPPDATA'];
    if (local !== undefined && local !== '') return local;
    return join(homedir(), 'AppData', 'Local');
  }
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support');
  const xdg = environment['XDG_DATA_HOME'];
  return xdg !== undefined && xdg !== '' ? xdg : join(homedir(), '.local', 'share');
}

export function dataDirectory(
  platform: NodeJS.Platform = process.platform,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): string {
  const override = environment['CRONOMETER_DATA_DIR']?.trim();
  if (override !== undefined && override !== '') return override;
  return join(base(platform, environment), APP_DIRECTORY);
}

export function legacyDataDirectory(
  platform: NodeJS.Platform = process.platform,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): string {
  return join(base(platform, environment), LEGACY_APP_DIRECTORY);
}

export const configFile = (directory: string): string => join(directory, 'live-config.json');
export const exportsDirectory = (directory: string): string => join(directory, 'exports');
