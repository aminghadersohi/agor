import type { Branch, Repo, Session } from '@agor-live/client';
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
  name: 'feature/canvas-density',
  repo_id: 'repo-1',
  path: '/tmp/feature-canvas-density',
  filesystem_status: 'ready',
  archived: false,
} as unknown as Branch;

const repo = { repo_id: 'repo-1', slug: 'preset-io/agor' } as unknown as Repo;

const session = (
  id: string,
  title: string,
  lastUpdated: string,
  status = 'idle',
  attentionGeneration = 0,
  seenAttentionGeneration = 0
) =>
  ({
    session_id: id,
    title,
    status,
    last_updated: lastUpdated,
    archived: false,
    attention_generation: attentionGeneration,
    viewer_seen_attention_generation: seenAttentionGeneration,
  }) as unknown as Session;

function renderCard(props: Partial<React.ComponentProps<typeof BranchCard>> = {}) {
  return render(
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
}

describe('CompactSessionPicker', () => {
  const sessions = [
    session('s-old', 'Older session', '2026-08-01T00:00:00.000Z'),
    session('s-new', 'Newest session', '2026-08-28T00:00:00.000Z', 'running'),
  ];

  it('offers the session list only while the card is collapsed', () => {
    // Expanded cards already render their session sections; a second route to
    // the same sessions in the header would be redundant chrome.
    const { unmount } = renderCard({ compact: true, sessions, onToggleCompact: vi.fn() });
    expect(screen.getByLabelText('Sessions (2)')).toBeTruthy();
    unmount();

    renderCard({ compact: false, sessions, onToggleCompact: vi.fn() });
    expect(screen.queryByLabelText('Sessions (2)')).toBeNull();
  });

  it('renders no badge when sessions exist but this viewer has seen them', () => {
    const { container } = renderCard({
      compact: true,
      sessions,
      onToggleCompact: vi.fn(),
    });
    const button = screen.getByLabelText('Sessions (2)');

    expect(button.closest('.ant-badge')?.querySelector('.ant-badge-count')).toBeNull();
    expect(container.querySelector('.ant-card')?.style.boxShadow).toBe('');
  });

  it('counts unseen sessions rather than total sessions and drives the card glow', () => {
    const threeSessions = [
      session('s-unseen-1', 'Unseen one', '2026-08-28T00:00:00.000Z', 'idle', 1, 0),
      session('s-seen', 'Seen', '2026-08-27T00:00:00.000Z', 'idle', 4, 4),
      session('s-unseen-2', 'Unseen two', '2026-08-26T00:00:00.000Z', 'failed', 3, 2),
    ];
    const { container } = renderCard({
      compact: true,
      sessions: threeSessions,
      onToggleCompact: vi.fn(),
    });
    const button = screen.getByLabelText('Sessions (3)');
    const badge = button.closest('.ant-badge')?.querySelector('.ant-badge-count');

    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe('2');
    expect(container.querySelector('.ant-card')?.style.boxShadow).not.toBe('');
  });

  it('does not let shared branch attention create a session badge or glow', () => {
    const { container } = renderCard({
      branch: { ...branch, needs_attention: true } as Branch,
      compact: true,
      sessions,
      onToggleCompact: vi.fn(),
    });
    const button = screen.getByLabelText('Sessions (2)');

    expect(button.closest('.ant-badge')?.querySelector('.ant-badge-count')).toBeNull();
    expect(container.querySelector('.ant-card')?.style.boxShadow).toBe('');
  });

  it('keeps unresolved terminal attention glowing after its result is seen', () => {
    const failed = {
      ...session('s-failed', 'Failed run', '2026-08-28T00:00:00.000Z', 'failed', 2, 2),
      ready_for_prompt: true,
    } as Session;
    const { container } = renderCard({
      compact: true,
      sessions: [failed],
      onToggleCompact: vi.fn(),
    });
    const button = screen.getByLabelText('Sessions (1)');

    expect(button.closest('.ant-badge')?.querySelector('.ant-badge-count')).toBeNull();
    expect(container.querySelector('.ant-card')?.style.boxShadow).not.toBe('');
  });

  it('opens a session without expanding the card', async () => {
    const onSessionClick = vi.fn();
    const onToggleCompact = vi.fn();
    renderCard({ compact: true, sessions, onSessionClick, onToggleCompact });

    fireEvent.click(screen.getByLabelText('Sessions (2)'));
    fireEvent.click(await screen.findByText('Newest session'));

    expect(onSessionClick).toHaveBeenCalledWith('s-new');
    // The whole point: selecting a session must not undo the collapse.
    expect(onToggleCompact).not.toHaveBeenCalled();
  });

  it('lists the most recently updated session first', async () => {
    renderCard({ compact: true, sessions, onToggleCompact: vi.fn() });

    fireEvent.click(screen.getByLabelText('Sessions (2)'));

    const options = await screen.findAllByRole('option');
    expect(options[0].textContent).toContain('Newest session');
    expect(options[1].textContent).toContain('Older session');
  });

  it('offers to create one when the branch has no sessions', async () => {
    const onCreateSession = vi.fn();
    renderCard({ compact: true, sessions: [], onCreateSession, onToggleCompact: vi.fn() });

    fireEvent.click(screen.getByLabelText('Sessions (0)'));
    fireEvent.click(await screen.findByText('New Session'));

    expect(onCreateSession).toHaveBeenCalledWith('branch-1');
  });

  it('marks the open session as the selected option', async () => {
    renderCard({
      compact: true,
      sessions,
      selectedSessionId: 's-old',
      onToggleCompact: vi.fn(),
    });

    fireEvent.click(screen.getByLabelText('Sessions (2)'));

    await waitFor(() => {
      const selected = screen
        .getAllByRole('option')
        .filter((o) => o.getAttribute('aria-selected') === 'true');
      expect(selected).toHaveLength(1);
      expect(selected[0].textContent).toContain('Older session');
    });
  });
});
