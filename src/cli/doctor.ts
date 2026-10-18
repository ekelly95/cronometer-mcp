import { existsSync, readFileSync } from 'node:fs';

import { CronometerBackend } from '../live/index.js';
import { directoryIsPrivate } from './config.js';
import { configFile } from './paths.js';
import { resolveRuntime } from './runtime.js';

/** `cronometer-mcp doctor`: every check, in the order a problem would show up. */
export async function runDoctor(): Promise<number> {
  const version = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  let failures = 0;
  const report = (ok: boolean | 'warn', text: string): void => {
    if (ok === false) failures += 1;
    process.stdout.write(`${ok === true ? '✓' : ok === 'warn' ? '!' : '✗'} ${text}\n`);
  };

  report(true, `cronometer-mcp ${version} on Node ${process.versions.node} (${process.platform})`);
  report(Number(process.versions.node.split('.')[0]) >= 20, 'Node.js 20 or later');

  const runtime = resolveRuntime();
  report(true, `Data directory: ${runtime.dataDirectory}`);
  if (runtime.source === 'saved-configuration' || existsSync(configFile(runtime.dataDirectory))) {
    report(directoryIsPrivate(runtime.dataDirectory), 'Data directory is private to this account');
  }
  report(runtime.source !== 'none', runtime.source === 'environment' ? 'Credentials come from the environment' : runtime.source === 'saved-configuration' ? 'Credentials read from the saved configuration and keyring' : `Not configured: ${runtime.problem ?? 'unknown problem'}`);
  if (runtime.problem !== undefined && runtime.source !== 'none') report(false, runtime.problem);
  report(true, `Diary timezone: ${runtime.timeZone}`);

  if (runtime.source !== 'none' && runtime.problem === undefined) {
    const backend = new CronometerBackend({ environment: runtime.environment, timeZone: runtime.timeZone, diagnostics: () => {} });
    try {
      const { value } = await backend.call('check_connection', {});
      report(true, 'Signed in to Cronometer (mobile API)');
      const zone = (value as { account_timezone?: unknown }).account_timezone;
      if (typeof zone === 'string' && zone !== runtime.timeZone) report('warn', `Cronometer's account timezone is ${zone}; this connector uses ${runtime.timeZone}`);
    } catch (error) {
      report(false, `Sign-in failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  process.stdout.write(failures === 0 ? '\nEverything looks right.\n' : `\n${failures} problem(s) found.\n`);
  return failures === 0 ? 0 : 1;
}
