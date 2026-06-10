/**
 * Tests for command executor helpers.
 */

import { describe, test, expect } from 'bun:test';
import { parseThreadArgs } from './executor.js';

describe('parseThreadArgs', () => {
  test('no args → no topic, no history', () => {
    expect(parseThreadArgs(undefined)).toEqual({ includeHistory: false });
    expect(parseThreadArgs('')).toEqual({ includeHistory: false });
    expect(parseThreadArgs('   ')).toEqual({ includeHistory: false });
  });

  test('topic only', () => {
    expect(parseThreadArgs('fix the login bug')).toEqual({
      topic: 'fix the login bug',
      includeHistory: false,
    });
  });

  test('topic with trailing -history flag', () => {
    expect(parseThreadArgs('fix the login bug -history')).toEqual({
      topic: 'fix the login bug',
      includeHistory: true,
    });
  });

  test('-history flag alone', () => {
    expect(parseThreadArgs('-history')).toEqual({
      topic: undefined,
      includeHistory: true,
    });
  });

  test('--history double-dash variant', () => {
    expect(parseThreadArgs('topic xyz --history')).toEqual({
      topic: 'topic xyz',
      includeHistory: true,
    });
  });

  test('flag in the middle of the topic', () => {
    expect(parseThreadArgs('fix -history the bug')).toEqual({
      topic: 'fix the bug',
      includeHistory: true,
    });
  });

  test('flag is case-insensitive', () => {
    expect(parseThreadArgs('topic -History')).toEqual({
      topic: 'topic',
      includeHistory: true,
    });
  });

  test('words merely containing -history stay in the topic', () => {
    expect(parseThreadArgs('research pre-history of computing')).toEqual({
      topic: 'research pre-history of computing',
      includeHistory: false,
    });
  });
});
