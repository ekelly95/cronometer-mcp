import { createInterface } from 'node:readline';

/**
 * Terminal questions for `cronometer-mcp setup`. A hidden answer is read with the
 * terminal's echo suppressed, so a password never appears on screen or in a
 * terminal's scrollback.
 */

export async function ask(question: string, fallback?: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY === true });
  try {
    const suffix = fallback === undefined ? '' : ` [${fallback}]`;
    const answer = await new Promise<string>((resolve) => rl.question(`${question}${suffix}: `, resolve));
    const trimmed = answer.trim();
    return trimmed === '' && fallback !== undefined ? fallback : trimmed;
  } finally {
    rl.close();
  }
}

export async function askHidden(question: string): Promise<string> {
  if (process.stdin.isTTY !== true) {
    // Piped input (scripts, tests): nothing is echoed back anyway.
    return ask(question);
  }
  process.stdout.write(`${question}: `);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise<string>((resolve, reject) => {
    let value = '';
    const done = (error?: Error): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stdout.write('\n');
      if (error === undefined) resolve(value);
      else reject(error);
    };
    const onData = (chunk: string): void => {
      for (const character of chunk) {
        if (character === '\r' || character === '\n') return done();
        if (character === '\u0003') return done(new Error('Cancelled.'));
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
        else if (character >= ' ') value += character;
      }
    };
    stdin.on('data', onData);
  });
}

export async function confirm(question: string, fallback = false): Promise<boolean> {
  const answer = (await ask(`${question} (${fallback ? 'Y/n' : 'y/N'})`)).toLowerCase();
  if (answer === '') return fallback;
  return answer === 'y' || answer === 'yes';
}
