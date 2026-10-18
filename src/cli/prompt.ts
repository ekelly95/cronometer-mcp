import { createInterface, type Interface } from 'node:readline';

/**
 * Terminal questions for the setup commands, all through one line reader.
 *
 * One reader rather than one per question: a reader takes whatever input is
 * already buffered, so a second one opened after it would miss answers that were
 * piped or pasted ahead. A hidden answer is read with echo suppressed, so a
 * password never appears on screen or in a terminal's scrollback.
 */

type MutableInterface = Interface & { _writeToOutput?: ((text: string) => void) | undefined; output?: NodeJS.WritableStream };

let reader: MutableInterface | undefined;
const pending: string[] = [];
const waiting: ((line: string | undefined) => void)[] = [];
let ended = false;

function lines(): MutableInterface {
  if (reader !== undefined) return reader;
  reader = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY === true }) as MutableInterface;
  reader.on('line', (line) => {
    const next = waiting.shift();
    if (next !== undefined) next(line);
    else pending.push(line);
  });
  reader.on('close', () => {
    ended = true;
    for (const next of waiting.splice(0)) next(undefined);
  });
  return reader;
}

function nextLine(): Promise<string> {
  lines();
  const buffered = pending.shift();
  if (buffered !== undefined) return Promise.resolve(buffered);
  if (ended) return Promise.reject(new Error('Input ended before setup finished.'));
  return new Promise((resolve, reject) => {
    waiting.push((line) => (line === undefined ? reject(new Error('Input ended before setup finished.')) : resolve(line)));
  });
}

export async function ask(question: string, fallback?: string): Promise<string> {
  const suffix = fallback === undefined ? '' : ` [${fallback}]`;
  process.stdout.write(`${question}${suffix}: `);
  if (process.stdin.isTTY !== true) process.stdout.write('\n');
  const trimmed = (await nextLine()).trim();
  return trimmed === '' && fallback !== undefined ? fallback : trimmed;
}

export async function askHidden(question: string): Promise<string> {
  const rl = lines();
  process.stdout.write(`${question}: `);
  if (process.stdin.isTTY !== true) {
    process.stdout.write('\n');
    return nextLine();
  }
  // readline echoes each keystroke through _writeToOutput; swallow it while the
  // answer is typed, then put it back.
  const original = rl._writeToOutput;
  rl._writeToOutput = (text: string): void => {
    if (text.includes('\n') || text.includes('\r')) rl.output?.write('\n');
  };
  try {
    return await nextLine();
  } finally {
    rl._writeToOutput = original;
  }
}

export async function confirm(question: string, fallback = false): Promise<boolean> {
  const answer = (await ask(`${question} (${fallback ? 'Y/n' : 'y/N'})`)).toLowerCase();
  if (answer === '') return fallback;
  return answer === 'y' || answer === 'yes';
}

export function closePrompts(): void {
  reader?.close();
  reader = undefined;
}
