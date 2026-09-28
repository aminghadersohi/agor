import type { AgorClient, Artifact, Board, Branch } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ArtifactsTable } from './ArtifactsTable';

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

    fireEvent.click(screen.getByRole('button', { name: 'edit' }));

    expect(await screen.findByText('Run once')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('artifact-1');
    expect(screen.getByText('run-now')).toBeInTheDocument();
    expect(screen.getByText('Confirms first')).toBeInTheDocument();
  });
});
