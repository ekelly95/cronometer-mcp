import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { defaultConfigPath, registerClaudeDesktopServer } from '../../src/cli/desktop-config.js';

/**
 * These mirror the scenarios scripts/test-setup-windows.ps1 covers, but run through
 * vitest so they execute on macOS too. That is the point of sharing the
 * implementation: the fiddliest part of the macOS setup is the part this machine can
 * actually prove.
 */

// Shaped like the real file: several servers, a nested env block, and a preferences
// tree deep enough that a naive serialiser would truncate it.
const REALISTIC = `{
  "mcpServers": {
    "alpha": { "command": "/usr/local/bin/alpha", "args": [] },
    "beta": {
      "command": "/usr/local/bin/node",
      "args": ["/opt/beta/index.js"],
      "env": { "BETA_LIBRARY": "/Users/someone/Library" }
    }
  },
  "userFilesPath": "/Users/someone/Claude",
  "preferences": {
    "allowedOrigins": ["https://example.invalid"],
    "emptyObject": {},
    "emptyArray": [],
    "nested": {
      "levelTwo": {
        "levelThree": {
          "levelFour": { "kept": true, "ratio": 0.5, "name": "deep value" }
        }
      }
    }
  }
}`;

const LAUNCHER = '/opt/cronometer/scripts/run-mcp.sh';
const workspaces: string[] = [];

function workspace(): string {
  const path = mkdtempSync(join(tmpdir(), 'cronometer-desktop-test-'));
  workspaces.push(path);
  return path;
}

function withConfig(contents?: string): string {
  const path = join(workspace(), 'claude_desktop_config.json');
  if (contents !== undefined) writeFileSync(path, contents, 'utf8');
  return path;
}

function backupsIn(configPath: string): string[] {
  return readdirSync(join(configPath, '..')).filter((name) => name.includes('.backup-'));
}

function register(configPath: string, command = '/bin/sh', args = [LAUNCHER]) {
  return registerClaudeDesktopServer({ configPath, command, args });
}

afterEach(() => {
  workspaces.length = 0;
});

describe('an existing configuration keeps everything it had', () => {
  it('adds the server without disturbing anything else', () => {
    const config = withConfig(REALISTIC);
    const before = JSON.parse(REALISTIC);

    const result = register(config);
    const after = JSON.parse(readFileSync(config, 'utf8'));

    expect(result.status).toBe('registered');
    expect(Object.keys(after.mcpServers)).toContain('cronometer');
    expect(Object.keys(after.mcpServers)).toEqual(
      expect.arrayContaining(['alpha', 'beta', 'cronometer']),
    );
    expect(after.mcpServers.beta.env.BETA_LIBRARY).toBe(before.mcpServers.beta.env.BETA_LIBRARY);
    expect(after.userFilesPath).toBe(before.userFilesPath);
    expect(after.preferences.nested.levelTwo.levelThree.levelFour.name).toBe('deep value');
    expect(after.preferences.nested.levelTwo.levelThree.levelFour.ratio).toBe(0.5);
    expect(after.preferences.allowedOrigins[0]).toBe('https://example.invalid');
    expect(after.preferences.emptyObject).toEqual({});
    expect(after.preferences.emptyArray).toEqual([]);
  });

  it('passes the launcher as separate arguments rather than one string', () => {
    // A single string would be run through a shell, which is how a path containing a
    // space turns into two arguments and a confusing failure.
    const config = withConfig(REALISTIC);
    register(config, '/bin/sh', [LAUNCHER]);
    const after = JSON.parse(readFileSync(config, 'utf8'));

    expect(after.mcpServers['cronometer'].command).toBe('/bin/sh');
    expect(after.mcpServers['cronometer'].args).toEqual([LAUNCHER]);
  });

  it('backs the previous configuration up byte for byte', () => {
    const config = withConfig(REALISTIC);
    const result = register(config);

    expect(backupsIn(config)).toHaveLength(1);
    expect(readFileSync(result.backupPath as string, 'utf8')).toBe(REALISTIC);
  });
});

describe('running it twice never overwrites an existing entry', () => {
  it('leaves the first launcher in place and says so', () => {
    const config = withConfig(REALISTIC);
    register(config, '/bin/sh', ['/first/run-mcp.sh']);
    const second = register(config, '/bin/sh', ['/second/run-mcp.sh']);
    const after = JSON.parse(readFileSync(config, 'utf8'));

    expect(second.status).toBe('exists');
    expect(second.message).toMatch(/not overwritten/);
    expect(after.mcpServers['cronometer'].args).toEqual(['/first/run-mcp.sh']);
    expect(backupsIn(config)).toHaveLength(1);
  });
});

describe('a machine with no Desktop configuration yet', () => {
  it('creates the file holding exactly one server, and backs nothing up', () => {
    const config = withConfig();
    register(config);
    const after = JSON.parse(readFileSync(config, 'utf8'));

    expect(existsSync(config)).toBe(true);
    expect(Object.keys(after.mcpServers)).toEqual(['cronometer']);
    expect(backupsIn(config)).toHaveLength(0);
  });
});

describe('an empty configuration file is treated as empty, not broken', () => {
  it.each([['', 'nothing at all'], ['   \n  ', 'only whitespace']])(
    'registers into a file holding %j (%s)',
    (contents) => {
      const config = withConfig(contents);
      register(config);
      const after = JSON.parse(readFileSync(config, 'utf8'));
      expect(Object.keys(after.mcpServers)).toContain('cronometer');
    },
  );
});

describe('a configuration we do not understand is refused, not repaired', () => {
  it.each([
    ['a JSON array', '["not","an","object"]'],
    ['mcpServers holding a string', '{"mcpServers":"nonsense"}'],
    ['a bare string', '"just a string"'],
    ['a number', '42'],
    ['null', 'null'],
    ['truncated JSON', '{"mcpServers": {'],
  ])('refuses %s and leaves the file exactly as it was', (_label, contents) => {
    const config = withConfig(contents);
    expect(() => register(config)).toThrow();
    expect(readFileSync(config, 'utf8')).toBe(contents);
    expect(backupsIn(config)).toHaveLength(0);
  });
});

describe('Claude Desktop not being installed is not an error', () => {
  it('reports a skip and creates nothing', () => {
    const missing = join(workspace(), 'no-such-directory', 'claude_desktop_config.json');
    const result = register(missing);

    expect(result.status).toBe('skipped');
    expect(result.message).toMatch(/not installed/);
    expect(existsSync(missing)).toBe(false);
  });
});

describe('where each platform keeps the file', () => {
  it('follows the Claude Desktop location on each platform', () => {
    expect(defaultConfigPath('win32', { APPDATA: '/roaming' })).toBe(
      join('/roaming', 'Claude', 'claude_desktop_config.json'),
    );
    expect(defaultConfigPath('darwin', {})).toMatch(
      /Library[\\/]Application Support[\\/]Claude[\\/]claude_desktop_config\.json$/,
    );
    // Not a platform this has been run on, but guessing a path is better than
    // writing one into the wrong place.
    expect(defaultConfigPath('linux', {})).toMatch(
      /\.config[\\/]Claude[\\/]claude_desktop_config\.json$/,
    );
  });

  it('reports no path rather than a wrong one when APPDATA is unset', () => {
    expect(defaultConfigPath('win32', {})).toBeUndefined();
  });
});

describe('the deep-nesting guard', () => {
  it('keeps a value fifteen levels down', () => {
    // The failure this replaces was a serialiser with a default depth of 2 that
    // silently substituted a type name for whole subtrees.
    let deep: unknown = { bottom: 'still here' };
    for (let level = 0; level < 15; level += 1) deep = { [`level${level}`]: deep };
    const config = withConfig(JSON.stringify({ preferences: deep }, null, 2));

    register(config);
    const text = readFileSync(config, 'utf8');

    expect(text).toContain('still here');
    expect(text).not.toMatch(/System\.(Management|Collections|Object)/);
  });
});

describe('the directory must already exist', () => {
  it('does not create Claude Desktop’s directory on its behalf', () => {
    // Creating it would make a machine without Claude Desktop look like one that has
    // it, and the config would sit there unread forever.
    const base = workspace();
    const nested = join(base, 'Claude');
    const config = join(nested, 'claude_desktop_config.json');

    expect(register(config).status).toBe('skipped');
    expect(existsSync(nested)).toBe(false);

    mkdirSync(nested);
    expect(register(config).status).toBe('registered');
  });
});
