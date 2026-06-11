/**
 * Panel bind-host tests. The dashboard defaults to 127.0.0.1 (loopback only)
 * and `panel.host` widens the bind — e.g. 0.0.0.0 to reach it over Tailscale.
 * Regression guard: the default must stay loopback, and a wide bind must
 * actually accept a non-loopback connection + flag the no-auth caveat.
 */
import { describe, it, expect } from 'bun:test';
import { networkInterfaces } from 'os';
import { startPanelServer, type PanelStatusProvider } from './server.js';

/** First non-internal IPv4 address, or undefined on a loopback-only box. */
function firstNonLoopbackIPv4(): string | undefined {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return undefined;
}

const stubStatus: PanelStatusProvider = {
  version: 'test',
  getSessions: () => [],
  getPlatforms: () => [],
  stopSession: async () => false,
  interruptSession: async () => false,
};

function makeOpts(overrides: Partial<Parameters<typeof startPanelServer>[0]>) {
  const logs: Array<{ level: string; message: string }> = [];
  const opts = {
    status: stubStatus,
    requestRestart: async () => {},
    log: (level: 'info' | 'warn' | 'error', message: string) => logs.push({ level, message }),
    ...overrides,
  };
  return { opts, logs };
}

// A free-ish high port per test to avoid collisions in the suite.
let nextPort = 47710;

describe('startPanelServer bind host', () => {
  it('defaults to 127.0.0.1 and serves there', async () => {
    const port = nextPort++;
    const { opts, logs } = makeOpts({ port });
    const server = startPanelServer(opts);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(res.status).toBe(200);
      expect(logs.some((l) => l.message.includes(`http://127.0.0.1:${port}`))).toBe(true);
      // Default bind must NOT advertise a wide-open address.
      expect(logs.some((l) => l.message.includes('no auth'))).toBe(false);
    } finally {
      server.close();
    }
  });

  it('binds all interfaces with host 0.0.0.0 and is reachable off-loopback', async () => {
    const port = nextPort++;
    const { opts, logs } = makeOpts({ port, host: '0.0.0.0' });
    const server = startPanelServer(opts);
    try {
      // Loopback always works regardless.
      expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
      // Reachable via a non-loopback local IP proves the wide bind took.
      const lanIp = firstNonLoopbackIPv4();
      if (lanIp) {
        expect((await fetch(`http://${lanIp}:${port}/`)).status).toBe(200);
      }
      expect(logs.some((l) => l.message.includes('no auth'))).toBe(true);
    } finally {
      server.close();
    }
  });
});
