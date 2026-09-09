import type { AgorClient } from '@agor-live/client';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { App as AntApp, ConfigProvider } from 'antd';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionMemoryReminders } from './SessionMemoryReminders';

function client(): AgorClient {
  const service = {
    find: async () => ({ total: 0, limit: 25, skip: 0, data: [] }),
    create: async () => ({}),
    patch: async () => ({}),
    on: () => undefined,
    off: () => undefined,
  };
  return { service: vi.fn(() => service) } as unknown as AgorClient;
}

afterEach(cleanup);

describe('Session memory and reminders responsive surface (real browser)', () => {
  for (const [name, width, height] of [
    ['desktop', 1280, 800],
    ['phone', 390, 844],
    ['tablet', 768, 1024],
    ['short landscape', 844, 390],
  ] as const) {
    it(`remains keyboard-usable without horizontal clipping on ${name}`, async () => {
      window.resizeTo(width, height);
      const { container } = render(
        <ConfigProvider theme={{ token: { motion: false } }}>
          <AntApp>
            <div style={{ width: 'min(100%, 600px)', maxHeight: '100vh', overflow: 'auto' }}>
              <SessionMemoryReminders
                client={client()}
                sessionId="019f0000-0000-7000-8000-000000000001"
                sessionArchived={false}
              />
            </div>
          </AntApp>
        </ConfigProvider>
      );
      const search = await screen.findByLabelText("Search this Session's memory");
      search.focus();
      expect(document.activeElement).toBe(search);
      fireEvent.keyDown(search, { key: 'Tab' });
      expect(container.scrollWidth).toBeLessThanOrEqual(Math.max(container.clientWidth, width));
      fireEvent.click(screen.getByText('Reminders'));
      expect(await screen.findByLabelText('Reminder prompt')).toBeVisible();
    });
  }
});
