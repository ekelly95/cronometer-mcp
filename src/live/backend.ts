import { join } from 'node:path';

import { NUTRIENT_IDS, type NutrientId } from '../domain/nutrients.js';
import { credentialsConfigured, liveEnabled, readCredentials, type Credentials } from './credentials.js';
import {
  cronometerDay,
  foodIdsIn,
  isRecord,
  metricCatalog,
  nutritionServings,
  shapeDay,
  shapeFood,
  type JsonRecord,
} from './diary.js';
import {
  applyCustomFoodUpdate,
  assertPlainCustomFood,
  customFoodPayload,
  normalizeBarcodes,
  recipePayload,
  resendable,
  type CustomFoodInput,
  type CustomFoodUpdate,
  type RecipeIngredient,
} from './foods.js';
import { ALLOWED_HOSTS, LiveTimeoutError, type FetchLike } from './http.js';
import { MobileClient, CronometerApiError } from './mobile/client.js';
import { appIdentity } from './mobile/identity.js';
import { MOBILE_NUTRIENT_IDS } from './nutrient-ids.js';
import { redactSecrets, redactValues } from './redact.js';
import { WebClient, EXPORT_TYPES, type ExportType } from './web/client.js';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue | undefined;
}

/**
 * A live answer, and whether the connector could stand behind it.
 *
 * `unverified` means Cronometer answered, but an empty result could not be
 * confirmed as empty: the shape was not one this connector recognises, and an
 * empty record looks identical at that point.
 */
export interface LiveResult {
  readonly value: JsonValue;
  readonly unverified: boolean;
}

export const READ_METHODS = [
  'status',
  'check_connection',
  'export_raw',
  'get_diary',
  'get_nutrition_days',
  'get_nutrition_scores',
  'search_foods',
  'get_food_details',
  'lookup_barcode',
  'get_macro_targets',
  'list_macro_templates',
  'get_fasting_history',
  'get_fasting_stats',
  'list_biometric_metrics',
  'get_biometrics',
  'get_repeated_items',
  'search_activities',
] as const;

export const WRITE_METHODS = [
  'add_food_entry',
  'update_food_entry',
  'remove_diary_entries',
  'copy_day',
  'mark_day_complete',
  'add_note',
  'update_note',
  'add_biometric',
  'add_exercise',
  'add_custom_food',
  'update_custom_food',
  'retire_custom_food',
  'add_recipe',
  'import_recipe',
  'set_macro_targets',
  'create_macro_template',
  'delete_macro_template',
  'set_macro_schedule_day',
  'delete_fast',
  'cancel_active_fast',
  'add_repeat_item',
  'delete_repeat_item',
] as const;

export type ReadMethod = (typeof READ_METHODS)[number];
export type WriteMethod = (typeof WRITE_METHODS)[number];
export type LiveMethod = ReadMethod | WriteMethod;

export const MUTATING_LIVE_METHODS: ReadonlySet<LiveMethod> = new Set<LiveMethod>(WRITE_METHODS);

export class LiveBackendError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'LiveBackendError';
  }
}

export interface LiveBackendOptions {
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  /** The diary timezone, for stamping the time of a new entry. */
  readonly timeZone?: string;
  readonly fetch?: FetchLike;
  readonly mobile?: MobileClient;
  readonly web?: WebClient;
  /** Floor between live calls. Tests set 0. */
  readonly minimumIntervalMs?: number;
  readonly diagnostics?: (text: string) => void;
}

/** How many days one diary read may cover: each day is a request. */
export const MAX_DIARY_DAYS = 14;
const MINIMUM_INTERVAL_MS = 350;
const RECIPE_IMPORT_TIMEOUT_MS = 60_000;

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
/** The mobile schedule numbers weekdays 1 (Monday) through 7 (Sunday), like java.time. */
const ISO_WEEKDAY_NAMES = ['', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;

// ── Parameter checks ────────────────────────────────────────────────────
// The MCP layer validates every input against its schema first. These are the
// second line, at the point where a value is about to be sent: cheap, and they
// mean a future tool wired up without a schema still cannot send nonsense.

function text(params: JsonObject, name: string, maximum = 500): string {
  const value = params[name];
  if (typeof value !== 'string' || value.trim() === '' || value.length > maximum) {
    throw new LiveBackendError(`${name} must be non-empty text of at most ${maximum} characters`);
  }
  return value;
}

function optionalText(params: JsonObject, name: string, maximum = 500): string | undefined {
  return params[name] === undefined ? undefined : text(params, name, maximum);
}

function integer(params: JsonObject, name: string, minimum = 1, maximum = Number.MAX_SAFE_INTEGER): number {
  const value = params[name];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new LiveBackendError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function optionalInteger(params: JsonObject, name: string, minimum = 1, maximum = Number.MAX_SAFE_INTEGER): number | undefined {
  return params[name] === undefined ? undefined : integer(params, name, minimum, maximum);
}

function number(params: JsonObject, name: string, minimum = 0, maximum = 100_000): number {
  const value = params[name];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new LiveBackendError(`${name} must be a number from ${minimum} to ${maximum}`);
  }
  return value;
}

function optionalNumber(params: JsonObject, name: string, minimum = 0, maximum = 100_000): number | undefined {
  return params[name] === undefined ? undefined : number(params, name, minimum, maximum);
}

function isoDay(params: JsonObject, name: string): string {
  const value = params[name];
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new LiveBackendError(`${name} must be a date in YYYY-MM-DD form`);
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new LiveBackendError(`${name} must be a real calendar date`);
  }
  return value;
}

function daysBetween(start: string, end: string, maximum: number): string[] {
  if (end < start) throw new LiveBackendError('end_date must not be before start_date');
  const days: string[] = [];
  for (let time = Date.parse(`${start}T00:00:00Z`); time <= Date.parse(`${end}T00:00:00Z`); time += 86_400_000) {
    days.push(new Date(time).toISOString().slice(0, 10));
    if (days.length > maximum) throw new LiveBackendError(`a live diary read may cover at most ${maximum} days`);
  }
  return days;
}

function range(params: JsonObject, maximum: number): string[] {
  return daysBetween(isoDay(params, 'start_date'), isoDay(params, 'end_date'), maximum);
}

const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** Only the primitive fields of a record, for shapes this connector has not pinned down. */
function primitives(record: JsonRecord): JsonObject {
  const result: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
      result[key] = value;
    }
  }
  return result;
}

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
}

/** The clock time now in the diary timezone, as Cronometer writes it: `7:5:30`. */
function clockIn(timeZone: string | undefined): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timeZone ?? 'UTC',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const pick = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return `${pick('hour')}:${pick('minute')}:${pick('second')}`;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

/** The id key get_diary uses for each entry type, and the key the v3 delete wants. */
const ENTRY_ID_KEYS: Readonly<Record<string, string>> = {
  Serving: 'servingId',
  Exercise: 'exerciseId',
  Note: 'noteId',
  Biometric: 'biometricId',
};

export class CronometerBackend {
  readonly #environment: Readonly<NodeJS.ProcessEnv>;
  readonly #timeZone: string | undefined;
  readonly #mobile: MobileClient;
  readonly #web: WebClient;
  readonly #minimumIntervalMs: number;
  readonly #diagnostics: (text: string) => void;
  readonly #dataDirectory: string | undefined;
  #queue: Promise<void> = Promise.resolve();
  #lastCallAt = 0;
  #catalog: Map<number, { readonly name: string; readonly unit: string }> | undefined;

  public constructor(options: LiveBackendOptions = {}) {
    this.#environment = options.environment ?? process.env;
    this.#timeZone = options.timeZone;
    const directory = this.#environment['CRONOMETER_DATA_DIR']?.trim();
    this.#dataDirectory = directory === undefined || directory === '' ? undefined : directory;
    const credentials = (): Credentials => readCredentials(this.#environment);
    this.#mobile =
      options.mobile ??
      new MobileClient({
        credentials,
        ...(this.#dataDirectory === undefined ? {} : { sessionPath: join(this.#dataDirectory, '.mobile-session.json') }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        identity: appIdentity(this.#environment),
      });
    this.#web =
      options.web ??
      new WebClient({
        credentials,
        ...(this.#dataDirectory === undefined ? {} : { sessionPath: join(this.#dataDirectory, '.web-session.json') }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });
    this.#minimumIntervalMs = options.minimumIntervalMs ?? MINIMUM_INTERVAL_MS;
    this.#diagnostics = options.diagnostics ?? ((line: string): void => void process.stderr.write(line));
  }

  /**
   * One call at a time, with a floor between them. Nothing else stops a model
   * reading fifty days back to back, and a burst against an interface Cronometer
   * never published is the likeliest way an account gets noticed.
   */
  public call(method: LiveMethod, params: JsonObject = {}): Promise<LiveResult> {
    const operation = this.#queue.then(() => this.#run(method, params));
    this.#queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  public async close(): Promise<void> {
    await this.#queue;
  }

  async #run(method: LiveMethod, params: JsonObject): Promise<LiveResult> {
    try {
      return await this.#dispatch(method, params);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Live operation failed';
      const safe = this.#redact(message);
      if (!(error instanceof LiveBackendError || error instanceof CronometerApiError)) {
        this.#diagnostics(`[cronometer] ${method} failed: ${safe}\n`);
      }
      if (error instanceof LiveTimeoutError && MUTATING_LIVE_METHODS.has(method)) {
        throw new LiveBackendError(`${safe} Check the Cronometer app before trying again.`);
      }
      throw new LiveBackendError(safe);
    }
  }

  #redact(text: string): string {
    return redactValues(redactSecrets(text, this.#environment), [...this.#mobile.secrets(), ...this.#web.secrets()]);
  }

  async #pace(): Promise<void> {
    if (this.#minimumIntervalMs <= 0) return;
    const wait = this.#lastCallAt + this.#minimumIntervalMs - Date.now();
    if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait));
    this.#lastCallAt = Date.now();
  }

  async #read(endpoint: string, payload: JsonRecord = {}): Promise<JsonRecord> {
    await this.#pace();
    return this.#mobile.read(endpoint, { config: { call_version: 1 }, ...payload });
  }

  async #write(endpoint: string, payload: JsonRecord): Promise<JsonRecord> {
    await this.#pace();
    return this.#mobile.write(endpoint, payload);
  }

  async #diaryDay(day: string): Promise<JsonRecord> {
    return this.#read('get_diary', { day: cronometerDay(day) });
  }

  async #foods(ids: readonly number[]): Promise<Map<number, JsonRecord>> {
    const foods = new Map<number, JsonRecord>();
    for (const batch of chunks(ids, 100)) {
      const response = await this.#read('get_foods', { ids: batch });
      const list = Array.isArray(response['foods']) ? response['foods'].filter(isRecord) : [];
      for (const food of list) if (typeof food['id'] === 'number') foods.set(food['id'], food);
    }
    return foods;
  }

  async #food(foodId: number): Promise<JsonRecord> {
    const food = await this.#read('get_food', { id: foodId });
    if (typeof food['id'] !== 'number') throw new LiveBackendError(`Food ${foodId} was not found.`);
    return food;
  }

  async #nutrientCatalog(): Promise<Map<number, { readonly name: string; readonly unit: string }>> {
    if (this.#catalog !== undefined) return this.#catalog;
    const profile = await this.#mobile.profile();
    let nutrients = profile.nutrients;
    if (nutrients.length === 0) {
      const response = await this.#read('get_nutrients', { day: cronometerDay(new Date().toISOString().slice(0, 10)) });
      nutrients = Array.isArray(response['nutrients']) ? response['nutrients'].filter(isRecord) : [];
    }
    const catalog = new Map<number, { readonly name: string; readonly unit: string }>();
    for (const nutrient of nutrients) {
      const id = finite(nutrient['id']);
      const name = str(nutrient['name']);
      const unit = str(nutrient['unit']);
      if (id !== null && name !== null && unit !== null) catalog.set(id, { name, unit });
    }
    this.#catalog = catalog;
    return catalog;
  }

  async #dispatch(method: LiveMethod, params: JsonObject): Promise<LiveResult> {
    const done = (value: unknown, unverified = false): LiveResult => ({ value: json(value), unverified });

    switch (method) {
      case 'status':
        return done(this.#status());

      case 'check_connection': {
        const session = await this.#mobile.session();
        await this.#read('get_macro_target_templates');
        return done({ connected: true, account_timezone: session.timezone });
      }

      case 'export_raw': {
        const type = text(params, 'export_type', 32);
        if (!(type in EXPORT_TYPES)) throw new LiveBackendError('export_type is not supported');
        const days = range(params, 366);
        await this.#pace();
        return done(await this.#web.exportCsv(type as ExportType, days[0]!, days[days.length - 1]!));
      }

      case 'get_diary': {
        const days = range(params, MAX_DIARY_DAYS);
        const raw: JsonRecord[] = [];
        for (const day of days) raw.push(await this.#diaryDay(day));
        const foods = await this.#foods(foodIdsIn(raw));
        const metrics = metricCatalog((await this.#mobile.profile()).metrics);
        return done({ days: raw.map((day, index) => shapeDay(days[index]!, day, foods, metrics)) });
      }

      case 'get_nutrition_days': {
        const days = range(params, MAX_DIARY_DAYS);
        const raw: JsonRecord[] = [];
        for (const day of days) raw.push(await this.#diaryDay(day));
        const foods = await this.#foods(foodIdsIn(raw));
        const targets: Partial<Record<NutrientId, JsonObject>> = {};
        for (const target of (await this.#mobile.profile()).targets) {
          const id = NUTRIENT_IDS.find((candidate) => MOBILE_NUTRIENT_IDS[candidate] === target['id']);
          if (id === undefined) continue;
          targets[id] = { min: finite(target['min']), max: finite(target['max']) };
        }
        return done({
          days: raw.map((day, index) => ({
            date: days[index]!,
            complete: isRecord(day['info']) && typeof day['info']['complete'] === 'boolean' ? day['info']['complete'] : null,
            servings: nutritionServings(day, foods),
          })),
          targets,
        });
      }

      case 'get_nutrition_scores': {
        const day = isoDay(params, 'date');
        const diary = await this.#diaryDay(day);
        const entries = Array.isArray(diary['diary']) ? diary['diary'].filter(isRecord) : [];
        const servingIds = entries.filter((entry) => entry['type'] === 'Serving' && entry['servingId'] !== undefined).map((entry) => entry['servingId']);
        if (servingIds.length === 0) return done({ date: day, categories: [], note: 'No food is logged on this day, so there is nothing to score.' });
        const scores = await this.#read('get_nutrition_scores', {
          startDay: '1900-1-1',
          endDay: '1900-1-1',
          servingIds,
          supplements: 'true',
        });
        const catalog = await this.#nutrientCatalog();
        const categories = (Array.isArray(scores['scores']) ? scores['scores'].filter(isRecord) : []).map((category) => ({
          title: str(category['title']),
          score: finite(category['score']),
          nutrients: (Array.isArray(category['components']) ? category['components'].filter(isRecord) : []).map((component) => {
            const id = finite(component['nutrientId']);
            const label = id === null ? undefined : catalog.get(id);
            return {
              nutrient_id: id,
              name: label?.name ?? null,
              unit: label?.unit ?? null,
              amount: finite(component['amount']),
              confidence: finite(component['confidence']),
            };
          }),
        }));
        return done({ date: day, categories }, categories.length === 0);
      }

      case 'search_foods': {
        const query = text(params, 'query', 200);
        const maximum = optionalInteger(params, 'max_results', 1, 50) ?? 20;
        const response = await this.#read('find_food', {
          query,
          tab: 'ALL',
          sources: ['All'],
          config: { newSearch: true, newSpellcheck: true, call_version: 1 },
        });
        const foods = (Array.isArray(response['foods']) ? response['foods'].filter(isRecord) : [])
          .filter((food) => typeof food['id'] === 'number' && typeof food['name'] === 'string')
          .slice(0, maximum)
          .map((food) => ({
            food_id: food['id'],
            name: food['name'],
            source: str(food['source']),
            default_measure_id: finite(food['measureId']),
            default_measure: str(food['measureDisplayName']),
          }));
        return done({ query, foods });
      }

      case 'get_food_details': {
        const food = await this.#food(integer(params, 'food_id'));
        return done(shapeFood(food, await this.#nutrientCatalog()));
      }

      case 'lookup_barcode': {
        const [code] = normalizeBarcodes([text(params, 'barcode', 32)]);
        if (code === undefined || /^0+$/.test(code)) throw new LiveBackendError('That barcode is all zeros, not a product code.');
        const response = await this.#read('barcode', { query: code, config: { call_version: 2 } });
        const catalog = await this.#nutrientCatalog();
        const foods = (Array.isArray(response['foods']) ? response['foods'].filter(isRecord) : []).filter(
          (food) =>
            Array.isArray(food['barcodes']) &&
            food['barcodes'].some((candidate) => typeof candidate === 'string' && candidate.replace(/^0+/, '') === code.replace(/^0+/, '')),
        );
        return done({ barcode: code, foods: foods.map((food) => shapeFood(food, catalog)) });
      }

      case 'get_macro_targets': {
        if (params['all_days'] === true) {
          const response = await this.#read('get_macro_schedules');
          const schedules = (Array.isArray(response['schedules']) ? response['schedules'].filter(isRecord) : []).map((entry) => {
            const template = isRecord(entry['macroTargetTemplate']) ? entry['macroTargetTemplate'] : {};
            const value = isRecord(entry['dayOfWeek']) ? finite(entry['dayOfWeek']['value']) : null;
            return {
              weekday: value !== null && value >= 1 && value <= 7 ? ISO_WEEKDAY_NAMES[value] : null,
              ...this.#template(template),
            };
          });
          return done({ schedule: schedules }, schedules.length === 0);
        }
        const day = isoDay(params, 'date');
        const shaped = shapeDay(day, await this.#diaryDay(day), new Map(), metricCatalog([]));
        return done({ date: day, targets: shaped['targets'] ?? null });
      }

      case 'list_macro_templates': {
        const response = await this.#read('get_macro_target_templates');
        const templates = Array.isArray(response['templates']) ? response['templates'].filter(isRecord) : [];
        return done({ templates: templates.map((template) => this.#template(template)) });
      }

      case 'get_fasting_history': {
        const today = new Date().toISOString().slice(0, 10);
        const end = params['end_date'] === undefined ? today : isoDay(params, 'end_date');
        const start =
          params['start_date'] === undefined
            ? new Date(Date.parse(`${end}T00:00:00Z`) - 365 * 86_400_000).toISOString().slice(0, 10)
            : isoDay(params, 'start_date');
        daysBetween(start, end, 3660);
        const response = await this.#read('get_fasting_with_date_range', { start: cronometerDay(start), end: cronometerDay(end) });
        const fasts = Array.isArray(response['fasts']) ? response['fasts'].filter(isRecord).map(primitives) : [];
        return done({ start_date: start, end_date: end, fasts });
      }

      case 'get_fasting_stats': {
        const response = await this.#read('get_fasting_stats');
        const stats = isRecord(response['fastingStats']) ? response['fastingStats'] : undefined;
        if (stats === undefined) return done({}, true);
        return done({
          completed_fasts: finite(stats['completedFasts']),
          total_hours: finite(stats['totalHoursFasting']),
          longest_fast_hours: finite(stats['longestFastInHours']),
          last_7_fasts_average_hours: finite(stats['last7FastsAvgInHours']),
        });
      }

      case 'list_biometric_metrics': {
        let metrics = (await this.#mobile.profile()).metrics;
        if (metrics.length === 0) {
          const response = await this.#read('get_metrics');
          metrics = Array.isArray(response['metrics']) ? response['metrics'].filter(isRecord) : [];
        }
        return done({
          metrics: metrics.map((metric) => ({
            metric_id: finite(metric['id']),
            name: str(metric['name']),
            units: (Array.isArray(metric['units']) ? metric['units'].filter(isRecord) : []).map((unit) => ({
              unit_id: finite(unit['id']),
              name: str(unit['name']),
            })),
          })),
        });
      }

      case 'get_biometrics': {
        const metricId = integer(params, 'metric_id');
        const days = range(params, 3660);
        const profile = await this.#mobile.profile();
        const metric = profile.metrics.find((candidate) => candidate['id'] === metricId);
        const units = metric !== undefined && Array.isArray(metric['units']) ? metric['units'].filter(isRecord) : [];
        const unitId = optionalInteger(params, 'unit_id') ?? finite(this.#preferredUnit(metricId, units, profile.prefs['weightUnit']));
        if (unitId === null) throw new LiveBackendError(`Metric ${metricId} has no unit to report it in; pass unit_id from list_biometric_metrics.`);
        const response = await this.#read('get_biometrics', {
          metricId,
          unitId,
          start: cronometerDay(days[0]!),
          end: cronometerDay(days[days.length - 1]!),
        });
        const catalog = metricCatalog(profile.metrics);
        const readings = (Array.isArray(response['data']) ? response['data'].filter(isRecord) : []).map((reading) => ({
          date: str(reading['day']),
          time: str(reading['time']),
          value: finite(reading['value']),
        }));
        return done({
          metric_id: metricId,
          metric: catalog.name(metricId),
          unit_id: unitId,
          unit: catalog.unit(metricId, unitId),
          readings,
          note: 'Several readings on one day are averaged by Cronometer here; get_diary lists each one with its id.',
        });
      }

      case 'get_repeated_items': {
        await this.#pace();
        const { items, unverified } = await this.#web.repeatedItems();
        return done({ items }, unverified);
      }

      case 'search_activities': {
        const query = text(params, 'query', 100).toLowerCase();
        const forest = await this.#read('get_activity_forest');
        const legacy = await this.#read('all_legacy_activities');
        const activities: { activity_id: number; name: string; legacy: boolean }[] = [];
        const map = isRecord(forest['activitiesMap']) ? Object.values(forest['activitiesMap']) : [];
        for (const activity of map) {
          if (isRecord(activity) && typeof activity['id'] === 'number' && typeof activity['name'] === 'string') {
            activities.push({ activity_id: activity['id'], name: activity['name'], legacy: false });
          }
        }
        for (const activity of Array.isArray(legacy['activities']) ? legacy['activities'] : []) {
          if (isRecord(activity) && typeof activity['id'] === 'number' && typeof activity['name'] === 'string') {
            activities.push({ activity_id: activity['id'], name: activity['name'], legacy: true });
          }
        }
        const words = query.split(/\s+/).filter(Boolean);
        const matches = activities.filter((activity) => words.every((word) => activity.name.toLowerCase().includes(word))).slice(0, 50);
        return done({ query, activities: matches });
      }

      // ── Writes ───────────────────────────────────────────────────────────

      case 'add_food_entry':
        return done(await this.#addFoodEntry(params));

      case 'update_food_entry':
        return done(await this.#updateFoodEntry(params));

      case 'remove_diary_entries':
        return done(await this.#removeEntries(params));

      case 'copy_day': {
        const source = isoDay(params, 'source_date');
        const destination = isoDay(params, 'destination_date');
        if (source === destination) throw new LiveBackendError('source_date and destination_date must be different');
        await this.#write('copy', { from: cronometerDay(source), to: cronometerDay(destination), diaryGroupNumber: null, config: { call_version: 1 } });
        return done({ copied: true, source_date: source, destination_date: destination });
      }

      case 'mark_day_complete': {
        const day = isoDay(params, 'date');
        const complete = params['complete'] !== false;
        await this.#write('set_complete', { day: cronometerDay(day), complete, config: { call_version: 1 } });
        return done({ date: day, complete });
      }

      case 'add_note': {
        const day = isoDay(params, 'date');
        const group = integer(params, 'diary_group', 1, 4);
        const saved = await this.#saveNote(0, text(params, 'text', 5_000), cronometerDay(day), (group << 16) | 1);
        return done({ note_id: finite(saved['noteId']), date: day, diary_group: group });
      }

      case 'update_note': {
        const day = isoDay(params, 'date');
        const noteId = integer(params, 'note_id');
        const diary = await this.#diaryDay(day);
        const entries = Array.isArray(diary['diary']) ? diary['diary'].filter(isRecord) : [];
        const note = entries.find((entry) => entry['type'] === 'Note' && entry['noteId'] === noteId);
        if (note === undefined) throw new LiveBackendError(`No note ${noteId} is on ${day}. Read the day with get_diary to find its id.`);
        const saved = await this.#saveNote(noteId, text(params, 'text', 5_000), str(note['day']) ?? cronometerDay(day), finite(note['order']) ?? 65537);
        return done({ note_id: finite(saved['noteId']), date: day, updated: true });
      }

      case 'add_biometric': {
        const day = isoDay(params, 'date');
        const metricId = integer(params, 'metric_id');
        const unitId = integer(params, 'unit_id');
        const amount = number(params, 'amount', 0, 100_000);
        const profile = await this.#mobile.profile();
        const catalog = metricCatalog(profile.metrics);
        const unit = catalog.unit(metricId, unitId);
        if (catalog.name(metricId) === null || unit === null) {
          throw new LiveBackendError(`Metric ${metricId} has no unit ${unitId}. Use list_biometric_metrics for valid ids.`);
        }
        const session = await this.#mobile.session();
        const response = await this.#write('add_biometric', {
          biometric: {
            biometricId: 0,
            type: 'Biometric',
            metricId,
            unitId,
            amount,
            day: cronometerDay(day),
            order: 1,
            meta: null,
            externalId: null,
            source: null,
            userId: session.userId,
          },
          config: { call_version: 1 },
        });
        const id = finite(response['id']);
        if (id === null) {
          throw new LiveBackendError('Cronometer accepted the reading, so it was probably recorded, but returned no id. Do not add it again; check get_diary for that day.');
        }
        return done({ biometric_id: id, date: day, metric: catalog.name(metricId), amount, unit });
      }

      case 'add_exercise': {
        const day = isoDay(params, 'date');
        const activityId = integer(params, 'activity_id');
        const minutes = number(params, 'minutes', 0.1, 1_440);
        const calories = number(params, 'calories_burned', 0, 20_000);
        const group = integer(params, 'diary_group', 1, 4);
        const profile = await this.#mobile.profile();
        const weightKg = Number(profile.prefs['weightInKG']);
        if (!Number.isFinite(weightKg) || weightKg <= 0) {
          throw new LiveBackendError('The Cronometer profile has no body weight, which logging exercise requires. Set one in the app first.');
        }
        const session = await this.#mobile.session();
        const response = await this.#write('add_exercise', {
          exercise: {
            exerciseId: null,
            type: 'Exercise',
            activityId,
            activitySpecId: null,
            minutes,
            calories: -calories,
            calorieOverride: true,
            weight: Math.round((weightKg / 0.45359237) * 10) / 10,
            day: cronometerDay(day),
            order: (group << 16) | 1,
            name: null,
            meta: null,
            externalId: null,
            source: null,
            userId: session.userId,
          },
          config: { call_version: 1 },
        });
        const id = finite(response['id']);
        if (id === null) throw new LiveBackendError('Cronometer accepted the exercise but returned no id. Do not add it again; check get_diary for that day.');
        return done({ exercise_id: id, date: day, activity_id: activityId, minutes, calories_burned: calories });
      }

      case 'add_custom_food': {
        const input: CustomFoodInput = {
          name: text(params, 'name', 200),
          serving_name: optionalText(params, 'serving_name', 100) ?? '1 serving',
          serving_grams: number(params, 'serving_grams', 0.01, 100_000),
          calories: number(params, 'calories', 0, 100_000),
          protein_g: number(params, 'protein_g', 0, 100_000),
          fat_g: number(params, 'fat_g', 0, 100_000),
          carbs_g: number(params, 'carbs_g', 0, 100_000),
          ...this.#optionalNumbers(params, ['fiber_g', 'sugars_g', 'sodium_mg', 'saturated_fat_g']),
          ...(Array.isArray(params['barcodes']) ? { barcodes: params['barcodes'].filter((code): code is string => typeof code === 'string') } : {}),
        };
        const response = await this.#write('add_food', customFoodPayload(input));
        const id = finite(response['id']);
        if (id === null) throw new LiveBackendError('Cronometer did not return an id for the new food. Check the app before trying again.');
        return done({ food_id: id, name: input.name });
      }

      case 'update_custom_food': {
        const foodId = integer(params, 'food_id');
        const food = await this.#food(foodId);
        assertPlainCustomFood(food, foodId);
        const update: CustomFoodUpdate = {
          ...(params['name'] === undefined ? {} : { name: text(params, 'name', 200) }),
          ...(params['serving_name'] === undefined ? {} : { serving_name: text(params, 'serving_name', 100) }),
          ...this.#optionalNumbers(params, ['calories', 'protein_g', 'fat_g', 'carbs_g', 'fiber_g', 'serving_grams']),
        };
        if (Object.keys(update).length === 0) throw new LiveBackendError('Give at least one field to change.');
        const response = await this.#write('add_food', { data: applyCustomFoodUpdate(food, update), config: { call_version: 1 } });
        if (response['id'] !== foodId) throw new LiveBackendError('Cronometer did not confirm the change. Check the food in the app before trying again.');
        return done({ food_id: foodId, updated: Object.keys(update) });
      }

      case 'retire_custom_food': {
        const foodId = integer(params, 'food_id');
        const food = await this.#food(foodId);
        assertPlainCustomFood(food, foodId);
        const copy = resendable(food);
        copy['retired'] = true;
        const response = await this.#write('add_food', { data: copy, config: { call_version: 1 } });
        if (response['id'] !== foodId) throw new LiveBackendError('Cronometer did not confirm retiring the food. Check the app.');
        return done({ food_id: foodId, name: str(food['name']), retired: true });
      }

      case 'add_recipe': {
        const name = text(params, 'name', 200);
        const ingredients = this.#ingredients(params['ingredients']);
        const foods = await this.#foods(ingredients.map((ingredient) => ingredient.food_id));
        const servingGrams = optionalNumber(params, 'serving_grams', 0.01, 100_000);
        const { payload, totalGrams } = recipePayload(name, ingredients, foods, optionalText(params, 'serving_name', 100) ?? 'Serving', servingGrams);
        const response = await this.#write('add_food', payload);
        const id = finite(response['id']);
        if (id === null) throw new LiveBackendError('Cronometer did not return an id for the new recipe. Check the app before trying again.');
        return done({ food_id: id, name, total_grams: totalGrams, ingredient_count: ingredients.length });
      }

      case 'import_recipe':
        return done(await this.#importRecipe(params));

      case 'set_macro_targets': {
        const day = isoDay(params, 'date');
        await this.#pace();
        await this.#web.setDailyTargets(day, this.#macros(params), text(params, 'template_name', 100));
        return done({ date: day, updated: true });
      }

      case 'create_macro_template': {
        const name = text(params, 'template_name', 100);
        await this.#pace();
        await this.#web.createMacroTemplate(name, this.#macros(params));
        const response = await this.#read('get_macro_target_templates');
        const created = (Array.isArray(response['templates']) ? response['templates'].filter(isRecord) : []).find((template) => template['name'] === name);
        return done({ template_name: name, template_id: created === undefined ? null : finite(created['id']) });
      }

      case 'delete_macro_template': {
        const templateId = integer(params, 'template_id');
        await this.#pace();
        await this.#web.deleteMacroTemplate(templateId);
        return done({ template_id: templateId, deleted: true });
      }

      case 'set_macro_schedule_day': {
        const weekday = text(params, 'weekday', 16).toLowerCase();
        const index = WEEKDAYS.indexOf(weekday as (typeof WEEKDAYS)[number]);
        if (index === -1) throw new LiveBackendError('weekday must be a day name such as "monday"');
        const templateId = integer(params, 'template_id', 0);
        await this.#pace();
        await this.#web.setScheduleDay(index, templateId);
        return done({ weekday, template_id: templateId });
      }

      case 'delete_fast': {
        const fastId = integer(params, 'fast_id');
        await this.#pace();
        await this.#web.deleteFast(fastId);
        return done({ fast_id: fastId, deleted: true });
      }

      case 'cancel_active_fast': {
        const fastId = integer(params, 'fast_id');
        await this.#pace();
        await this.#web.cancelFastKeepSeries(fastId);
        return done({ fast_id: fastId, cancelled: true });
      }

      case 'add_repeat_item': {
        const days = params['weekdays'];
        if (!Array.isArray(days) || days.length === 0) throw new LiveBackendError('weekdays must list at least one day');
        const indices = days.map((day) => WEEKDAYS.indexOf(String(day).toLowerCase() as (typeof WEEKDAYS)[number]));
        if (indices.some((index) => index === -1) || new Set(indices).size !== indices.length) {
          throw new LiveBackendError('weekdays must be distinct day names such as "monday"');
        }
        await this.#pace();
        await this.#web.addRepeatItem({
          foodSourceId: integer(params, 'food_id'),
          foodId: integer(params, 'measure_id'),
          quantity: number(params, 'quantity', 0.001, 100_000),
          foodName: text(params, 'food_name', 500),
          diaryGroup: integer(params, 'diary_group', 1, 4),
          daysOfWeek: indices,
        });
        return done({ created: true });
      }

      case 'delete_repeat_item': {
        const id = integer(params, 'repeat_item_id');
        await this.#pace();
        await this.#web.deleteRepeatItem(id);
        return done({ repeat_item_id: id, deleted: true });
      }
    }
  }

  #status(): JsonRecord {
    const identity = appIdentity(this.#environment);
    return {
      live_enabled: liveEnabled(this.#environment),
      credentials_configured: credentialsConfigured(this.#environment),
      two_factor_configured: Boolean(this.#environment['CRONOMETER_TOTP_SECRET']),
      data_directory_configured: this.#dataDirectory !== undefined,
      mobile_session_cached: (() => {
        try {
          return this.#mobile.hasCachedSession();
        } catch {
          return false;
        }
      })(),
      protocol: 'Cronometer mobile API, with the web app protocol for CSV exports, macro templates, fast edits and repeated foods',
      mobile_app_identity: `${identity.appVersion} (build ${identity.buildNumber})`,
      network_hosts: [...ALLOWED_HOSTS],
    };
  }

  #template(template: JsonRecord): JsonRecord {
    return {
      template_id: finite(template['id']),
      template_name: str(template['name']),
      energy_kcal: finite(template['energy']),
      protein_g: finite(template['protein']),
      carbs_g: finite(template['carbs']),
      fat_g: finite(template['fat']),
    };
  }

  #preferredUnit(metricId: number, units: readonly JsonRecord[], weightUnit: string | undefined): unknown {
    // Weight follows the account's display preference, everything else its first unit.
    if (metricId === 1) {
      const name = weightUnit === 'Pounds' ? 'lbs' : weightUnit === 'Kilograms' ? 'kg' : undefined;
      const preferred = units.find((unit) => unit['name'] === name);
      if (preferred !== undefined) return preferred['id'];
    }
    return units[0]?.['id'];
  }

  #optionalNumbers(params: JsonObject, names: readonly string[]): Record<string, number> {
    const result: Record<string, number> = {};
    for (const name of names) {
      const value = optionalNumber(params, name, 0, 100_000);
      if (value !== undefined) result[name] = value;
    }
    return result;
  }

  #macros(params: JsonObject): { protein_g: number; fat_g: number; carbs_g: number; calories: number } {
    return {
      protein_g: number(params, 'protein_g', 0, 2_000),
      fat_g: number(params, 'fat_g', 0, 2_000),
      carbs_g: number(params, 'carbs_g', 0, 5_000),
      calories: number(params, 'calories', 0, 20_000),
    };
  }

  #ingredients(raw: unknown): RecipeIngredient[] {
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > 100) {
      throw new LiveBackendError('ingredients must list 1 to 100 items');
    }
    return raw.map((item, index) => {
      if (!isRecord(item)) throw new LiveBackendError(`ingredient ${index + 1} must be an object`);
      const params = item as JsonObject;
      return { food_id: integer(params, 'food_id'), grams: number(params, 'grams', 0.01, 100_000) };
    });
  }

  async #addFoodEntry(params: JsonObject): Promise<JsonRecord> {
    const day = isoDay(params, 'date');
    const foodId = integer(params, 'food_id');
    const group = integer(params, 'diary_group', 1, 4);
    const food = await this.#food(foodId);
    const measures = Array.isArray(food['measures']) ? food['measures'].filter(isRecord) : [];
    const measureId = optionalInteger(params, 'measure_id', 0) ?? finite(food['defaultMeasureId']) ?? 0;
    const measure = measures.find((candidate) => candidate['id'] === measureId);

    let grams = optionalNumber(params, 'grams', 0.001, 100_000);
    const quantity = optionalNumber(params, 'quantity', 0.001, 100_000);
    if (grams === undefined) {
      if (quantity === undefined) throw new LiveBackendError('Give grams, or a quantity of the chosen measure.');
      const value = measure === undefined ? null : finite(measure['value']);
      const amount = measure === undefined ? null : finite(measure['amount']) ?? 1;
      if (value === null || amount === null || amount <= 0) {
        throw new LiveBackendError(`Food ${foodId} has no measure ${measureId}. Use get_food_details to pick one, or give grams.`);
      }
      // A serving-based recipe measure counts servings, not grams.
      grams = measure?.['type'] === 'Recipe' ? quantity : (quantity / amount) * value;
    }
    if (measureId !== 0 && measure === undefined) {
      throw new LiveBackendError(`Food ${foodId} has no measure ${measureId}. Use get_food_details to pick one.`);
    }

    const translations = Array.isArray(food['translations']) ? food['translations'].filter(isRecord) : [];
    const session = await this.#mobile.session();
    const response = await this.#write('add_serving', {
      serving: {
        order: (group << 16) | 1,
        day: cronometerDay(day),
        time: clockIn(this.#timeZone),
        offset: null,
        source: null,
        userId: session.userId,
        servingId: null,
        type: 'Serving',
        foodId,
        measureId,
        grams: Math.round(grams * 1000) / 1000,
        translationId: finite(translations[0]?.['translationId']) ?? 0,
      },
      config: { call_version: 2 },
    });
    const servingId = finite(response['id']) ?? finite(response['servingId']);
    if (servingId === null) {
      throw new LiveBackendError('Cronometer accepted the entry, so it was probably logged, but returned no id. Do not log it again; check get_diary for that day.');
    }
    return {
      serving_id: servingId,
      date: day,
      food_id: foodId,
      food_name: str(food['name']),
      measure_id: measureId,
      measure: measure === undefined ? 'g' : str(measure['name']),
      grams: Math.round(grams * 100) / 100,
      diary_group: group,
    };
  }

  async #updateFoodEntry(params: JsonObject): Promise<JsonRecord> {
    const day = isoDay(params, 'date');
    const servingId = integer(params, 'serving_id');
    const grams = optionalNumber(params, 'grams', 0.001, 100_000);
    const measureId = optionalInteger(params, 'measure_id', 0);
    const group = optionalInteger(params, 'diary_group', 1, 4);
    if (grams === undefined && measureId === undefined && group === undefined) {
      throw new LiveBackendError('Give grams, measure_id or diary_group to change.');
    }
    const diary = await this.#diaryDay(day);
    const entries = Array.isArray(diary['diary']) ? diary['diary'].filter(isRecord) : [];
    const serving = entries.find((entry) => entry['type'] === 'Serving' && entry['servingId'] === servingId);
    if (serving === undefined) throw new LiveBackendError(`No food entry ${servingId} is on ${day}. Read the day with get_diary to find its id.`);

    const updated: JsonRecord = { ...serving };
    if (grams !== undefined) updated['grams'] = grams;
    if (measureId !== undefined) updated['measureId'] = measureId;
    const order = finite(serving['order']) ?? 0;
    if (group !== undefined && order >> 16 !== group) {
      const last = Math.max(0, ...entries.map((entry) => finite(entry['order']) ?? 0).filter((value) => value >> 16 === group).map((value) => value & 0xffff));
      updated['order'] = (group << 16) | (last + 1);
    }
    const response = await this.#write('edit_serving', { serving: updated, config: { call_version: 2 } });
    if (String(response['id']) !== String(servingId)) {
      throw new LiveBackendError('Cronometer did not confirm the change. Read the day with get_diary before trying again.');
    }
    return { serving_id: servingId, date: day, updated: true };
  }

  async #removeEntries(params: JsonObject): Promise<JsonRecord> {
    const day = isoDay(params, 'date');
    const raw = params['entry_ids'];
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > 100) throw new LiveBackendError('entry_ids must list 1 to 100 ids');
    const wanted = new Set(raw.map((id) => String(id)));
    const diary = await this.#diaryDay(day);
    const entries = Array.isArray(diary['diary']) ? diary['diary'].filter(isRecord) : [];
    const matched: JsonRecord[] = [];
    const removed: string[] = [];
    for (const entry of entries) {
      const type = str(entry['type']) ?? 'Serving';
      const key = ENTRY_ID_KEYS[type];
      if (key === undefined) continue;
      const id = entry[key];
      if (id === undefined || !wanted.has(String(id))) continue;
      // The delete endpoint wants notes and biometrics keyed by plain `id`, and
      // `meta` as a JSON string rather than the object get_diary returns.
      const reshaped: JsonRecord = { ...entry };
      if (type === 'Note' || type === 'Biometric') {
        reshaped['id'] = reshaped[key];
        delete reshaped[key];
      }
      if (isRecord(reshaped['meta'])) reshaped['meta'] = JSON.stringify(reshaped['meta']);
      matched.push(reshaped);
      removed.push(String(id));
    }
    const notFound = [...wanted].filter((id) => !removed.includes(id));
    if (matched.length === 0) {
      throw new LiveBackendError(`None of those ids are on ${day}, so nothing was removed. Read the day with get_diary to find them.`);
    }
    await this.#pace();
    const response = await this.#mobile.v3('DELETE', '/diary-entries', { diaryEntries: matched });
    if (response.status !== 204 && response.status !== 200) {
      throw new LiveBackendError(`Cronometer refused the delete with HTTP ${response.status}. Read the day with get_diary to see what remains.`);
    }
    return { date: day, removed, not_found: notFound };
  }

  async #saveNote(noteId: number, body: string, day: string, order: number): Promise<JsonRecord> {
    if (body.trim() === '') throw new LiveBackendError('A note needs some text.');
    await this.#pace();
    const saved = await this.#mobile.upload({
      action: 'diaryImage',
      noteId: String(noteId),
      day,
      order: String(order),
      deleteExistingPhoto: 'true',
      noteText: body,
    });
    if (finite(saved['noteId']) === null) {
      throw new LiveBackendError('Cronometer accepted the note but returned no id. Read the day with get_diary before trying again.');
    }
    return saved;
  }

  async #importRecipe(params: JsonObject): Promise<JsonRecord> {
    const lines = text(params, 'ingredients_text', 10_000);
    const save = params['save'] !== false;
    const started = await this.#read('import_recipe', { url: '', ingredients: lines, enable_async: true, config: { call_version: 1 } });
    if (started['isError'] === true || typeof started['id'] !== 'string' && typeof started['id'] !== 'number') {
      throw new LiveBackendError('Cronometer could not start the recipe import.');
    }
    const deadline = Date.now() + RECIPE_IMPORT_TIMEOUT_MS;
    let job = started;
    while (!isRecord(job['result'])) {
      if (job['progress'] === 100) throw new LiveBackendError('Cronometer finished the recipe import without a result.');
      if (Date.now() > deadline) throw new LiveBackendError('Cronometer did not finish the recipe import within a minute.');
      await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
      job = await this.#read('poll_async_result', { futureId: started['id'], resultType: 'recipe', config: { call_version: 1 } });
      if (job['isError'] === true) throw new LiveBackendError('Cronometer reported that the recipe import failed.');
    }
    const result = job['result'] as JsonRecord;
    const matched: JsonRecord[] = [];
    const unmatched: JsonRecord[] = [];
    for (const entry of Array.isArray(result['entries']) ? result['entries'].filter(isRecord) : []) {
      const ingredient = isRecord(entry['ingredient']) ? entry['ingredient'] : {};
      const row = {
        line: str(entry['rawIngredientImport']),
        description: str(entry['description']),
        food_id: finite(ingredient['foodId']),
        grams: finite(ingredient['grams']),
        serving_size_matched: typeof entry['servingSizeMatchFound'] === 'boolean' ? entry['servingSizeMatchFound'] : null,
      };
      if (row.food_id !== null && row.grams !== null && row.grams > 0) matched.push(row);
      else unmatched.push(row);
    }
    const recipe = isRecord(result['recipe']) ? result['recipe'] : {};
    const name = optionalText(params, 'name', 200) ?? str(recipe['name']) ?? 'Imported recipe';
    const summary = { recipe_name: name, matched, unmatched };
    if (!save) return { ...summary, saved: false };
    if (matched.length === 0) throw new LiveBackendError('The import matched no ingredients, so nothing was saved.');

    const ingredients = matched.map((row) => ({ food_id: row['food_id'] as number, grams: row['grams'] as number }));
    const foods = await this.#foods(ingredients.map((ingredient) => ingredient.food_id));
    const { payload, totalGrams } = recipePayload(name, ingredients, foods, 'Serving', undefined);
    const response = await this.#write('add_food', payload);
    const id = finite(response['id']);
    if (id === null) throw new LiveBackendError('Cronometer did not return an id for the imported recipe. Check the app before trying again.');
    return { ...summary, saved: true, food_id: id, total_grams: totalGrams };
  }
}
