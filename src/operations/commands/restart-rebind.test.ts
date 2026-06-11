/**
 * Regression test for reviewer M1: `restartClaudeSession` must rebind the
 * `'rate-limit'` listener in addition to `'event'` and `'exit'`.
 *
 * Without the rebind, a !cd or !permissions interactive run would spawn a
 * fresh Claude process whose rate-limit signals go nowhere — the account
 * never enters cooldown until the next cold start. The bug slipped past
 * typecheck + existing tests because the binding was missing, not malformed.
 *
 * The assertion here is deliberately structural: after the restart, the new
 * ClaudeCli instance must have listeners registered for all three events.
 * Anything more "behavioral" (emit + check side effect) would need wiring
 * through the full SessionContext, which is covered by the handleRateLimit
 * tests in lifecycle.test.ts.
 */
import { describe, it, expect, mock } from 'bun:test';
import { EventEmitter } from 'events';

// Mock ClaudeCli with a minimal EventEmitter so .on() counts are observable.
// Must be declared before importing handler so the module cache picks it up.
//
// NOTE: we deliberately do NOT mock `session/lifecycle.js`. `mock.module` in
// bun is process-global — stubbing `handleRateLimit` here would leak into
// lifecycle.test.ts and break its own tests of the real handler. Since this
// test only checks listener counts (never fires the event), the real import
// is harmless.
mock.module('../../claude/cli.js', () => ({
  ClaudeCli: class MockClaudeCli extends EventEmitter {
    isRunning() { return true; }
    kill() { return Promise.resolve(); }
    start() {}
    sendMessage() {}
    interrupt() {}
  },
}));

import { restartClaudeSession } from './handler.js';
import type { ClaudeCliOptions } from '../../claude/cli.js';
import type { Session } from '../../session/types.js';
import type { SessionContext } from '../session-context/index.js';
import { createSessionTimers, createSessionLifecycle } from '../../session/types.js';

function makeSession(): Session {
  return {
    sessionId: 'test:thread-1',
    platformId: 'test',
    threadId: 'thread-1',
    claudeSessionId: 'uuid-1',
    startedBy: 'tester',
    startedAt: new Date(),
    lastActivityAt: new Date(),
    sessionNumber: 1,
    workingDir: '/tmp',
    // stub — restartClaudeSession calls .kill() on this, then replaces it
    claude: new (class extends EventEmitter {
      isRunning() { return true; }
      kill() { return Promise.resolve(); }
    })() as unknown as Session['claude'],
    planApproved: false,
    sessionAllowedUsers: new Set(['tester']),
    forceInteractivePermissions: false,
    sessionStartPostId: null,
    timers: createSessionTimers(),
    lifecycle: createSessionLifecycle(),
    timeoutWarningPosted: false,
    messageCount: 0,
    isProcessing: false,
    platform: { getFormatter: () => ({}) } as Session['platform'],
  } as unknown as Session;
}

function makeCtx(): SessionContext {
  return {
    config: {} as SessionContext['config'],
    state: {} as SessionContext['state'],
    ops: {
      stopTyping: mock(() => {}),
      flush: mock(async () => {}),
      handleEvent: mock(() => {}),
      handleExit: mock(async () => {}),
    } as unknown as SessionContext['ops'],
  };
}

describe('restartClaudeSession', () => {
  it('binds listeners for event, exit, AND rate-limit on the new Claude CLI', async () => {
    const session = makeSession();
    const ctx = makeCtx();
    const cliOptions = { workingDir: '/tmp' } as ClaudeCliOptions;

    const ok = await restartClaudeSession(session, cliOptions, ctx, 'test');
    expect(ok).toBe(true);

    // session.claude was replaced — verify the NEW instance has all three
    // listeners wired. If anyone removes the rate-limit binding, the final
    // expect fails.
    const claudeEmitter = session.claude as unknown as EventEmitter;
    expect(claudeEmitter.listenerCount('event')).toBe(1);
    expect(claudeEmitter.listenerCount('exit')).toBe(1);
    expect(claudeEmitter.listenerCount('rate-limit')).toBe(1);
  });

  /**
   * Regression: the killed CLI's exit event fires asynchronously after
   * kill(). If our listeners are still attached to the OLD instance, that
   * stale exit reaches handleExit — and whenever something has already moved
   * the session out of 'restarting' (e.g. the !cd confirmation post's
   * defensive transitionTo('active')), handleExit runs full cleanup and ends
   * the session the restart just rebuilt. Seen live 2026-06-10: every
   * channel-mode !cd killed its session ~300ms after the respawn.
   */
  it('detaches listeners from the replaced CLI so its stale exit never reaches handleExit', async () => {
    const session = makeSession();
    const ctx = makeCtx();
    const oldClaude = session.claude as unknown as EventEmitter;
    // Simulate the production wiring: the old instance had live bindings.
    oldClaude.on('event', () => ctx.ops.handleEvent(session.sessionId, {} as never));
    oldClaude.on('exit', (code: number) => ctx.ops.handleExit(session.sessionId, code));
    oldClaude.on('rate-limit', () => {});

    const ok = await restartClaudeSession(
      session,
      { workingDir: '/tmp' } as ClaudeCliOptions,
      ctx,
      'test'
    );
    expect(ok).toBe(true);

    // The killed process exits late, after the restart completed.
    oldClaude.emit('exit', 0);
    oldClaude.emit('event', { type: 'result' });

    expect(ctx.ops.handleExit).not.toHaveBeenCalled();
    expect(ctx.ops.handleEvent).not.toHaveBeenCalled();
  });

  it('transitions the session out of restarting on successful start', async () => {
    const session = makeSession();
    session.lifecycle.state = 'active'; // legal source for -> restarting
    const ctx = makeCtx();

    const ok = await restartClaudeSession(
      session,
      { workingDir: '/tmp' } as ClaudeCliOptions,
      ctx,
      'test'
    );
    expect(ok).toBe(true);
    // No stale exit listener flips this back anymore — the restart itself
    // must leave the session usable.
    expect(session.lifecycle.state).toBe('active');
  });
});
