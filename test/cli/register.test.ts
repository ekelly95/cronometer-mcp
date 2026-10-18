import { describe, expect, it } from 'vitest';

import { launchWarning, versionManagedNode } from '../../src/cli/register.js';

describe('version-managed Node', () => {
  it.each([
    ['/home/someone/.nvm/versions/node/v22.11.0/bin/node', 'nvm'],
    ['C:\\Users\\someone\\AppData\\Roaming\\nvm\\v22.11.0\\node.exe', 'nvm'],
    ['/home/someone/.local/share/fnm/node-versions/v22.11.0/installation/bin/node', 'fnm'],
    ['/run/user/1000/fnm_multishells/12345_1700000000000/bin/node', 'fnm'],
    ['/home/someone/.volta/tools/image/node/22.11.0/bin/node', 'Volta'],
    ['/home/someone/.asdf/installs/nodejs/22.11.0/bin/node', 'asdf'],
    ['/home/someone/.local/share/mise/installs/node/22.11.0/bin/node', 'mise'],
    ['/usr/local/n/versions/node/22.11.0/bin/node', 'n'],
    ['/home/someone/.nodenv/versions/22.11.0/bin/node', 'nodenv'],
  ])('recognises %s as %s', (path, manager) => {
    expect(versionManagedNode(path)).toBe(manager);
  });

  it.each(['/usr/bin/node', '/opt/homebrew/bin/node', 'C:\\Program Files\\nodejs\\node.exe', 'npx'])('leaves %s alone', (path) => {
    expect(versionManagedNode(path)).toBeUndefined();
    expect(launchWarning({ command: path, args: [] })).toBeUndefined();
  });

  it('suggests npx when the path will break', () => {
    expect(launchWarning({ command: '/home/someone/.nvm/versions/node/v22.11.0/bin/node', args: [] })).toContain('npx -y @ekelly95/cronometer-mcp');
  });
});
