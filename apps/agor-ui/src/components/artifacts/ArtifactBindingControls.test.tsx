import type { ArtifactInteractionConfig } from '@agor-live/client';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArtifactBindingControls } from './ArtifactBindingControls';

const SCHEDULE = '019f0000-0000-7000-8000-00000000000a';
const SESSION = '019f0000-0000-7000-8000-00000000000b';

const config = {
  data: [
    {
      id: 'nightly',
      label: 'Nightly',
      source: { kind: 'schedule_status', schedule_id: SCHEDULE },
    },
  ],
  actions: [
    { id: 'run-now', label: 'Run once', effect: { kind: 'schedule_run', schedule_id: SCHEDULE } },
    {
      id: 'disarm',
      label: 'Disarm',
      confirm: true,
      description: 'Stops the nightly release check.',
      effect: { kind: 'schedule_set_enabled', schedule_id: SCHEDULE, enabled: false },
    },
  ],
  chats: [{ id: 'triage', label: 'Release triage', session_id: SESSION }],
} as ArtifactInteractionConfig;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Daemon stub: the schedule starts armed and the `disarm` action flips it. */
function stubDaemon() {
  let enabled = true;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.endsWith('/artifacts/artifact-1/data/nightly') && init?.method === 'GET') {
      return json({
        kind: 'schedule_status',
        schedule_id: SCHEDULE,
        name: 'Nightly release check',
        enabled,
        cron_expression: '0 2 * * *',
        next_run_at: null,
        last_run_at: null,
      });
    }
    if (url.endsWith('/artifacts/artifact-1/actions/disarm') && init?.method === 'POST') {
      enabled = false;
      return json({ action_id: 'disarm', effect: 'schedule_set_enabled' });
    }
    if (url.endsWith('/artifacts/artifact-1/actions/run-now') && init?.method === 'POST') {
      return json({ action_id: 'run-now', effect: 'schedule_run' });
    }
    return json({ message: `unexpected ${init?.method} ${url}` }, 500);
  });
}

function renderControls(onOpenSession = vi.fn()) {
  render(
    <AntApp>
      <ArtifactBindingControls
        artifactId="artifact-1"
        config={config}
        onOpenSession={onOpenSession}
      />
    </AntApp>
  );
  return { onOpenSession, toolbar: screen.getByRole('toolbar', { name: 'Artifact controls' }) };
}

const calls = (fetchMock: ReturnType<typeof stubDaemon>) =>
  fetchMock.mock.calls.map(
    ([url, init]) => `${init?.method} ${String(url).replace(/^.*?\/artifacts\//, '/artifacts/')}`
  );

describe('ArtifactBindingControls', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders each declared binding as a control and reads data bindings', async () => {
    const fetchMock = stubDaemon();
    const { toolbar } = renderControls();

    expect(within(toolbar).getByRole('button', { name: 'Run once' })).toBeInTheDocument();
    expect(within(toolbar).getByRole('button', { name: 'Disarm' })).toBeInTheDocument();
    expect(within(toolbar).getByRole('button', { name: /Release triage/ })).toBeInTheDocument();
    expect(await within(toolbar).findByText('Nightly: Armed')).toBeInTheDocument();
    expect(calls(fetchMock)).toEqual(['GET /artifacts/artifact-1/data/nightly']);
  });

  it('fires the artifact-scoped action route with no arguments', async () => {
    const fetchMock = stubDaemon();
    const { toolbar } = renderControls();
    await within(toolbar).findByText('Nightly: Armed');

    fireEvent.click(within(toolbar).getByRole('button', { name: 'Run once' }));

    await waitFor(() =>
      expect(calls(fetchMock)).toContain('POST /artifacts/artifact-1/actions/run-now')
    );
    const [, init] = fetchMock.mock.calls.find(([url]) => String(url).includes('/actions/'))!;
    // The binding id is the only thing that travels: no schedule, no body.
    expect(init?.body).toBe('{}');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes(SCHEDULE))).toBe(false);
  });

  it('asks for confirmation first, and refreshes data after the action', async () => {
    const fetchMock = stubDaemon();
    const { toolbar } = renderControls();
    await within(toolbar).findByText('Nightly: Armed');

    fireEvent.click(within(toolbar).getByRole('button', { name: 'Disarm' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getAllByText('Run “Disarm”?').length).toBeGreaterThan(0);
    expect(within(dialog).getByText('Stops the nightly release check.')).toBeInTheDocument();
    expect(calls(fetchMock)).not.toContain('POST /artifacts/artifact-1/actions/disarm');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Run action' }));

    expect(await within(toolbar).findByText('Nightly: Disarmed')).toBeInTheDocument();
    expect(calls(fetchMock)).toEqual([
      'GET /artifacts/artifact-1/data/nightly',
      'POST /artifacts/artifact-1/actions/disarm',
      'GET /artifacts/artifact-1/data/nightly',
    ]);
  });

  it('does nothing when the confirmation is cancelled', async () => {
    const fetchMock = stubDaemon();
    const { toolbar } = renderControls();
    await within(toolbar).findByText('Nightly: Armed');

    fireEvent.click(within(toolbar).getByRole('button', { name: 'Disarm' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    // Give a (wrongly) dispatched request time to show up.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls(fetchMock)).toEqual(['GET /artifacts/artifact-1/data/nightly']);
  });

  it('opens a chat binding in the parent session surface', async () => {
    const fetchMock = stubDaemon();
    const { toolbar, onOpenSession } = renderControls();
    await within(toolbar).findByText('Nightly: Armed');

    fireEvent.click(within(toolbar).getByRole('button', { name: /Release triage/ }));

    expect(onOpenSession).toHaveBeenCalledWith(SESSION);
    expect(calls(fetchMock)).toEqual(['GET /artifacts/artifact-1/data/nightly']);
  });

  it('shows a data binding the viewer cannot read as unavailable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ message: 'Forbidden' }, 403));
    const { toolbar } = renderControls();
    expect(await within(toolbar).findByText('Nightly: Unavailable')).toBeInTheDocument();
  });

  it('renders nothing for an artifact without bindings', () => {
    const { container } = render(
      <AntApp>
        <ArtifactBindingControls artifactId="artifact-1" />
      </AntApp>
    );
    expect(container.querySelector('[role="toolbar"]')).toBeNull();
  });
});
