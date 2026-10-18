/**
 * Just enough GWT-RPC to read and write the handful of things Cronometer's mobile
 * API does not expose: macro-target templates and the weekly schedule, deleting
 * and cancelling fasts, repeated foods, and the CSV export's auth token.
 *
 * Ported from the vendored Python client this project used before (itself from
 * cronometer-mcp 2.0.3 by Paul Hoskins, MIT; see THIRD_PARTY_NOTICES.md). The
 * hard-won corrections it carried are kept: a response is never read as empty
 * unless Cronometer confirms it is, numbers never take exponent form, and the
 * repeated-items stream is walked rather than scanned.
 *
 * A response looks like `//OK[<data...>,[<string table>],0,7]`. The data section
 * is written in reverse of its logical order; references into the string table
 * are 1-based.
 */

export type GwtToken = number | string | null;

export class GwtResponseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'GwtResponseError';
  }
}

export interface GwtResponse {
  readonly strings: readonly string[];
  readonly tokens: readonly GwtToken[];
}

const CLOSING = ',0,7]';

function stringTableStart(raw: string): number {
  const close = raw.length - CLOSING.length - 1;
  let depth = 1;
  let position = close - 1;
  let inString = false;
  while (position >= 0 && depth > 0) {
    const character = raw[position];
    if (character === '"' && raw[position - 1] !== '\\') inString = !inString;
    else if (!inString) {
      if (character === ']') depth += 1;
      else if (character === '[') depth -= 1;
    }
    position -= 1;
  }
  return position + 1;
}

export function parseGwt(raw: string): GwtResponse {
  if (!raw.startsWith('//OK[') || !raw.endsWith(CLOSING)) {
    throw new GwtResponseError('Cronometer did not return a readable response.');
  }
  const open = stringTableStart(raw);
  const close = raw.length - CLOSING.length;
  let strings: unknown;
  try {
    strings = JSON.parse(raw.slice(open, close));
  } catch {
    throw new GwtResponseError('Cronometer returned a response whose string table could not be read.');
  }
  if (!Array.isArray(strings) || strings.some((entry) => typeof entry !== 'string')) {
    throw new GwtResponseError('Cronometer returned a response whose string table could not be read.');
  }

  const data = raw.slice(5, open).replace(/,+$/, '');
  const tokens: GwtToken[] = [];
  if (data !== '') {
    for (const part of data.split(',')) {
      const trimmed = part.trim();
      if (trimmed === '') continue;
      if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
        tokens.push(trimmed.slice(1, -1));
        continue;
      }
      const value = Number(trimmed);
      tokens.push(/^-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?$/.test(trimmed) && Number.isFinite(value) ? value : null);
    }
  }
  return { strings: strings as string[], tokens };
}

/**
 * Is this Cronometer saying "there are none"? An empty collection names only
 * container types in its string table and starts with a size of zero:
 * `//OK[0,1,["java.util.ArrayList/4159755760"],0,7]`. Anything else that a parser
 * cannot read is a changed format, and must not be reported as empty.
 */
export function isConfirmedEmpty(response: GwtResponse): boolean {
  return response.strings.every((entry) => entry.startsWith('java.util.')) && response.tokens[0] === 0;
}

/** A number as a GWT body expects it: integers bare, never an exponent. */
export function gwtNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error('Refusing to send a non-finite number to Cronometer.');
  if (Number.isInteger(value)) return String(value);
  const text = String(value);
  if (!/e/i.test(text)) return text;
  return value.toFixed(20).replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * Text is interpolated into a pipe-delimited body, so a `|` would split a field
 * and a backslash would start an escape. Inputs are validated for this already;
 * this is the second check, at the point where it actually matters.
 */
export function gwtText(value: string): string {
  if (/[|\\{}]/.test(value) || [...value].some((character) => character.charCodeAt(0) < 32)) {
    throw new Error('Text contains a character the Cronometer web protocol cannot encode safely.');
  }
  return value;
}

export interface RepeatedItem {
  readonly repeat_item_id: number;
  readonly food_name: string | null;
  readonly food_id: number;
  readonly measure_id: number;
  readonly quantity: number;
  readonly days_of_week: readonly number[];
  /** The time of day the entry is added at, when the rule has one. */
  readonly time: string | null;
  /** Cronometer does not return it; null rather than a guess. */
  readonly diary_group: null;
}

/**
 * Reads a GWT object stream: each object is introduced by a positive reference to
 * its type in the string table, a negative number refers back to an object
 * already read (GWT numbers objects in the order it writes them, from 1), and 0
 * is null. Only the types a repeated-foods response uses are understood; anything
 * else fails loudly rather than being skipped.
 *
 * The back-references matter. GWT sends each distinct Integer once, so the second
 * rule's weekday list is a run of references to the first rule's Integers. A
 * reader that expected values there — as the previous one did — fails on any
 * account with more than one rule.
 */
class GwtStream {
  readonly #stream: GwtToken[];
  readonly #strings: readonly string[];
  readonly #objects: unknown[] = [undefined];
  #cursor = 0;

  public constructor(response: GwtResponse) {
    this.#stream = [...response.tokens].reverse();
    this.#strings = response.strings;
  }

  public get finished(): boolean {
    return this.#cursor === this.#stream.length;
  }

  public get remaining(): number {
    return this.#stream.length - this.#cursor;
  }

  public take(what: string): GwtToken {
    if (this.#cursor >= this.#stream.length) {
      throw new GwtResponseError(`The response ended while reading ${what}; refusing to report a partly-read record.`);
    }
    const value = this.#stream[this.#cursor];
    this.#cursor += 1;
    return value ?? null;
  }

  public integer(what: string): number {
    const value = this.take(what);
    if (typeof value !== 'number' || !Number.isInteger(value)) throw new GwtResponseError(`Unreadable ${what} in the response.`);
    return value;
  }

  public number(what: string): number {
    const value = this.take(what);
    if (typeof value !== 'number') throw new GwtResponseError(`Unreadable ${what} in the response.`);
    return value;
  }

  /** A string field: an index into the string table, or 0 for null. */
  public string(what: string): string | null {
    const index = this.integer(what);
    if (index === 0) return null;
    const value = this.#strings[index - 1];
    if (value === undefined) throw new GwtResponseError(`Unreadable ${what} in the response.`);
    return value;
  }

  public object(what: string, readers: Readonly<Record<string, (stream: GwtStream, slot: number) => unknown>>): unknown {
    const token = this.integer(what);
    if (token === 0) return null;
    if (token < 0) {
      if (-token >= this.#objects.length) throw new GwtResponseError(`A reference to an object not yet read appeared in ${what}.`);
      return this.#objects[-token];
    }
    const type = this.#strings[token - 1];
    if (type === undefined) throw new GwtResponseError(`Unknown type reference in ${what}.`);
    const reader = Object.entries(readers).find(([prefix]) => type.includes(prefix))?.[1];
    if (reader === undefined) throw new GwtResponseError(`Unexpected type ${type.split('/')[0]} in ${what}; the response layout has changed.`);
    const slot = this.#objects.length;
    this.#objects.push(undefined);
    const value = reader(this, slot);
    this.#objects[slot] = value;
    return value;
  }

  public store(slot: number, value: unknown): void {
    this.#objects[slot] = value;
  }
}

/**
 * getRepeatedItems. A list of RepeatItem objects, each read field by field:
 * quantity, weekday list (Integers 0–6), a nullable Integer whose meaning is
 * unknown, food name, a flag, the rule id, food id, measure id, and a nullable
 * time of day. Pinned against a live account with three rules, and the reader
 * must consume the stream exactly.
 */
export function parseRepeatedItems(raw: string): { readonly items: RepeatedItem[]; readonly unverified: boolean } {
  const response = parseGwt(raw);
  if (response.tokens.length === 0 || !response.strings.some((entry) => entry.includes('RepeatItem/'))) {
    return { items: [], unverified: !isConfirmedEmpty(response) };
  }
  const stream = new GwtStream(response);

  const readers: Record<string, (stream: GwtStream, slot: number) => unknown> = {
    'java.util.ArrayList/': (input, slot) => {
      const count = input.integer('a list size');
      if (count < 0 || count > 10_000) throw new GwtResponseError('The response gave an impossible list size.');
      const list: unknown[] = [];
      input.store(slot, list);
      for (let index = 0; index < count; index += 1) list.push(input.object('a list element', readers));
      return list;
    },
    'java.lang.Integer/': (input) => input.integer('an integer'),
    'entries.models.Time/': (input) => {
      const hour = input.integer('an hour');
      const minute = input.integer('a minute');
      const second = input.integer('a second');
      return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;
    },
    'RepeatItem/': (input): RepeatedItem => {
      const quantity = input.number('a quantity');
      const days = input.object('a weekday list', readers);
      if (!Array.isArray(days) || days.some((day) => typeof day !== 'number' || day < 0 || day > 6)) {
        throw new GwtResponseError('A repeated food had an unreadable weekday list.');
      }
      input.object('an unidentified field', readers);
      const name = input.string('a food name');
      input.take('a flag');
      const id = input.integer('a repeat-item id');
      const foodSourceId = input.integer('a food id');
      const measureId = input.integer('a measure id');
      const time = input.object('a time of day', readers);
      return {
        repeat_item_id: id,
        food_name: name !== null && !name.startsWith('java.') && !name.startsWith('com.cronometer.') ? name : null,
        food_id: foodSourceId,
        measure_id: measureId,
        quantity,
        days_of_week: days as number[],
        time: typeof time === 'string' ? time : null,
        diary_group: null,
      };
    },
  };

  const list = stream.object('the list of repeated foods', readers);
  if (!Array.isArray(list)) throw new GwtResponseError('The repeated-foods response did not hold a list.');
  if (!stream.finished) {
    throw new GwtResponseError(
      `The repeated-foods response had ${stream.remaining} value(s) left over after ${list.length} record(s); the layout has changed, so none of it is reported.`,
    );
  }
  const items = list.filter((item): item is RepeatedItem => item !== null && typeof item === 'object');
  if (items.length !== list.length) throw new GwtResponseError('The repeated-foods list held something other than repeated foods.');
  return { items, unverified: false };
}
