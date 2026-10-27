import type { Server as HttpServer } from 'node:http';
import type { AgorClient } from '@agor/core/api';
import { feathers, feathersExpress, socketio } from '@agor/core/feathers';
import { MessageRole, type Task, TaskStatus } from '@agor/core/types';
import type { Server as SocketServer } from 'socket.io';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExecutorClient } from '../../../../packages/executor/src/services/feathers-client.js';

const TASK_ID = '018f0000-0000-7000-8000-000000000001';
const SESSION_ID = '018f0000-0000-7000-8000-000000000002';
const TOKEN = 'test-reconnect-scoped-token';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('executor reconnect recovery rejection boundary', () => {
  let server: HttpServer | undefined;
  let client: AgorClient | undefined;

  afterEach(async () => {
    client?.io.close();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    vi.restoreAllMocks();
  });

  it('contains a second disconnect during recovery, refreshes the newer connection, and preserves output/terminal acknowledgement', async () => {
    const app = feathersExpress(feathers());
    const firstRead = deferred();
    const releaseFirstRecovery = deferred();
    const recovered = deferred();
    let io!: SocketServer;
    let handshakes = 0;
    let recoveries = 0;
    let reads = 0;
    let terminalWrites = 0;
    let outputWrites = 0;
    const failure = vi.spyOn(console, 'error').mockImplementation(() => {});

    app.use('tasks', {
      async get(id: string) {
        expect(id).toBe(TASK_ID);
        reads += 1;
        if (reads === 1) {
          firstRead.resolve();
          return new Promise<Task>(() => {}); // RPC loses its acknowledgement on disconnect
        }
        return { task_id: id, session_id: SESSION_ID, status: TaskStatus.RUNNING };
      },
      async patch(id: string, data: Partial<Task>) {
        expect(id).toBe(TASK_ID);
        terminalWrites += 1;
        return { task_id: id, session_id: SESSION_ID, ...data };
      },
    });
    app.use('messages', {
      async create(data: unknown) {
        outputWrites += 1;
        return data;
      },
    });
    app.configure(
      socketio({}, (socketServer) => {
        io = socketServer;
        io.use((socket, next) => {
          if (socket.handshake.auth.token !== TOKEN || terminalWrites > 0) {
            next(new Error('Rejected scoped credential'));
            return;
          }
          handshakes += 1;
          next();
        });
        io.on('connection', (socket) => {
          socket.use((packet, next) => {
            if (packet[0] === 'patch' && packet[1] === 'tasks') {
              const acknowledge = packet[packet.length - 1];
              if (typeof acknowledge === 'function') {
                packet[packet.length - 1] = (...args: unknown[]) => {
                  acknowledge(...args);
                  socket.disconnect(true);
                };
              }
            }
            next();
          });
        });
      })
    );
    server = await new Promise<HttpServer>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    client = await createExecutorClient(`http://127.0.0.1:${address.port}`, TOKEN, {
      onReconnected: async () => {
        recoveries += 1;
        if (recoveries === 1) {
          try {
            await client!.service('tasks').get(TASK_ID);
          } finally {
            // Keep recovery pending until the newer connection is accepted.
            // It must request a refresh, not be silently coalesced away.
            await releaseFirstRecovery.promise;
          }
        } else {
          await client!.service('tasks').get(TASK_ID);
          recovered.resolve();
        }
      },
    });
    client.io.on('connect', () => {
      if (handshakes === 3) releaseFirstRecovery.resolve();
    });
    io.disconnectSockets(true);
    await firstRead.promise;
    io.disconnectSockets(true);
    await recovered.promise;
    expect(failure).toHaveBeenCalledExactlyOnceWith('[executor] Post-reconnect recovery failed');
    expect(handshakes).toBe(3);
    expect(recoveries).toBe(2);
    expect(reads).toBe(2);
    expect(terminalWrites).toBe(0);

    await client.service('messages').create({
      session_id: SESSION_ID,
      task_id: TASK_ID,
      role: MessageRole.ASSISTANT,
      type: 'assistant',
      index: 0,
      timestamp: '2026-01-01T00:00:00.000Z',
      content_preview: 'Output after transport recovery',
      content: 'Output after transport recovery',
    });
    await expect(
      client.service('tasks').patch(TASK_ID, {
        status: TaskStatus.COMPLETED,
      })
    ).resolves.toMatchObject({ status: TaskStatus.COMPLETED });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(outputWrites).toBe(1);
    expect(terminalWrites).toBe(1);
    expect(handshakes).toBe(3); // acknowledged terminality must not reopen a revoked bearer
    expect(client.io.connected).toBe(false);
  });
});
