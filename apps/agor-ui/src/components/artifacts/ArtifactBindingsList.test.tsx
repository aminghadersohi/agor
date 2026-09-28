import type { ArtifactInteractionConfig } from '@agor-live/client';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ArtifactBindingsList } from './ArtifactBindingsList';

const SCHEDULE = '019f0000-0000-7000-8000-00000000000a';
const SESSION = '019f0000-0000-7000-8000-00000000000b';

describe('ArtifactBindingsList', () => {
  it('lists every binding with its id, kind, target and confirmation', () => {
    const config = {
      actions: [
        {
          id: 'disarm',
          label: 'Disarm',
          confirm: true,
          description: 'Stops the nightly release check.',
          effect: { kind: 'schedule_set_enabled', schedule_id: SCHEDULE, enabled: false },
        },
        {
          id: 'run-now',
          label: 'Run once',
          effect: { kind: 'schedule_run', schedule_id: SCHEDULE },
        },
      ],
      data: [
        {
          id: 'triage-status',
          label: 'Triage',
          source: { kind: 'session_status', session_id: SESSION },
        },
      ],
      chats: [{ id: 'triage', label: 'Release triage', session_id: SESSION }],
    } as ArtifactInteractionConfig;

    render(<ArtifactBindingsList config={config} />);

    const items = within(screen.getByRole('list', { name: 'Interaction bindings' })).getAllByRole(
      'listitem'
    );
    expect(items).toHaveLength(4);

    expect(items[0]).toHaveTextContent('Action');
    expect(items[0]).toHaveTextContent('disarm');
    expect(items[0]).toHaveTextContent('schedule_set_enabled · Disable schedule 019f0000');
    expect(items[0]).toHaveTextContent('Confirms first');
    expect(items[0]).toHaveTextContent('Stops the nightly release check.');

    expect(items[1]).toHaveTextContent('schedule_run · Run schedule 019f0000');
    expect(items[1]).not.toHaveTextContent('Confirms first');

    expect(items[2]).toHaveTextContent('Data');
    expect(items[2]).toHaveTextContent('session_status · Session 019f0000');

    expect(items[3]).toHaveTextContent('Chat');
    expect(items[3]).toHaveTextContent('open_chat · Session 019f0000');
  });

  it('shows an empty state when nothing is declared', () => {
    render(<ArtifactBindingsList config={undefined} />);
    expect(screen.getByText('No interaction bindings declared')).toBeInTheDocument();
  });
});
