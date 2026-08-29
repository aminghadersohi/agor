/**
 * Home / chat-workspace surface integration tests.
 *
 * These cover three reported interaction failures that all come down to
 * "the URL and the rendered surface disagree":
 *
 *   1. Opening Settings over Home (or the chat workspace) tore the surface
 *      down and swapped in the board canvas behind the modal, because the
 *      surface was derived from `location.pathname` and `/settings/...` is
 *      not Home. Settings is an overlay — see `getSurfacePath`.
 *
 *   2. Clicking Home with a session open never reached `/`. React Router
 *      commits `navigate()` in a transition, so `setPendingHomeNavigation`
 *      rendered once at the OLD path with the session already suppressed;
 *      `useUrlState`'s state→URL self-heal read that transitional pair as
 *      authoritative and `replace()`d the URL with `/b/<board>/`. That left
 *      `pendingHomeNavigation` armed forever — and while it is armed the
 *      shell renders Home for every non-entity URL and forces
 *      `effectiveSelectedSessionId` to null. Both reported symptoms fall
 *      out of that one wedged flag: board switches change the address bar
 *      while Home keeps rendering, and chat rows resolve but never select.
 *
 *   3. `/chats/<short>/` is the chat workspace's spelling of the open
 *      session, but `buildUrl` only knows `/s/<short>/`, so the self-heal
 *      rewrote it on the first board patch and ejected the user from the
 *      rail mid-conversation.
 *
 * They are written at the App level on purpose: each bug is an interaction
 * between the route table, `useUrlState`'s two effects, and the shell's
 * surface derivation. No single unit sees it.
 */
import type { Board, Branch, Session, User } from '@agor-live/client';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { forwardRef } from 'react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../../contexts/ThemeContext';
import { useSettingsRoute } from '../../hooks/useSettingsRoute';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { App } from './App';

// Surface stand-ins. Each renders the one attribute the assertions read, so
// a test can say "the board canvas is showing Beta" without depending on
// canvas internals.
vi.mock('../SessionCanvas', () => ({
  SessionCanvas: forwardRef((props: { board?: { name?: string } | null }) => (
    <div data-testid="session-canvas" data-board={props.board?.name ?? ''} />
  )),
}));
vi.mock('../SessionPanel', () => ({
  SessionPanel: (props: { session?: { session_id?: string } | null; open?: boolean }) =>
    props.open ? (
      <div data-testid="session-panel" data-session={props.session?.session_id ?? ''} />
    ) : null,
}));
vi.mock('../SessionPanel/PendingToolChoicePanel', () => ({
  PendingToolChoicePanel: () => null,
}));
vi.mock('../EventStreamPanel', () => ({ EventStreamPanel: () => null }));
vi.mock('../BoardTeammatePanel', () => ({
  BoardTeammatePanel: () => null,
  TeammatePanelRail: () => null,
}));
vi.mock('../NewSessionButton', () => ({ NewSessionButton: () => null }));
vi.mock('../SettingsModal', () => ({
  SettingsModal: (props: { open?: boolean }) =>
    props.open ? <div data-testid="settings-modal" /> : null,
  UserSettingsModal: () => null,
}));
vi.mock('../BranchModal', () => ({ BranchModal: () => null }));
vi.mock('../CreateDialog', () => ({ CreateDialog: () => null }));
vi.mock('../NewSessionModal', () => ({ NewSessionModal: () => null }));
vi.mock('../SessionSettingsModal', () => ({ SessionSettingsModal: () => null }));
vi.mock('../TerminalModal', () => ({
  TerminalModal: () => null,
  WEB_TERMINAL_MIN_ROLE: 'member',
}));
vi.mock('../ThemeEditorModal', () => ({ ThemeEditorModal: () => null }));
vi.mock('../EnvironmentLogsModal', () => ({ EnvironmentLogsModal: () => null }));
vi.mock('../TeammateChatCollections', () => ({ TeammateChatCollectionsModal: () => null }));
vi.mock('../../hooks/useTaskCompletionChime', () => ({ useTaskCompletionChime: () => {} }));
// react-resizable-panels needs real layout measurements jsdom cannot provide,
// and throws from the imperative handles App drives in effects.
vi.mock('react-resizable-panels', async () => {
  const React = await import('react');
  const noopHandle = { collapse: () => {}, expand: () => {}, resize: () => {} };
  const Panel = React.forwardRef<unknown, { children?: React.ReactNode }>(({ children }, ref) => {
    React.useImperativeHandle(ref, () => noopHandle, []);
    return <div>{children}</div>;
  });
  return {
    Panel,
    PanelGroup: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
    PanelResizeHandle: () => <div />,
  };
});

const BOARD_A = '019e7777-0000-7000-8000-00000000000a';
const BOARD_B = '019e7777-0000-7000-8000-00000000000b';
const BRANCH_A = '019e8888-0000-7000-8000-00000000000a';
const BRANCH_B = '019e8888-0000-7000-8000-00000000000b';
const SESSION_1 = '019e9999-0000-7000-8000-000000000001';
const SESSION_1_SHORT = '019e99990000700080000000';
const SESSION_2 = '019eaaaa-0000-7000-8000-000000000002';

const boardA = { board_id: BOARD_A, name: 'Alpha', slug: 'alpha', archived: false } as Board;
const boardB = { board_id: BOARD_B, name: 'Beta', slug: 'beta', archived: false } as Board;
const branchA = {
  branch_id: BRANCH_A,
  repo_id: 'repo-1',
  board_id: BOARD_A,
  name: 'orbit',
  archived: false,
  custom_context: { teammate: { kind: 'teammate', displayName: 'Orbit', emoji: '🛰️' } },
} as unknown as Branch;
const branchB = {
  branch_id: BRANCH_B,
  repo_id: 'repo-1',
  board_id: BOARD_B,
  name: 'signal',
  archived: false,
  custom_context: { teammate: { kind: 'teammate', displayName: 'Signal', emoji: '📡' } },
} as unknown as Branch;
const session1 = {
  session_id: SESSION_1,
  branch_id: BRANCH_A,
  title: 'Orbit standup',
  status: 'idle',
  archived: false,
  genealogy: {},
  agentic_tool: 'codex',
  last_updated: '2026-08-25T12:00:00.000Z',
} as unknown as Session;
const session2 = {
  session_id: SESSION_2,
  branch_id: BRANCH_B,
  title: 'Signal triage',
  status: 'idle',
  archived: false,
  genealogy: {},
  agentic_tool: 'codex',
  last_updated: '2026-08-25T11:00:00.000Z',
} as unknown as Session;
const user = {
  user_id: 'user-1',
  name: 'Tester',
  email: 'tester@example.test',
  role: 'admin',
  preferences: {
    chat_collections: {
      collections: [{ collection_id: 'crew', name: 'Crew', session_ids: [SESSION_1, SESSION_2] }],
    },
  },
} as unknown as User;

function seedStore() {
  agorStore.setState({
    ...EMPTY_MAPS,
    boardById: new Map([
      [BOARD_A, boardA],
      [BOARD_B, boardB],
    ]),
    branchById: new Map([
      [BRANCH_A, branchA],
      [BRANCH_B, branchB],
    ]),
    sessionById: new Map([
      [SESSION_1, session1],
      [SESSION_2, session2],
    ]),
    sessionsByBranch: new Map([
      [BRANCH_A, [session1]],
      [BRANCH_B, [session2]],
    ]),
    userById: new Map([[user.user_id, user]]),
  } as never);
}

let currentPath = '';
function PathSpy() {
  currentPath = useLocation().pathname;
  return null;
}

/** Drives the real settings-route open path — the same call the gear menu
 *  makes — so the test exercises `openSettings`'s history-state contract
 *  rather than a hand-rolled navigate. */
function SettingsOpener() {
  const { openSettings } = useSettingsRoute();
  return (
    <button type="button" data-testid="open-settings" onClick={() => openSettings()}>
      settings
    </button>
  );
}

/** Stands in for closing the session panel inside the chat workspace,
 *  which routes to the workspace root. SessionPanel itself is mocked. */
function ChatWorkspaceRootLink() {
  const navigate = useNavigate();
  return (
    <button type="button" data-testid="go-chats-root" onClick={() => navigate('/chats/')}>
      chats root
    </button>
  );
}

/** Route table mirrors `apps/agor-ui/src/App.tsx` — the bugs live in how
 *  these paths resolve, so an approximation would not reproduce them. */
function renderApp(initialPath: string) {
  const el = (
    <App client={null} user={user} connected={true} availableAgents={[]} initialBoardId="" />
  );
  return render(
    <ThemeProvider>
      <AntApp>
        <MemoryRouter initialEntries={[initialPath]}>
          <PathSpy />
          <SettingsOpener />
          <ChatWorkspaceRootLink />
          <Routes>
            <Route path="/b/:boardParam/" element={el} />
            <Route path="/s/:sessionShortId/" element={el} />
            <Route path="/w/:branchShortId/" element={el} />
            <Route path="/a/:artifactShortId/" element={el} />
            <Route path="/chats/" element={el} />
            <Route path="/chats/:sessionShortId/" element={el} />
            <Route path="/*" element={el} />
          </Routes>
        </MemoryRouter>
      </AntApp>
    </ThemeProvider>
  );
}

/** Let the router transition, both URL⇄state effects, and the deferred
 *  recenter timer all settle. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
}

const homeIsShowing = () => !!screen.queryByText(/Hi, Tester/);
const chatRailIsShowing = () => !!document.querySelector('nav[aria-label="Chat collections"]');
const canvasBoardName = () =>
  screen.queryByTestId('session-canvas')?.getAttribute('data-board') ?? null;
const openSessionId = () =>
  screen.queryByTestId('session-panel')?.getAttribute('data-session') ?? null;

function clickHomeButton() {
  fireEvent.click(document.querySelector('[aria-label="Go to Home"]') as HTMLElement);
}

/** Open the navbar board switcher and choose a board by name. */
async function pickBoardFromSwitcher(name: string) {
  const trigger = document
    .querySelector('[data-current-board-name]')
    ?.closest('button') as HTMLElement;
  fireEvent.click(trigger);
  await settle();
  const item = Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) =>
    el.textContent?.includes(name)
  );
  if (!item) throw new Error(`board "${name}" not offered by the switcher`);
  fireEvent.click(item);
  await settle();
}

describe('Settings opens as an overlay, not a navigation', () => {
  beforeEach(() => {
    localStorage.clear();
    seedStore();
  });

  it('keeps Home rendered behind the settings modal', async () => {
    renderApp('/');
    await settle();
    expect(homeIsShowing()).toBe(true);

    fireEvent.click(screen.getByTestId('open-settings'));
    await settle();

    expect(screen.getByTestId('settings-modal')).toBeTruthy();
    // The reported symptom: Home tore down and the board canvas appeared
    // behind the modal before it could open.
    expect(homeIsShowing()).toBe(true);
    expect(screen.queryByTestId('session-canvas')).toBeNull();
  });

  it('keeps the chat workspace rendered behind the settings modal', async () => {
    renderApp('/');
    await settle();
    fireEvent.click(await screen.findByText('Orbit standup'));
    await settle();
    expect(chatRailIsShowing()).toBe(true);

    fireEvent.click(screen.getByTestId('open-settings'));
    await settle();

    expect(screen.getByTestId('settings-modal')).toBeTruthy();
    expect(chatRailIsShowing()).toBe(true);
    expect(openSessionId()).toBe(SESSION_1);
    expect(screen.queryByTestId('session-canvas')).toBeNull();
  });
});

describe('Home navigation with a session open', () => {
  beforeEach(() => {
    localStorage.clear();
    seedStore();
  });

  it('reaches "/" instead of being replaced by the board URL', async () => {
    renderApp(`/s/${SESSION_1_SHORT}/`);
    await settle();
    expect(openSessionId()).toBe(SESSION_1);

    clickHomeButton();
    await settle();

    // Before the fix this settled on `/b/alpha/`: the self-heal saw the
    // transitional (board, session=null) pair and cancelled the `/` push.
    expect(currentPath).toBe('/');
    expect(homeIsShowing()).toBe(true);
  });

  it('leaves the board switcher working afterwards', async () => {
    renderApp(`/s/${SESSION_1_SHORT}/`);
    await settle();
    clickHomeButton();
    await settle();

    await pickBoardFromSwitcher('Beta');

    // Reported symptom C: the URL changed but the view stayed on Home,
    // because `pendingHomeNavigation` was still armed.
    expect(currentPath).toBe('/b/beta/');
    expect(canvasBoardName()).toBe('Beta');
    expect(homeIsShowing()).toBe(false);
  });

  it('does not wedge the Home surface when another navigation supersedes it', async () => {
    renderApp(`/s/${SESSION_1_SHORT}/`);
    await settle();
    // Pre-open the switcher so the board can be chosen in the same tick as
    // the Home click — the Home transition loses, and the pending flag must
    // not survive landing somewhere that is not `/`.
    const trigger = document
      .querySelector('[data-current-board-name]')
      ?.closest('button') as HTMLElement;
    fireEvent.click(trigger);
    await settle();
    const betaItem = Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) =>
      el.textContent?.includes('Beta')
    ) as HTMLElement;

    clickHomeButton();
    fireEvent.click(betaItem);
    await settle();

    expect(currentPath).toBe('/b/beta/');
    expect(canvasBoardName()).toBe('Beta');
    expect(homeIsShowing()).toBe(false);
  });

  it('still selects a pinned chat after a Home round trip', async () => {
    renderApp(`/s/${SESSION_1_SHORT}/`);
    await settle();
    clickHomeButton();
    await settle();

    fireEvent.click(await screen.findByText('Signal triage'));
    await settle();

    // Reported symptom B: the row click resolved and the URL changed, but
    // nothing selected, because the wedged flag nulled the effective
    // selection.
    expect(currentPath).toBe('/chats/019eaaaa0000700080000000/');
    expect(openSessionId()).toBe(SESSION_2);
  });
});
