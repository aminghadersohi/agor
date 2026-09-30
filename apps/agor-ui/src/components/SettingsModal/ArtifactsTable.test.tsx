import type { AgorClient, Artifact, Board, Branch, User } from '@agor-live/client';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ArtifactsTable } from './ArtifactsTable';

const artifact = {
  artifact_id: 'artifact-1',
  name: 'API explorer',
  board_id: 'board-1',
  branch_id: null,
  created_by: 'user-1',
  template: 'static',
  build_status: 'error',
  created_at: '2026-01-01T00:00:00Z',
  archived: false,
} as Artifact;

function setup(
  rows: Artifact[] = [artifact],
  users = new Map([['user-1', { user_id: 'user-1', name: 'Alex Morgan' } as User]])
) {
  const onUpdate = vi.fn();
  const onDelete = vi.fn();
  render(
    <MemoryRouter>
      <ArtifactsTable
        artifactById={new Map(rows.map((row) => [row.artifact_id, row]))}
        boardById={new Map([['board-1', { board_id: 'board-1', name: 'Engineering' } as Board]])}
        branchById={new Map()}
        userById={users}
        onUpdate={onUpdate}
        onDelete={onDelete}
      />
    </MemoryRouter>
  );
  return { onUpdate, onDelete };
}

describe('ArtifactsTable', () => {
  it('separates board, owner and build; filters by the existing directory', () => {
    setup();
    expect(screen.getAllByRole('columnheader').map((el) => el.textContent)).toEqual([
      'Artifact',
      'Board',
      'Owner',
      'Build',
      'Actions',
    ]);
    expect(screen.getByText('Error')).toBeVisible();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Alex Morgan' } });
    expect(screen.getByText('API explorer')).toBeVisible();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'missing owner' } });
    expect(screen.getByText('No matching artifacts')).toBeVisible();
  });

  it('does not invent or resolve missing identities or boards', () => {
    setup([{ ...artifact, board_id: 'hidden-board' as Artifact['board_id'] }], new Map());
    expect(screen.getByText('Unavailable user')).toBeVisible();
    expect(screen.getByText('Unavailable board')).toBeVisible();
    expect(screen.queryByText('user-1')).not.toBeInTheDocument();
    expect(screen.queryByText('hidden-board')).not.toBeInTheDocument();
  });

  it('keeps provenance in the editor and avoids no-op updates', async () => {
    const { onUpdate } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Edit artifact' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Source branch: Not recorded/)).toBeVisible();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('requires confirmation before deleting', async () => {
    const { onDelete } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Delete artifact' }));
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete', exact: true }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith(artifact.artifact_id));
  });
});

const SCHEDULE = '019f0000-0000-7000-8000-00000000000a';

function makeArtifact(): Artifact {
  return {
    artifact_id: 'artifact-1',
    board_id: 'board-1',
    name: 'Release panel',
    template: 'react',
    build_status: 'success',
    archived: false,
    created_at: '2026-09-01T00:00:00.000Z',
  } as unknown as Artifact;
}

describe('ArtifactsTable edit modal', () => {
  it('loads and lists the artifact’s declared interaction bindings read-only', async () => {
    const get = vi.fn().mockResolvedValue({
      ...makeArtifact(),
      agor_runtime: {
        interactions: {
          actions: [
            {
              id: 'run-now',
              label: 'Run once',
              confirm: true,
              effect: { kind: 'schedule_run', schedule_id: SCHEDULE },
            },
          ],
        },
      },
    });
    const client = { service: () => ({ get }) } as unknown as AgorClient;
    const artifact = makeArtifact();

    render(
      <MemoryRouter>
        <ArtifactsTable
          client={client}
          artifactById={new Map([[artifact.artifact_id, artifact]])}
          branchById={new Map<string, Branch>()}
          boardById={new Map<string, Board>()}
        />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Edit artifact' }));

    expect(await screen.findByText('Run once')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('artifact-1');
    expect(screen.getByText('run-now')).toBeInTheDocument();
    expect(screen.getByText('Confirms first')).toBeInTheDocument();
  });
});
