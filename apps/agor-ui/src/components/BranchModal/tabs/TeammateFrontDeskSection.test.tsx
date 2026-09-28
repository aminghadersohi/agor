import type { AgorClient, Branch, Session, TeammateFrontDeskView } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionProvider } from '../../../contexts/ConnectionContext';
import { TeammateFrontDeskSection } from './TeammateFrontDeskSection';

const messages = vi.hoisted(() => ({
  showSuccess: vi.fn(),
  showError: vi.fn(),
  showWarning: vi.fn(),
}));
vi.mock('../../../utils/message', () => ({ useThemedMessage: () => messages }));

const branch = {
  branch_id: 'branch-1',
  archived: false,
  custom_context: { teammate: { kind: 'teammate', displayName: 'Front Desk' } },
} as unknown as Branch;

function session(id: string, title: string, archived = false): Session {
  return {
    session_id: id,
    branch_id: branch.branch_id,
    title,
    agentic_tool: 'claude-code',
    status: 'idle',
    archived,
  } as unknown as Session;
}

const sessions = [
  session('session-desk', 'Desk session'),
  session('session-work', 'Work session'),
  session('session-old', 'Archived session', true),
];

function view(pinned: string | null, canManage: boolean): TeammateFrontDeskView {
  return {
    branch_id: branch.branch_id,
    front_desk: pinned
      ? ({ session_id: pinned, status: 'active' } as TeammateFrontDeskView['front_desk'])
      : null,
    can_manage: canManage,
  } as TeammateFrontDeskView;
}

function renderSection(
  service: Record<string, ReturnType<typeof vi.fn>>,
  { connected = true }: { connected?: boolean } = {}
) {
  const client = { service: () => service } as unknown as AgorClient;
  return render(
    <ConnectionProvider
      value={{
        connected,
        connecting: false,
        outOfSync: false,
        capturedSha: null,
        currentSha: null,
      }}
    >
      <AntApp>
        <TeammateFrontDeskSection branch={branch} client={client} sessions={sessions} />
      </AntApp>
    </ConnectionProvider>
  );
}

describe('TeammateFrontDeskSection', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the pinned session to a viewer without offering controls', async () => {
    renderSection({ find: vi.fn(async () => view('session-desk', false)) });

    expect(await screen.findByTestId('front-desk-current')).toHaveTextContent('Desk session');
    expect(screen.getByText('Only a Branch Manager can change the front desk.')).toBeVisible();
    expect(screen.queryByRole('button', { name: /Unpin/ })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('combobox', { name: 'Session to pin as front desk' })
    ).not.toBeInTheDocument();
  });

  it('explains the recency fallback when nothing is pinned', async () => {
    renderSection({ find: vi.fn(async () => view(null, false)) });
    expect(
      await screen.findByText('None — the most recently active session answers')
    ).toBeVisible();
  });

  it('lets a Branch Manager pin an active session, offering only unpinned active ones', async () => {
    const create = vi.fn(async () => view('session-work', true));
    renderSection({ find: vi.fn(async () => view('session-desk', true)), create });

    const select = await screen.findByRole('combobox', { name: 'Session to pin as front desk' });
    const pinButton = screen.getByRole('button', { name: /Replace pin/ });
    expect(pinButton).toBeDisabled();

    fireEvent.mouseDown(select);
    const workOption = await screen.findByTitle('Work session');
    // Neither the current desk nor an archived session is a candidate.
    expect(screen.queryByTitle('Desk session')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Archived session')).not.toBeInTheDocument();
    fireEvent.click(workOption);

    fireEvent.click(screen.getByRole('button', { name: /Replace pin/ }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        session_id: 'session-work',
        expected_session_id: 'session-desk',
      })
    );
    await waitFor(() =>
      expect(screen.getByTestId('front-desk-current')).toHaveTextContent('Work session')
    );
  });

  it('lets a Branch Manager unpin after confirming', async () => {
    const remove = vi.fn(async () => view(null, true));
    renderSection({ find: vi.fn(async () => view('session-desk', true)), remove });

    fireEvent.click(await screen.findByRole('button', { name: /Unpin/ }));
    await screen.findByText('Unpin front desk?');
    fireEvent.click(await screen.findByRole('button', { name: 'OK' }));

    await waitFor(() =>
      expect(remove).toHaveBeenCalledWith(null, { query: { expected_session_id: 'session-desk' } })
    );
    expect(
      await screen.findByText('None — the most recently active session answers')
    ).toBeVisible();
  });

  it('disables the controls while disconnected from the daemon', async () => {
    renderSection({ find: vi.fn(async () => view('session-desk', true)) }, { connected: false });
    expect(await screen.findByRole('button', { name: /Unpin/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Replace pin/ })).toBeDisabled();
  });

  it('shows who name addressing reaches and the name to use, from the daemon preview', async () => {
    const find = vi.fn(async (params?: { query?: Record<string, unknown> }) =>
      params?.query?.include_addressing
        ? {
            ...view('session-desk', false),
            addressing: {
              via: 'recency',
              session_id: 'session-work',
              name_addressing: { addressable: true, address: 'front-desk' },
              bypassed_front_desk: { session_id: 'session-desk', reason: 'dead' },
            },
          }
        : view('session-desk', false)
    );
    renderSection({ find });

    expect(await screen.findByTestId('front-desk-reaches')).toHaveTextContent('Work session');
    expect(screen.getByText('Most recent')).toBeVisible();
    expect(
      screen.getByText('The pinned session is skipped because its executor stopped.')
    ).toBeVisible();
    expect(screen.getByTestId('front-desk-address')).toHaveTextContent('front-desk');
    expect(find).toHaveBeenCalledWith({ query: { include_addressing: true } });
  });

  it('says why the teammate is not addressable by name, and when it has no session', async () => {
    renderSection({
      find: vi.fn(async () => ({
        ...view(null, false),
        addressing: {
          via: 'needs_session',
          session_id: null,
          name_addressing: {
            addressable: false,
            reason: 'no_prompt_permission',
            detail: 'You can see this teammate but lack session permission on its branch.',
          },
          bypassed_front_desk: null,
        },
      })),
    });

    expect(await screen.findByTestId('front-desk-reaches')).toHaveTextContent(
      'No active session — a message by name is refused until one is started'
    );
    expect(screen.getByTestId('front-desk-address')).toHaveTextContent(
      'Not addressable by name for you. You can see this teammate but lack session permission on its branch.'
    );
  });

  it('reports a load failure instead of controls', async () => {
    renderSection({
      find: vi.fn(async () => {
        throw new Error('Teammate not found');
      }),
    });
    expect(await screen.findByText('Front desk unavailable: Teammate not found')).toBeVisible();
    expect(screen.queryByRole('button', { name: /Pin/ })).not.toBeInTheDocument();
  });
});
