// biome-ignore-all lint/plugin/noHardcodedColorLiteral: color fixtures verify the user-selectable entity palette
import type { AgorClient, Branch, Repo } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import BranchCard from './BranchCard';

const connected = {
  connected: true,
  connecting: false,
  outOfSync: false,
  capturedSha: null,
  currentSha: null,
};

const branch = {
  branch_id: 'branch-1',
  name: 'feature/labels',
  repo_id: 'repo-1',
  path: '/tmp/feature-labels',
  filesystem_status: 'ready',
  archived: false,
} as unknown as Branch;

const repo = { repo_id: 'repo-1', slug: 'preset-io/agor' } as unknown as Repo;

/** Minimal stand-in for the Feathers client: only `branches.patch` is exercised. */
const clientWithPatch = (patch: ReturnType<typeof vi.fn>) =>
  ({ service: () => ({ patch }) }) as unknown as AgorClient;

const renderCard = (props: Partial<React.ComponentProps<typeof BranchCard>> = {}) =>
  render(
    <ConnectionProvider value={connected}>
      <BranchCard
        branch={branch}
        repo={repo}
        sessions={[]}
        userById={new Map()}
        client={null}
        {...props}
      />
    </ConnectionProvider>
  );

describe('BranchCard color', () => {
  it('needs a client to offer the picker, and hides it in popover mode', () => {
    renderCard();
    expect(screen.queryByLabelText('Branch color')).toBeNull();

    const { rerender } = renderCard({ client: clientWithPatch(vi.fn()) });
    expect(screen.getByLabelText('Branch color')).not.toBeNull();

    rerender(
      <ConnectionProvider value={connected}>
        <BranchCard
          branch={branch}
          repo={repo}
          sessions={[]}
          userById={new Map()}
          client={clientWithPatch(vi.fn())}
          inPopover
        />
      </ConnectionProvider>
    );
    expect(screen.queryByLabelText('Branch color')).toBeNull();
  });

  it('persists a picked swatch immediately and clears on No color', async () => {
    const patch = vi.fn().mockResolvedValue({});
    renderCard({
      branch: { ...branch, color_override: '#ff5630' } as unknown as Branch,
      client: clientWithPatch(patch),
    });

    fireEvent.click(screen.getByLabelText('Branch color'));
    fireEvent.click(await screen.findByRole('button', { name: 'Blue' }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch).toHaveBeenCalledWith('branch-1', {
      color_override: expect.stringMatching(/^#[0-9a-f]{6}$/i),
    });

    fireEvent.click(screen.getByLabelText('Branch color'));
    fireEvent.click(await screen.findByRole('button', { name: 'No color' }));
    await waitFor(() =>
      expect(patch).toHaveBeenLastCalledWith('branch-1', { color_override: null })
    );
  });

  it('disables the picker while the branch is being deleted', () => {
    renderCard({
      branch: { ...branch, deletion_status: 'deleting' } as unknown as Branch,
      client: clientWithPatch(vi.fn()),
    });

    expect(screen.getByLabelText('Branch color')).toBeDisabled();
  });
});
