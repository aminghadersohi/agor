import type { AgorClient } from '@agor-live/client';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AboutTab } from './AboutTab';

function clientWithHealth(health: Record<string, unknown>): AgorClient {
  return {
    service: () => ({ find: () => Promise.resolve(health) }),
  } as unknown as AgorClient;
}

describe('AboutTab daemon build row', () => {
  it('shows the fork version next to the build SHA', async () => {
    render(
      <AboutTab
        client={clientWithHealth({
          version: '0.1.0',
          buildSha: 'abc1234',
          forkVersion: '0.1.0+fork.20261017.1',
        })}
        connected
      />
    );
    expect(await screen.findByText('abc1234')).toBeInTheDocument();
    expect(screen.getByText('0.1.0+fork.20261017.1')).toBeInTheDocument();
  });

  it('is unchanged for daemons that do not report a fork version', async () => {
    render(
      <AboutTab client={clientWithHealth({ version: '0.1.0', buildSha: 'abc1234' })} connected />
    );
    expect(await screen.findByText('abc1234')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/\+fork\./)).not.toBeInTheDocument());
  });
});
