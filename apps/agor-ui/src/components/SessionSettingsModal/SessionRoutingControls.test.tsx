import type { AgorClient, Session } from '@agor-live/client';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { SessionRoutingControls } from './SessionRoutingControls';

const showError = vi.fn();
const showSuccess = vi.fn();
vi.mock('../../utils/message', () => ({
  useThemedMessage: () => ({ showError, showSuccess }),
}));

function makeSession(id: string, overrides: Partial<Session> = {}): Session {
  return {
    session_id: id,
    branch_id: 'branch-1',
    title: `Session ${id}`,
    agentic_tool: 'claude-code',
    status: 'idle',
    archived: false,
    genealogy: { children: [] },
    ...overrides,
  } as unknown as Session;
}

const coordinator = makeSession('coord-0000-0000');
const parent = makeSession('parent-000-0000');
const child = makeSession('child-0000-0000', {
  genealogy: { parent_session_id: parent.session_id, children: [] } as Session['genealogy'],
  callback_config: { enabled: true, callback_session_id: parent.session_id } as never,
});
const grandchild = makeSession('grand-0000-0000', {
  genealogy: { parent_session_id: child.session_id, children: [] } as Session['genealogy'],
});
const otherBranch = makeSession('other-0000-0000', { branch_id: 'branch-2' });
const archived = makeSession('archd-0000-0000', { archived: true });

function seed() {
  const all = [coordinator, parent, child, grandchild, otherBranch, archived];
  agorStore.setState({
    ...EMPTY_MAPS,
    sessionById: new Map(all.map((s) => [s.session_id, s])),
    sessionsByBranch: new Map([
      ['branch-1', [coordinator, parent, child, grandchild, archived]],
      ['branch-2', [otherBranch]],
    ]),
  });
}

function makeClient() {
  const create = vi.fn(async () => ({}));
  const paths: string[] = [];
  const client = {
    service: (path: string) => {
      paths.push(path);
      return { create };
    },
  } as unknown as AgorClient;
  return { client, create, paths };
}

async function choose(label: string, option: string) {
  fireEvent.mouseDown(screen.getByRole('combobox', { name: label }));
  const listbox = await screen.findByRole('listbox');
  // antd renders options in a virtual list; match on the visible label text.
  fireEvent.click(
    await within(listbox.parentElement as HTMLElement).findByTitle(new RegExp(option))
  );
}

describe('SessionRoutingControls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seed();
  });

  it('moves the standing callback anywhere loaded but never to itself or an archived session', async () => {
    const { client, create, paths } = makeClient();
    render(<SessionRoutingControls client={client} session={child} />);

    fireEvent.click(screen.getByRole('button', { name: 'Change callback target…' }));
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'New callback target' }));
    const titles = [...document.querySelectorAll('.ant-select-item-option')].map((o) =>
      o.getAttribute('title')
    );
    expect(titles.some((t) => t?.includes('other-00'))).toBe(true);
    expect(titles.some((t) => t?.includes('child-00'))).toBe(false);
    expect(titles.some((t) => t?.includes('archd-00'))).toBe(false);

    await choose('New callback target', 'Session coord');
    fireEvent.click(screen.getByRole('button', { name: 'Move callback' }));

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({ callbackSessionId: coordinator.session_id })
    );
    expect(paths).toContain(`sessions/${child.session_id}/retarget-callback`);
    expect(showSuccess).toHaveBeenCalledWith('Callback target changed');
  });

  it('offers only same-branch parents that would not form a cycle, plus detaching to a root', async () => {
    const { client, create, paths } = makeClient();
    render(<SessionRoutingControls client={client} session={child} />);

    fireEvent.click(screen.getByRole('button', { name: 'Change parent…' }));
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'New parent session' }));
    const titles = [...document.querySelectorAll('.ant-select-item-option')].map((o) =>
      o.getAttribute('title')
    );
    expect(titles).toContain('No parent (make this a root session)');
    expect(titles.some((t) => t?.includes('grand-00'))).toBe(false);
    expect(titles.some((t) => t?.includes('other-00'))).toBe(false);

    await choose('New parent session', 'No parent');
    fireEvent.click(screen.getByRole('button', { name: 'Change parent' }));

    await waitFor(() => expect(create).toHaveBeenCalledWith({ parentSessionId: null }));
    expect(paths).toContain(`sessions/${child.session_id}/reparent`);
  });

  it('hides the callback control when the session has no standing callback', () => {
    const { client } = makeClient();
    render(<SessionRoutingControls client={client} session={coordinator} />);
    expect(screen.queryByRole('button', { name: 'Change callback target…' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Change parent…' })).toBeInTheDocument();
  });

  it('keeps the picker open and shows the server reason when the change is refused', async () => {
    const { client, create } = makeClient();
    create.mockRejectedValueOnce(new Error('You need Manager permission on source session'));
    render(<SessionRoutingControls client={client} session={child} />);

    fireEvent.click(screen.getByRole('button', { name: 'Change parent…' }));
    await choose('New parent session', 'Session coord');
    fireEvent.click(screen.getByRole('button', { name: 'Change parent' }));

    await waitFor(() =>
      expect(showError).toHaveBeenCalledWith('You need Manager permission on source session')
    );
    expect(screen.getByRole('combobox', { name: 'New parent session' })).toBeInTheDocument();
  });
});
