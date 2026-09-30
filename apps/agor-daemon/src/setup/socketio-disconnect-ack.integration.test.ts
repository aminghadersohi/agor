import type { Server } from 'node:http';
import { type AgorClient, createClient } from '@agor/core/api';
import { feathers, feathersExpress, socketio } from '@agor/core/feathers';
import type { Server as SocketServer } from 'socket.io';
import { afterEach, describe, expect, it } from 'vitest';

function waitForSocketConnect(socketClient: AgorClient): Promise<void> {
  if (socketClient.io.connected) return Promise.resolve();
  return new Promise((resolve) => socketClient.io.once('connect', resolve));
}

const PENDING = Symbol('pending');

/**
 * Socket.IO drops a plain ack callback on disconnect without calling it, so a
 * Feathers call in flight during a socket drop never settles. The UI relies on
 * `ackTimeout` to turn that into an immediate rejection.
 */
describe('Socket.IO service calls across a socket drop', () => {
  let server: Server | undefined;
  let client: AgorClient | undefined;

  afterEach(async () => {
    client?.io.close();
    client = undefined;
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server?.close((error) => (error ? reject(error) : resolve()))
      );
      server = undefined;
    }
  });

  async function inFlightCallAfterDrop(ackTimeout?: number) {
    const app = feathersExpress(feathers());
    let requested: () => void = () => {};
    const received = new Promise<void>((resolve) => (requested = resolve));
    app.use('slow', {
      async find() {
        requested();
        return new Promise(() => {});
      },
    });
    let io: SocketServer | undefined;
    app.configure(
      socketio({ transports: ['websocket'] }, (socketServer) => {
        io = socketServer;
      })
    );
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP test server');

    client = createClient(`http://127.0.0.1:${address.port}`, true, {
      reconnectionAttempts: 0,
      ...(ackTimeout === undefined ? {} : { ackTimeout }),
    });
    await waitForSocketConnect(client);

    const call = client.service('slow').find();
    await received;
    io?.disconnectSockets(true);

    return Promise.race([
      call.then(
        () => 'resolved',
        (error: Error) => error
      ),
      new Promise<typeof PENDING>((resolve) => setTimeout(() => resolve(PENDING), 500)),
    ]);
  }

  it('rejects the in-flight call as soon as the socket drops when an ack timeout is set', async () => {
    const outcome = await inFlightCallAfterDrop(60_000);

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/disconnected/);
  });

  it('leaves the in-flight call pending forever without an ack timeout (baseline)', async () => {
    const outcome = await inFlightCallAfterDrop();

    expect(outcome).toBe(PENDING);
  });
});
