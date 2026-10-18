import { describe, expect, it } from 'vitest';

import { GwtResponseError, gwtNumber, gwtText, isConfirmedEmpty, parseGwt, parseRepeatedItems } from '../../src/live/web/gwt.js';

/**
 * Two rules written to a live account with deliberately distinct values, so each
 * field could be told apart, then deleted. #1: quantity 3, weekdays [1, 3].
 * #2: quantity 5, weekday [6].
 */
const REPEATED_TWO =
  '//OK[0,1072101,464674,849382,1,4,0,6,3,1,1,5.0,2,0,1072101,464674,849371,1,4,' +
  '0,3,3,1,3,2,1,3.0,2,2,1,["java.util.ArrayList/4159755760","com.cronometer.sha' +
  'red.repeatitems.RepeatItem/477684891","java.lang.Integer/3438268394","Eggs, Co' +
  'oked"],0,7]';

/**
 * The shape a real account with three daily rules returned (names and ids
 * replaced). The second and third rules' weekday lists are back-references to the
 * Integers the first rule already sent, two rules carry a time of day, and one
 * carries the unidentified Integer field as a back-reference too. The previous
 * reader expected values in those places and failed on this response.
 */
const REPEATED_THREE_WITH_REFERENCES =
  '//OK[0,0,5,5,3003,2003,900003,1,7,-4,-10,-9,-8,-7,-6,-5,-4,7,1,1.0,2,0,0,5,5,3002,2002,900002,1,6,0,' +
  '-10,-9,-8,-7,-6,-5,-4,7,1,1.0,2,0,0,7,5,3001,2001,900001,1,4,-4,6,3,5,3,4,3,3,3,2,3,1,3,0,3,7,1,1.0,2,3,1,' +
  '["java.util.ArrayList/4159755760","com.cronometer.shared.repeatitems.RepeatItem/477684891",' +
  '"java.lang.Integer/3438268394","Synthetic Fiber","com.cronometer.shared.entries.models.Time/1552252503",' +
  '"Synthetic Multivitamin","Synthetic Creatine"],0,7]';

describe('GWT responses', () => {
  it('reads the string table and the data section', () => {
    const response = parseGwt('//OK[2,1.5,"Ab$_9",["java.util.ArrayList/4159755760","x"],0,7]');
    expect(response.strings).toEqual(['java.util.ArrayList/4159755760', 'x']);
    expect(response.tokens).toEqual([2, 1.5, 'Ab$_9']);
  });

  it('refuses anything that is not a whole //OK response', () => {
    expect(() => parseGwt('//EX[2,["com.google.gwt.user.client.rpc.IncompatibleRemoteServiceException"],0,7]')).toThrow(GwtResponseError);
    expect(() => parseGwt('<html>')).toThrow(GwtResponseError);
  });

  it('recognises a confirmed empty collection, and only that', () => {
    expect(isConfirmedEmpty(parseGwt('//OK[0,1,["java.util.ArrayList/4159755760"],0,7]'))).toBe(true);
    expect(isConfirmedEmpty(parseGwt('//OK[1,1,["com.cronometer.shared.biometrics.Biometric/1"],0,7]'))).toBe(false);
  });

  it('writes numbers without exponents', () => {
    expect(gwtNumber(160)).toBe('160');
    expect(gwtNumber(0.5)).toBe('0.5');
    expect(gwtNumber(0.0000001)).toBe('0.0000001');
    expect(gwtNumber(1e-7)).not.toMatch(/e/i);
    expect(() => gwtNumber(Number.NaN)).toThrow();
  });

  it('refuses text that would break a pipe-delimited body', () => {
    expect(gwtText('Cut – 2700')).toBe('Cut – 2700');
    for (const bad of ['a|b', 'a\\b', 'a{b', 'line\nbreak']) expect(() => gwtText(bad)).toThrow();
  });
});

describe('repeated foods', () => {
  it('reads the fields that were actually written', () => {
    const { items, unverified } = parseRepeatedItems(REPEATED_TWO);
    expect(unverified).toBe(false);
    expect(items).toEqual([
      {
        repeat_item_id: 849371,
        food_name: 'Eggs, Cooked',
        food_id: 464674,
        measure_id: 1072101,
        quantity: 3,
        days_of_week: [1, 3],
        time: null,
        diary_group: null,
      },
      {
        repeat_item_id: 849382,
        food_name: 'Eggs, Cooked',
        food_id: 464674,
        measure_id: 1072101,
        quantity: 5,
        days_of_week: [6],
        time: null,
        diary_group: null,
      },
    ]);
  });

  it('follows back-references to objects already sent', () => {
    const { items } = parseRepeatedItems(REPEATED_THREE_WITH_REFERENCES);
    expect(items.map((item) => item.food_name)).toEqual(['Synthetic Fiber', 'Synthetic Multivitamin', 'Synthetic Creatine']);
    expect(items.map((item) => item.repeat_item_id)).toEqual([900001, 900002, 900003]);
    for (const item of items) expect(item.days_of_week).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(items.map((item) => item.time)).toEqual(['07:00:00', '05:00:00', '05:00:00']);
    expect(items[0]).toMatchObject({ food_id: 2001, measure_id: 3001 });
  });

  it('reads an empty list as confirmed empty', () => {
    expect(parseRepeatedItems('//OK[0,1,["java.util.ArrayList/4159755760"],0,7]')).toEqual({ items: [], unverified: false });
  });

  it('refuses a response it cannot read to the end', () => {
    const cases = {
      'one record too many': REPEATED_TWO.replace(',2,2,1,[', ',2,3,1,['),
      'an impossible weekday': REPEATED_TWO.replace(',1,4,0,6,3,1,1,5.0', ',1,4,0,9,3,1,1,5.0'),
      'an extra token inside a record': REPEATED_TWO.replace('1,4,0,6,3,1,1,5.0', '1,4,0,6,3,1,1,5.0,7'),
      'a reference to an object not yet read': REPEATED_THREE_WITH_REFERENCES.replace('-4,-10,-9', '-40,-10,-9'),
    };
    for (const [label, raw] of Object.entries(cases)) {
      expect(() => parseRepeatedItems(raw), label).toThrow(GwtResponseError);
    }
  });
});
