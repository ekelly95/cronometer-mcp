import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { LiveBridge, LiveBridgeError } from '../../src/live/client.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const bridges: LiveBridge[] = [];

function bridge(timeoutMs = 2_000, maxReplyCharacters = 30 * 1024 * 1024): LiveBridge {
  const instance = new LiveBridge({
    projectRoot: ROOT,
    command: process.execPath,
    args: [resolve(HERE, 'fake-bridge.mjs')],
    environment: {},
    timeoutMs,
    maxReplyCharacters,
    // Unpaced: these tests are about framing and lifecycle, and the real floor
    // would add a second to each one. Pacing has its own test below.
    minimumIntervalMs: 0,
  });
  bridges.push(instance);
  return instance;
}

afterEach(async () => {
  await Promise.all(bridges.splice(0).map(async (instance) => instance.close()));
});

describe('LiveBridge', () => {
  it('exchanges structured messages without putting data on MCP stdout', async () => {
    const result = await bridge().call('status', { marker: 'hello' });
    expect(result.value).toEqual({ method: 'status', params: { marker: 'hello' }, active: 1 });
    // A plain reply carries no doubt; the flag appears only when the helper says so.
    expect(result.unverified).toBe(false);
  });

  /**
   * Serialisation stops calls overlapping; it does nothing about rate. A model
   * asked for "the last two months" will happily issue sixty sequential reads as
   * fast as they complete, and a burst against an interface Cronometer never
   * published is the most plausible way this account gets noticed.
   */
  it('keeps a floor between live calls so a burst cannot be issued at full speed', async () => {
    const paced = new LiveBridge({
      projectRoot: ROOT,
      command: process.execPath,
      args: [resolve(HERE, 'fake-bridge.mjs')],
      environment: {},
      timeoutMs: 5_000,
      minimumIntervalMs: 250,
    });
    bridges.push(paced);

    const started = Date.now();
    await paced.call('status');
    await paced.call('status');
    await paced.call('status');
    const elapsed = Date.now() - started;

    // Three calls means two gaps; the first is not delayed.
    expect(elapsed).toBeGreaterThanOrEqual(450);
    expect(elapsed).toBeLessThan(3_000);
  });

  it('does not pace when the floor is switched off', async () => {
    const started = Date.now();
    const instance = bridge();
    await instance.call('status');
    await instance.call('status');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('serializes calls so the shared authenticated session cannot race', async () => {
    const instance = bridge();
    const [first, second] = await Promise.all([
      instance.call('status', { delay: 25 }),
      instance.call('status', { delay: 0 }),
    ]);
    expect(first.value).toEqual(expect.objectContaining({ active: 1 }));
    expect(second.value).toEqual(expect.objectContaining({ active: 1 }));
  });

  it('marks a timed-out write outcome as unknown instead of inviting a retry', async () => {
    // The timeout has to be generous enough that the *recovery* call below fits inside
    // it on a slow machine, because a timed-out call tears the helper down and the next
    // one pays to start it again. At 200ms this passed here and failed on a CI runner,
    // where the same work took sixteen times longer.
    const instance = bridge(1_500);
    await expect(instance.call('status', { delay: 6_000 })).rejects.toThrow(
      /outcome is unknown, so do not retry/i,
    );
    await expect(instance.call('status').then((r) => r.value)).resolves.toEqual(
      expect.objectContaining({ method: 'status', active: 1 }),
    );
  });

  it('fails a call still in flight when it is closed, instead of leaving it to time out', async () => {
    const instance = bridge(30_000);
    const pending = instance.call('status', { delay: 10_000 });
    const outcome = expect(pending).rejects.toThrow(/closed before it answered/);
    // Long enough for the request to be written to the helper.
    await new Promise((resolvePause) => setTimeout(resolvePause, 300));

    const started = Date.now();
    await instance.close();
    await outcome;
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('stops an oversized reply once the line is complete', async () => {
    const instance = bridge(2_000, 64);
    await expect(instance.call('status', { oversized: true })).rejects.toThrow(
      /oversized response/i,
    );
  });

  /**
   * The case above arrives as a complete line and is caught after the newline.
   * This one never sends a newline at all, so only the growing-buffer check can
   * stop it — and it has to stop it before the timeout, or the limit is doing
   * nothing that the timeout was not already doing.
   */
  it('stops an unterminated reply while the buffer is still growing', async () => {
    const instance = bridge(30_000, 64);
    const started = Date.now();
    await expect(instance.call('status', { unterminated: 4_096 })).rejects.toThrow(
      /oversized response/i,
    );
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('passes credentials to the child but not the rest of the environment', async () => {
    const instance = new LiveBridge({
      projectRoot: ROOT,
      command: process.execPath,
      args: [resolve(HERE, 'fake-bridge.mjs')],
      environment: {
        CRONOMETER_LIVE_ENABLED: '1',
        CRONOMETER_USERNAME: 'student@example.com',
        CRONOMETER_PASSWORD: 'password-secret',
        CRONOMETER_DATA_DIR: 'C:\\data',
        // None of these belong in a process that talks to one host over HTTPS.
        HTTPS_PROXY: 'http://interceptor.example:8080',
        REQUESTS_CA_BUNDLE: 'C:\\attacker\\ca.pem',
        PYTHONPATH: 'C:\\attacker\\modules',
        AWS_SECRET_ACCESS_KEY: 'unrelated-secret',
        GITHUB_TOKEN: 'unrelated-token',
      },
      timeoutMs: 5_000,
      minimumIntervalMs: 0,
    });
    bridges.push(instance);

    const { value } = await instance.call('status', { reportEnvironment: true });
    const result = value as { readonly environmentKeys: readonly string[] };
    const keys = new Set(result.environmentKeys.map((key) => key.toUpperCase()));

    for (const allowed of ['CRONOMETER_USERNAME', 'CRONOMETER_PASSWORD', 'CRONOMETER_DATA_DIR']) {
      expect(keys.has(allowed), `${allowed} should reach the child`).toBe(true);
    }
    for (const blocked of [
      'HTTPS_PROXY',
      'REQUESTS_CA_BUNDLE',
      'PYTHONPATH',
      'AWS_SECRET_ACCESS_KEY',
      'GITHUB_TOKEN',
    ]) {
      expect(keys.has(blocked), `${blocked} must not reach the child`).toBe(false);
    }
  });

  /**
   * Two separate channels, and it is easy to fix one and call it done. The tool
   * result is what the model reads; the diagnostic sink is the MCP host's log,
   * which is a file on disk that outlives the session. A secret in the second is
   * worse than a secret in the first, not better.
   */
  it('redacts credentials from the diagnostics it writes to the host log', async () => {
    const logged: string[] = [];
    const noisy = new LiveBridge({
      projectRoot: ROOT,
      command: process.execPath,
      args: [
        '-e',
        'process.stderr.write("Traceback: login failed for " + process.env.CRONOMETER_USERNAME + " with " + process.env.CRONOMETER_PASSWORD + "\\n"); process.exit(3);',
      ],
      environment: {
        CRONOMETER_USERNAME: 'student@example.com',
        CRONOMETER_PASSWORD: 'password-secret',
      },
      timeoutMs: 5_000,
      minimumIntervalMs: 0,
      diagnostics: (text) => logged.push(text),
    });
    bridges.push(noisy);

    await noisy.call('status').catch(() => undefined);
    const diagnostics = logged.join('');

    expect(diagnostics).toContain('Traceback');
    expect(diagnostics).not.toContain('password-secret');
    expect(diagnostics).not.toContain('student@example.com');
    expect(diagnostics).toContain('[redacted]');
  });

  it('redacts a secret that reaches the log split across two writes', async () => {
    // A pipe delivers text in whatever chunks it likes. Redacting chunk by chunk
    // missed a password that straddled two of them.
    const logged: string[] = [];
    const noisy = new LiveBridge({
      projectRoot: ROOT,
      command: process.execPath,
      args: [
        '-e',
        'const p = process.env.CRONOMETER_PASSWORD; process.stderr.write("login failed with " + p.slice(0, 5)); setTimeout(() => { process.stderr.write(p.slice(5) + "\\n"); process.exit(3); }, 100);',
      ],
      environment: { CRONOMETER_PASSWORD: 'password-secret' },
      timeoutMs: 5_000,
      minimumIntervalMs: 0,
      diagnostics: (text) => logged.push(text),
    });
    bridges.push(noisy);

    await noisy.call('status').catch(() => undefined);
    const diagnostics = logged.join('');

    expect(diagnostics).toContain('login failed with');
    expect(diagnostics).not.toContain('passw');
    expect(diagnostics).toContain('[redacted]');
  });

  it('does not return the child’s diagnostic output to the caller', async () => {
    const noisy = new LiveBridge({
      projectRoot: ROOT,
      command: process.execPath,
      args: [
        '-e',
        'process.stderr.write("Traceback\\nCRONOMETER_PASSWORD=leaked\\n"); process.exit(3);',
      ],
      environment: {},
      timeoutMs: 5_000,
      minimumIntervalMs: 0,
      diagnostics: () => undefined,
    });
    bridges.push(noisy);

    // Diagnostics belong in the server log; an unredacted, multi-line traceback
    // must never become the text a model reads back as a tool result. Asserted on
    // the captured message rather than with a negated matcher, so it cannot pass
    // by simply not rejecting.
    const failure = await noisy.call('status').then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(LiveBridgeError);
    const message = (failure as Error).message;
    expect(message).toMatch(/exit code 3/);
    expect(message).not.toMatch(/leaked/);
    expect(message).not.toMatch(/Traceback/);
    expect(message.split('\n')).toHaveLength(1);
  });

  it('can be constructed without a Python environment, and only complains when used', async () => {
    // The bug this pins: the interpreter was resolved in the constructor, so a
    // checkout with no .venv-live could not start the server at all. `initialize`
    // came back "Internal server error" and nothing else — the state of every fresh
    // clone, and of CI, where it went unnoticed until Actions could run.
    const withoutEnvironment = new LiveBridge({
      projectRoot: resolve(ROOT, 'no-such-project-root'),
      environment: {},
      timeoutMs: 500,
      minimumIntervalMs: 0,
    });
    bridges.push(withoutEnvironment);

    // Constructing it is what listing tools and reading a downloaded export need, and
    // neither of those touches Python.
    await expect(withoutEnvironment.call('status')).rejects.toThrow(
      /live Python environment is missing/i,
    );
  });

  it('fails clearly when its executable cannot start', async () => {
    const instance = new LiveBridge({
      projectRoot: ROOT,
      command: resolve(ROOT, 'definitely-not-python.exe'),
      args: [],
      environment: {},
      timeoutMs: 500,
      minimumIntervalMs: 0,
    });
    bridges.push(instance);
    await expect(instance.call('status')).rejects.toBeInstanceOf(LiveBridgeError);
    await expect(instance.call('status')).rejects.toBeInstanceOf(LiveBridgeError);
  });
});
