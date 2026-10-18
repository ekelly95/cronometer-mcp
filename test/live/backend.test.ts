import { describe, expect, it } from 'vitest';

import { CronometerBackend, LiveBackendError, type JsonObject } from '../../src/live/index.js';
import { MOBILE_IDS } from '../../src/live/nutrient-ids.js';
import { FakeCronometer, diaryDay } from './fake-cronometer.js';

const ENVIRONMENT = {
  CRONOMETER_LIVE_ENABLED: '1',
  CRONOMETER_USERNAME: 'person@example.com',
  CRONOMETER_PASSWORD: 'correct horse battery',
};

function backend(fake = new FakeCronometer(), environment: Record<string, string> = ENVIRONMENT): CronometerBackend {
  return new CronometerBackend({ environment, timeZone: 'America/New_York', fetch: fake.fetch, minimumIntervalMs: 0, diagnostics: () => {} });
}

type Entry = Record<string, unknown>;

describe('reading the diary', () => {
  it('returns every entry type with its id, and macros computed from the food record', async () => {
    const fake = new FakeCronometer();
    const { value } = await backend(fake).call('get_diary', { start_date: '2026-08-15', end_date: '2026-08-15' });
    const day = (value as { days: JsonObject[] }).days[0]!;
    expect(day['targets']).toMatchObject({ template_name: 'Cut', energy_kcal: 2000, protein_g: 150 });
    expect(day['remaining']).toEqual({ energy_kcal: 1360, protein_g: 108, carbs_g: 175, fat_g: 32.8 });

    const entries = day['entries'] as Entry[];
    expect(entries.map((entry) => entry['type'])).toEqual(['food', 'food', 'exercise', 'biometric', 'note']);
    const egg = entries[0]!;
    expect(egg).toMatchObject({
      serving_id: 5_000_000_001,
      food_name: 'Synthetic Egg',
      diary_group: { number: 1, name: 'Breakfast' },
      amount: { quantity: 2, unit: 'egg', grams: 100 },
      energy_kcal: 140,
      protein_g: 12,
    });
    expect(entries[2]).toMatchObject({ exercise_id: 77, calories_burned: 300 });
    expect(entries[3]).toMatchObject({ biometric_id: 88, metric: 'Weight', unit: 'lbs', amount: 180.5 });
    expect(entries[4]).toMatchObject({ note_id: 99 });
  });

  it('gives a macro the food does not report as null, never zero', async () => {
    const { value } = await backend().call('get_diary', { start_date: '2026-08-15', end_date: '2026-08-15' });
    const bar = ((value as { days: JsonObject[] }).days[0]!['entries'] as Entry[])[1]!;
    expect(bar['fiber_g']).toBeNull();
    expect(bar['energy_kcal']).toBe(480);
  });

  it('fetches every day’s foods in one batch', async () => {
    const fake = new FakeCronometer();
    await backend(fake).call('get_diary', { start_date: '2026-08-13', end_date: '2026-08-15' });
    expect(fake.calls('/api/v2/get_diary')).toHaveLength(3);
    expect(fake.calls('/api/v2/get_foods')).toHaveLength(1);
    expect(fake.calls('/api/v2/get_diary')[0]?.body).toMatchObject({ day: '2026-8-13' });
  });

  it('refuses a range longer than the live window', async () => {
    await expect(backend().call('get_diary', { start_date: '2026-08-01', end_date: '2026-08-31' })).rejects.toThrow('at most 14 days');
  });

  it('marks a nutrient as reported only by the foods that carry it', async () => {
    const { value } = await backend().call('get_nutrition_days', { start_date: '2026-08-15', end_date: '2026-08-15' });
    const result = value as { days: { servings: { nutrients: Record<string, number> }[] }[]; targets: Record<string, unknown> };
    const [egg, bar] = result.days[0]!.servings;
    expect(egg?.nutrients['vitaminD']).toBe(80);
    expect(bar?.nutrients).not.toHaveProperty('vitaminD');
    expect(bar?.nutrients).not.toHaveProperty('fiber');
    expect(result.targets['protein']).toEqual({ min: 150, max: 150 });
    expect(result.targets['vitaminD']).toEqual({ min: 600, max: 4000 });
  });

  it("takes macro targets from the day's template, not the nutrient profile", async () => {
    const { value } = await backend().call('get_nutrition_days', { start_date: '2026-08-15', end_date: '2026-08-15' });
    const { targets } = value as { targets: Record<string, unknown> };
    expect(targets['energy']).toEqual({ min: 2000, max: 2000 });
    expect(targets['netCarbs']).toEqual({ min: 190, max: 190 });
    expect(targets['vitaminD']).toEqual({ min: 600, max: 4000 });
  });

  it('gives no macro target across days on different templates', async () => {
    const fake = new FakeCronometer({
      handlers: {
        get_diary: (body) => {
          const day = diaryDay(body['day'] === '2026-8-16' ? '2026-08-16' : '2026-08-15');
          if (body['day'] !== '2026-8-16') return day;
          const summary = day['summary'] as Record<string, unknown>;
          return { ...day, summary: { ...summary, macros: { energy: 2500, protein: 150, total_carbs: 260, carbs: 260, net_carbs: 250, fat: 80 } } };
        },
      },
    });
    const { value } = await backend(fake).call('get_nutrition_days', { start_date: '2026-08-15', end_date: '2026-08-16' });
    const { targets } = value as { targets: Record<string, unknown> };
    expect(targets).not.toHaveProperty('energy');
    expect(targets).not.toHaveProperty('fat');
    expect(targets['protein']).toEqual({ min: 150, max: 150 });
  });
});

describe('writing to the diary', () => {
  it('logs a quantity of a measure as its weight in grams', async () => {
    const fake = new FakeCronometer();
    const { value } = await backend(fake).call('add_food_entry', { food_id: 101, measure_id: 11, quantity: 3, date: '2026-08-15', diary_group: 2 });
    const serving = (fake.calls('/api/v2/add_serving')[0]?.body as { serving: Entry }).serving;
    expect(serving).toMatchObject({ foodId: 101, measureId: 11, grams: 150, day: '2026-8-15', order: (2 << 16) | 1, translationId: 7, userId: 4242 });
    expect(value).toMatchObject({ serving_id: 5_000_000_009, grams: 150, measure: 'egg' });
  });

  it('refuses a measure the food does not have', async () => {
    await expect(backend().call('add_food_entry', { food_id: 101, measure_id: 999, quantity: 1, date: '2026-08-15', diary_group: 1 })).rejects.toThrow('has no measure 999');
  });

  it('deletes entries of any type, reshaped the way the delete endpoint needs', async () => {
    const fake = new FakeCronometer();
    const { value } = await backend(fake).call('remove_diary_entries', { date: '2026-08-15', entry_ids: [5_000_000_001, 99, 88, 12345] });
    expect(value).toEqual({ date: '2026-08-15', removed: ['5000000001', '88', '99'], not_found: ['12345'] });
    const sent = fake.calls('/api/v3/user/4242/diary-entries')[0];
    expect(sent?.method).toBe('DELETE');
    const deleted = (sent?.body as { diaryEntries: Entry[] }).diaryEntries;
    const note = deleted.find((entry) => entry['type'] === 'Note');
    expect(note).toMatchObject({ id: 99 });
    expect(note).not.toHaveProperty('noteId');
    const biometric = deleted.find((entry) => entry['type'] === 'Biometric');
    expect(biometric?.['meta']).toBe('{}');
  });

  it('removes nothing when none of the ids are on that day', async () => {
    const fake = new FakeCronometer();
    await expect(backend(fake).call('remove_diary_entries', { date: '2026-08-15', entry_ids: [1, 2] })).rejects.toThrow('nothing was removed');
    expect(fake.calls('/api/v3/user/4242/diary-entries')).toHaveLength(0);
  });

  it('says to read the day when Cronometer refuses a delete', async () => {
    const fake = new FakeCronometer({ v3Status: 400 });
    await expect(backend(fake).call('remove_diary_entries', { date: '2026-08-15', entry_ids: [77] })).rejects.toThrow('HTTP 400');
  });

  it('moves an entry to another diary group at the end of that group', async () => {
    const fake = new FakeCronometer();
    await backend(fake).call('update_food_entry', { serving_id: 5_000_000_001, date: '2026-08-15', diary_group: 2 });
    const serving = (fake.calls('/api/v2/edit_serving')[0]?.body as { serving: Entry }).serving;
    expect(serving['order']).toBe((2 << 16) | 2);
    expect(serving['servingId']).toBe(5_000_000_001);
  });

  it('records a biometric only in a unit that metric has', async () => {
    const fake = new FakeCronometer();
    await expect(backend(fake).call('add_biometric', { metric_id: 1, unit_id: 22, amount: 80, date: '2026-08-15' })).rejects.toThrow('has no unit 22');
    const { value } = await backend(fake).call('add_biometric', { metric_id: 1, unit_id: 2, amount: 180, date: '2026-08-15' });
    expect(value).toMatchObject({ biometric_id: 31337, metric: 'Weight', unit: 'lbs' });
  });

  it('logs exercise with the burn stored as energy out', async () => {
    const fake = new FakeCronometer();
    await backend(fake).call('add_exercise', { activity_id: 9, minutes: 30, calories_burned: 250, date: '2026-08-15', diary_group: 4 });
    const exercise = (fake.calls('/api/v2/add_exercise')[0]?.body as { exercise: Entry }).exercise;
    expect(exercise).toMatchObject({ calories: -250, calorieOverride: true, minutes: 30, weight: 176.4 });
  });

  it('refuses to edit a food that is not a custom food', async () => {
    const fake = new FakeCronometer();
    await expect(backend(fake).call('update_custom_food', { food_id: 101, calories: 100 })).rejects.toThrow('not a custom food');
    expect(fake.calls('/api/v2/add_food')).toHaveLength(0);
  });

  it('writes a custom food per 100 g', async () => {
    const fake = new FakeCronometer();
    await backend(fake).call('add_custom_food', { name: 'Bar', serving_grams: 50, calories: 200, protein_g: 20, fat_g: 5, carbs_g: 20, fiber_g: 4 });
    const data = (fake.calls('/api/v2/add_food')[0]?.body as { data: { nutrients: { id: number; amount: number }[] } }).data;
    const amount = (id: number): number | undefined => data.nutrients.find((nutrient) => nutrient.id === id)?.amount;
    expect(amount(208)).toBe(400);
    expect(amount(203)).toBe(40);
    expect(amount(-1205)).toBe(32);
  });

  it('leaves out the optional nutrients a custom food was not given, rather than writing zeros', async () => {
    const fake = new FakeCronometer();
    await backend(fake).call('add_custom_food', { name: 'Bar', serving_grams: 50, calories: 200, protein_g: 20, fat_g: 5, carbs_g: 20, sodium_mg: 0 });
    const data = (fake.calls('/api/v2/add_food')[0]?.body as { data: { nutrients: { id: number; amount: number }[] } }).data;
    const ids = data.nutrients.map((nutrient) => nutrient.id);
    expect(ids).not.toContain(MOBILE_IDS.fiber);
    expect(ids).not.toContain(MOBILE_IDS.sugars);
    expect(ids).not.toContain(MOBILE_IDS.saturated);
    // A zero the caller gave is a real value, and is kept.
    expect(data.nutrients.find((nutrient) => nutrient.id === MOBILE_IDS.sodium)?.amount).toBe(0);
    expect(data.nutrients.find((nutrient) => nutrient.id === MOBILE_IDS.netCarbs)?.amount).toBe(40);
  });
});

describe('failures', () => {
  it('reports a timed-out write as an unknown outcome and says to check the app', async () => {
    const fake = new FakeCronometer();
    const slow = new CronometerBackend({
      environment: ENVIRONMENT,
      timeZone: 'UTC',
      minimumIntervalMs: 0,
      timeoutMs: 50,
      diagnostics: () => {},
      fetch: async (url, init) => {
        if (url.endsWith('/add_serving')) {
          return new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
        }
        return fake.fetch(url, init);
      },
    });
    const failure = slow.call('add_food_entry', { food_id: 101, grams: 50, date: '2026-08-15', diary_group: 1 });
    await expect(failure).rejects.toThrow('outcome is unknown');
    await expect(failure).rejects.toThrow('Check the Cronometer app');
    expect(fake.calls('/api/v2/add_serving')).toHaveLength(0);
  });

  it('never puts the password or the session token in an error', async () => {
    const fake = new FakeCronometer({
      handlers: {
        get_macro_target_templates: () => ({ result: 'FAIL', error: `bad ${ENVIRONMENT.CRONOMETER_PASSWORD} token-1` }),
      },
    });
    const error = (await backend(fake).call('check_connection', {}).catch((caught: unknown) => caught)) as Error;
    expect(error).toBeInstanceOf(LiveBackendError);
    expect(error.message).not.toContain(ENVIRONMENT.CRONOMETER_PASSWORD);
    expect(error.message).not.toContain('token-1');
  });

  it('reports status without signing in', async () => {
    const fake = new FakeCronometer();
    const { value } = await backend(fake).call('status', {});
    expect(value).toMatchObject({ live_enabled: true, credentials_configured: true, network_hosts: ['mobile.cronometer.com', 'cronometer.com'] });
    expect(fake.requests).toHaveLength(0);
  });

  it('refuses to sign in at all while live access is disabled', async () => {
    const fake = new FakeCronometer();
    await expect(backend(fake, { ...ENVIRONMENT, CRONOMETER_LIVE_ENABLED: '' }).call('check_connection', {})).rejects.toThrow('Live access is disabled');
    expect(fake.requests).toHaveLength(0);
  });

  it('runs one call at a time', async () => {
    let active = 0;
    let peak = 0;
    const fake = new FakeCronometer({
      handlers: {
        get_diary: async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          return diaryDay('2026-08-15');
        },
      },
    });
    const live = backend(fake);
    await Promise.all([1, 2, 3].map(() => live.call('get_macro_targets', { date: '2026-08-15' })));
    expect(peak).toBe(1);
  });
});
