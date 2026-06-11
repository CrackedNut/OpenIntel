/**
 * Regression: the bot used to seed every session's working directory from
 * `process.cwd()` (the daemon's launch dir — the source checkout) and never
 * read `config.workingDir`. Sessions then started in ~/code/claude-threads-agent
 * instead of the configured ~/code.
 */
import { describe, it, expect } from 'bun:test';
import { homedir } from 'os';
import { join } from 'path';
import { resolveSessionWorkingDir } from './agent-paths.js';

describe('resolveSessionWorkingDir', () => {
  it('prefers an absolute configured workingDir over the launch cwd', () => {
    expect(resolveSessionWorkingDir('/Users/nate/code', '/opt/src/checkout'))
      .toBe('/Users/nate/code');
  });

  it('expands a leading ~ in the configured workingDir', () => {
    expect(resolveSessionWorkingDir('~/code', '/opt/src/checkout'))
      .toBe(join(homedir(), 'code'));
  });

  it('falls back to the launch cwd when workingDir is unset', () => {
    expect(resolveSessionWorkingDir(undefined, '/opt/src/checkout'))
      .toBe('/opt/src/checkout');
  });

  it('falls back to the launch cwd when workingDir is empty', () => {
    expect(resolveSessionWorkingDir('', '/opt/src/checkout'))
      .toBe('/opt/src/checkout');
  });
});
