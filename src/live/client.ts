import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import { redactSecrets } from './redact.js';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue | undefined;
}

export type LiveMethod =
  | 'status'
  | 'check_connection'
  | 'export_raw'
  | 'search_foods'
  | 'get_food_details'
  | 'add_food_entry'
  | 'remove_food_entry'
  | 'get_macro_targets'
  | 'set_macro_targets'
  | 'list_macro_templates'
  | 'create_macro_template'
  | 'delete_macro_template'
  | 'set_macro_schedule_day'
  | 'get_fasting_history'
  | 'get_fasting_stats'
  | 'delete_fast'
  | 'cancel_active_fast'
  | 'get_recent_biometrics'
  | 'add_biometric'
  | 'remove_biometric'
  | 'copy_day'
  | 'get_repeated_items'
  | 'add_repeat_item'
  | 'delete_repeat_item';

export class LiveBridgeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'LiveBridgeError';
  }
}

interface PendingRequest {
  readonly resolve: (value: LiveResult) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

interface BridgeReply {
  readonly id: number;
  readonly ok: boolean;
  readonly result?: JsonValue;
  readonly error?: string;
  readonly unverified?: boolean;
}

/**
 * A live answer, and whether the connector could stand behind it.
 *
 * `unverified` means the helper returned an empty result it could not confirm was
 * empty — Cronometer answered, but not in a shape it recognised, and an empty
 * record looks identical at that point. It is carried as a sibling of the value
 * rather than folded into it because the two are different claims: one is what
 * the account says, the other is how much to trust that.
 */
export interface LiveResult {
  readonly value: JsonValue;
  readonly unverified: boolean;
}

export interface LiveBridgeOptions {
  readonly projectRoot?: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly timeoutMs?: number;
  readonly maxReplyCharacters?: number;
  /** Where redacted child diagnostics go. Injectable so a test can read them. */
  readonly diagnostics?: (text: string) => void;
  /** Floor between live calls. Tests set 0; nothing else should. */
  readonly minimumIntervalMs?: number;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECT_ROOT = resolve(HERE, '..', '..');
const MAX_REPLY_CHARACTERS = 30 * 1024 * 1024;
const MINIMUM_CALL_INTERVAL_MS = 1_000;
/** Diagnostics held back waiting for a newline before they are flushed anyway. */
const MAX_PENDING_DIAGNOSTIC_CHARACTERS = 64 * 1024;

function interpreter(projectRoot: string): string {
  const configured = process.env['CRONOMETER_PYTHON'];
  if (configured !== undefined && configured.trim() !== '') return configured;

  const windows = resolve(projectRoot, '.venv-live', 'Scripts', 'python.exe');
  if (existsSync(windows)) return windows;
  const unix = resolve(projectRoot, '.venv-live', 'bin', 'python');
  if (existsSync(unix)) return unix;

  throw new LiveBridgeError(
    'The live Python environment is missing. Run the documented live-setup command first.',
  );
}

function childEnvironment(source: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  const allowed = [
    'PATH',
    'Path',
    'SystemRoot',
    'SYSTEMROOT',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'HOME',
    'LOCALAPPDATA',
    'APPDATA',
    'CRONOMETER_LIVE_ENABLED',
    'CRONOMETER_USERNAME',
    'CRONOMETER_PASSWORD',
    'CRONOMETER_DATA_DIR',
  ] as const;
  const environment: NodeJS.ProcessEnv = {
    PYTHONUTF8: '1',
    PYTHONUNBUFFERED: '1',
  };
  for (const name of allowed) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

function isReply(value: unknown): value is BridgeReply {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<BridgeReply>;
  return typeof candidate.id === 'number' && typeof candidate.ok === 'boolean';
}

export class LiveBridge {
  readonly #projectRoot: string;
  readonly #configuredCommand: string | undefined;
  #resolvedCommand: string | undefined;
  readonly #args: readonly string[];
  readonly #environment: NodeJS.ProcessEnv;
  readonly #timeoutMs: number;
  readonly #maxReplyCharacters: number;
  readonly #diagnostics: (text: string) => void;
  readonly #minimumIntervalMs: number;
  #lastCallStartedAt = 0;
  #child: ChildProcessWithoutNullStreams | undefined;
  #nextId = 1;
  #pending = new Map<number, PendingRequest>();
  #queue: Promise<void> = Promise.resolve();
  #stdoutBuffer = '';
  #stderrBuffer = '';

  public constructor(options: LiveBridgeOptions = {}) {
    this.#projectRoot = resolve(options.projectRoot ?? DEFAULT_PROJECT_ROOT);
    // Deliberately NOT resolved here. Doing so meant a checkout without the Python
    // environment could not start the server at all: `initialize` answered "Internal
    // server error" and said nothing more, which is every fresh clone. Listing tools,
    // reading a downloaded export and asking for status need no interpreter, so the
    // absence of one should only be an error when something actually needs it — and
    // then it names the fix.
    this.#configuredCommand = options.command;
    this.#args = options.args ?? [resolve(this.#projectRoot, 'python', 'live_bridge.py')];
    this.#environment = childEnvironment(options.environment ?? process.env);
    this.#timeoutMs = options.timeoutMs ?? 60_000;
    this.#maxReplyCharacters = options.maxReplyCharacters ?? MAX_REPLY_CHARACTERS;
    this.#diagnostics =
      options.diagnostics ??
      ((text: string): void => {
        process.stderr.write(text);
      });
    this.#minimumIntervalMs = options.minimumIntervalMs ?? MINIMUM_CALL_INTERVAL_MS;
  }

  public call(method: LiveMethod, params: JsonObject = {}): Promise<LiveResult> {
    const operation = this.#queue.then(async () => {
      await this.#pace();
      return this.#send(method, params);
    });
    this.#queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  public async close(): Promise<void> {
    const child = this.#child;
    if (child === undefined) return;

    this.#child = undefined;
    this.#stdoutBuffer = '';
    child.stdin.end();
    await new Promise<void>((resolveClose) => {
      if (child.exitCode !== null) {
        resolveClose();
        return;
      }
      const force = setTimeout(() => {
        child.kill();
      }, 2_000);
      child.once('exit', () => {
        clearTimeout(force);
        resolveClose();
      });
    });
  }

  /**
   * A floor between live calls.
   *
   * Nothing else stops a model deciding to read fifty days one after another, and
   * a burst of automated requests against an interface Cronometer never published
   * is the most plausible way this account gets noticed. A second is imperceptible
   * when a person is reading the answers and is the difference between a
   * conversation and a scrape. Serialisation already prevents concurrency; this is
   * about rate, which is a different thing.
   */
  async #pace(): Promise<void> {
    if (this.#minimumIntervalMs <= 0) return;
    const wait = this.#lastCallStartedAt + this.#minimumIntervalMs - Date.now();
    if (wait > 0) {
      await new Promise<void>((resolvePause) => setTimeout(resolvePause, wait));
    }
    this.#lastCallStartedAt = Date.now();
  }

  #start(): ChildProcessWithoutNullStreams {
    if (this.#child !== undefined) return this.#child;

    this.#stdoutBuffer = '';
    this.#resolvedCommand ??= this.#configuredCommand ?? interpreter(this.#projectRoot);
    const child = spawn(this.#resolvedCommand, [...this.#args], {
      cwd: this.#projectRoot,
      env: this.#environment,
      stdio: 'pipe',
      windowsHide: true,
    });
    this.#child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (this.#child === child) this.#receiveChunk(chunk);
    });
    this.#stderrBuffer = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (this.#child !== child) return;
      // Diagnostics go to the host's log, never into an error the model reads: a
      // traceback is multi-line, which is exactly what a fenced tool result cannot
      // carry safely. Redacted on the way out even so — the host log is a file on
      // disk that outlives the session, so it is the worse of the two places for a
      // secret to land, not the safer one. The Python side scrubs cookies and the
      // nonce at source; this catches the credentials this process can see.
      // stdout is the MCP protocol stream and is never touched here.
      this.#receiveDiagnostics(chunk);
    });
    // Whatever was still waiting for a newline when the helper stopped.
    child.stderr.on('end', () => {
      this.#flushDiagnostics(this.#stderrBuffer);
      this.#stderrBuffer = '';
    });
    child.on('error', (error) => {
      if (this.#child !== child) return;
      this.#child = undefined;
      this.#stdoutBuffer = '';
      this.#failAll(new LiveBridgeError(`Could not start the live connector: ${error.message}`));
    });
    child.on('exit', (code, signal) => {
      if (this.#child !== child) return;
      this.#child = undefined;
      this.#stdoutBuffer = '';
      const ending = signal === null ? `exit code ${String(code)}` : `signal ${signal}`;
      this.#failAll(
        new LiveBridgeError(
          `Live connector stopped with ${ending}. Its diagnostic output was written to the MCP server log, not returned here.`,
        ),
      );
    });
    return child;
  }

  /**
   * Redaction works on whole lines. A pipe hands text over in whatever chunks it
   * likes, and a password split across two of them matched neither, so text is
   * held until its newline arrives — or until there is too much of it to hold.
   */
  #receiveDiagnostics(chunk: string): void {
    this.#stderrBuffer += chunk;
    const lastNewline = this.#stderrBuffer.lastIndexOf('\n');
    if (lastNewline !== -1) {
      this.#flushDiagnostics(this.#stderrBuffer.slice(0, lastNewline + 1));
      this.#stderrBuffer = this.#stderrBuffer.slice(lastNewline + 1);
    }
    if (this.#stderrBuffer.length > MAX_PENDING_DIAGNOSTIC_CHARACTERS) {
      this.#flushDiagnostics(this.#stderrBuffer);
      this.#stderrBuffer = '';
    }
  }

  #flushDiagnostics(text: string): void {
    if (text !== '') this.#diagnostics(redactSecrets(text, this.#environment));
  }

  #send(method: LiveMethod, params: JsonObject): Promise<LiveResult> {
    const child = this.#start();
    const id = this.#nextId;
    this.#nextId += 1;

    return new Promise<LiveResult>((resolveCall, rejectCall) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        this.#terminateAfterTimeout(method);
        rejectCall(
          new LiveBridgeError(
            `Live operation ${method} timed out; its outcome is unknown, so do not retry it automatically.`,
          ),
        );
      }, this.#timeoutMs);
      this.#pending.set(id, { resolve: resolveCall, reject: rejectCall, timer });

      const request = JSON.stringify({ id, method, params });
      child.stdin.write(`${request}\n`, 'utf8', (error) => {
        if (error === null || error === undefined) return;
        const pending = this.#pending.get(id);
        if (pending === undefined) return;
        clearTimeout(pending.timer);
        this.#pending.delete(id);
        pending.reject(new LiveBridgeError(`Could not send live operation: ${error.message}`));
        this.#terminate();
      });
    });
  }

  #receiveChunk(chunk: string): void {
    this.#stdoutBuffer += chunk;
    while (true) {
      const newline = this.#stdoutBuffer.indexOf('\n');
      if (newline === -1) {
        if (this.#stdoutBuffer.length > this.#maxReplyCharacters) {
          this.#failAll(new LiveBridgeError('Live connector returned an oversized response'));
          this.#terminate();
        }
        return;
      }

      let line = this.#stdoutBuffer.slice(0, newline);
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.length > this.#maxReplyCharacters) {
        this.#failAll(new LiveBridgeError('Live connector returned an oversized response'));
        this.#terminate();
        return;
      }
      this.#receive(line);
      if (this.#child === undefined) return;
    }
  }

  #receive(line: string): void {
    let decoded: unknown;
    try {
      decoded = JSON.parse(line);
    } catch {
      this.#failAll(new LiveBridgeError('Live connector returned malformed JSON'));
      this.#terminate();
      return;
    }
    if (!isReply(decoded)) {
      this.#failAll(new LiveBridgeError('Live connector returned an invalid response'));
      this.#terminate();
      return;
    }

    const pending = this.#pending.get(decoded.id);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.#pending.delete(decoded.id);
    if (decoded.ok) {
      pending.resolve({
        value: decoded.result === undefined ? null : decoded.result,
        unverified: decoded.unverified === true,
      });
    } else {
      pending.reject(new LiveBridgeError(decoded.error ?? 'Live operation failed'));
    }
  }

  #terminateAfterTimeout(method: LiveMethod): void {
    this.#failAll(
      new LiveBridgeError(
        `Live connector was restarted after ${method} timed out; pending outcomes are unknown.`,
      ),
    );
    this.#terminate();
  }

  #terminate(): void {
    const child = this.#child;
    this.#child = undefined;
    this.#stdoutBuffer = '';
    if (child !== undefined && child.exitCode === null) child.kill();
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
