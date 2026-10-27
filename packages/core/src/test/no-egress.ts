/** Opt-in for offline fault tests. Installed before test bodies; never a provider client. */
import net from 'node:net';
import { afterAll, expect } from 'vitest';

const attempts: string[] = [];
const originalConnect = net.Socket.prototype.connect;
const originalFetch = globalThis.fetch;
const blockedConnect: typeof net.Socket.prototype.connect = () => {
  attempts.push('socket.connect');
  throw new Error('Offline test attempted socket egress');
};
net.Socket.prototype.connect = blockedConnect;
globalThis.fetch = async () => {
  attempts.push('fetch');
  throw new Error('Offline test attempted fetch egress');
};
export function assertNoEgress(): void {
  expect(net.Socket.prototype.connect).toBe(blockedConnect);
  expect(attempts).toEqual([]);
}
afterAll(() => {
  try {
    assertNoEgress();
  } finally {
    net.Socket.prototype.connect = originalConnect;
    globalThis.fetch = originalFetch;
  }
});
