import type { Board, Branch, Repo } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { BoardTeammatePanel } from './BoardTeammatePanel';

vi.mock('../BranchCard', () => ({
  BranchSessionSections: ({ mode }: { mode?: string }) => (
    <div data-testid="teammate-session-sections">mode:{String(mode)}</div>
  ),
}));

vi.mock('../BranchHeaderPill', () => ({
  BranchHeaderPill: ({ truncateToFit }: { truncateToFit?: boolean }) => (
    <div data-testid="branch-header-pill" data-truncate-to-fit={String(truncateToFit)} />
  ),
}));

vi.mock('../ProfileImage', () => ({
  useProfileImageGallery: () => [],
  useProfileImageUrl: () => undefined,
  useProfileIdentityModel: () => ({
    modelUrl: undefined,
    identityModel: undefined,
    generating: false,
    error: null,
    generate: vi.fn(),
  }),
  TeammateBoardPortrait: ({
    primarySize,
    alternativeSize,
  }: {
    primarySize: number;
    alternativeSize: number;
  }) => (
    <div
      data-testid="teammate-portrait"
      data-primary-size={primarySize}
      data-alternative-size={alternativeSize}
    />
  ),
}));

const board = { board_id: 'board-1', name: 'Board', slug: 'board' } as Board;
const primaryTeammateBranch = {
  branch_id: 'branch-1',
  repo_id: 'repo-1',
  name: 'teammate',
  filesystem_status: 'ready',
} as Branch;
const primaryTeammateRepo = { repo_id: 'repo-1', slug: 'preset-io/agor' } as Repo;

describe('BoardTeammatePanel teammate tab', () => {
  beforeEach(() => {
    localStorage.clear();
    agorStore.setState({ ...EMPTY_MAPS });
  });

  it('renders the teammate Sessions section as a transient panel surface', () => {
    render(
      <AntApp>
        <BoardTeammatePanel
          board={board}
          activeTab="teammate"
          onTabChange={vi.fn()}
          primaryTeammateBranch={primaryTeammateBranch}
          primaryTeammateRepo={primaryTeammateRepo}
          primaryTeammateInaccessible={false}
          onSessionClick={vi.fn()}
          client={null}
        />
      </AntApp>
    );

    expect(screen.getByTestId('teammate-session-sections')).toHaveTextContent('mode:panel');
    expect(screen.getByTestId('branch-header-pill')).toHaveAttribute(
      'data-truncate-to-fit',
      'true'
    );
  });

  it('cycles portrait sizes from one compact control and remembers the choice', () => {
    const { unmount } = render(
      <AntApp>
        <BoardTeammatePanel
          board={board}
          activeTab="teammate"
          onTabChange={vi.fn()}
          primaryTeammateBranch={primaryTeammateBranch}
          primaryTeammateRepo={primaryTeammateRepo}
          primaryTeammateInaccessible={false}
          onSessionClick={vi.fn()}
          client={null}
        />
      </AntApp>
    );

    expect(screen.getByTestId('teammate-portrait')).toHaveAttribute('data-primary-size', '300');
    const sizeControl = screen.getByRole('button', {
      name: 'Portrait size: large. Click for small.',
    });
    fireEvent.click(sizeControl);
    expect(screen.getByTestId('teammate-portrait')).toHaveAttribute('data-primary-size', '112');
    expect(sizeControl).toHaveAccessibleName('Portrait size: small. Click for medium.');
    fireEvent.click(sizeControl);
    expect(screen.getByTestId('teammate-portrait')).toHaveAttribute('data-primary-size', '200');
    expect(sizeControl).toHaveAccessibleName('Portrait size: medium. Click for large.');
    unmount();

    render(
      <AntApp>
        <BoardTeammatePanel
          board={board}
          activeTab="teammate"
          onTabChange={vi.fn()}
          primaryTeammateBranch={primaryTeammateBranch}
          primaryTeammateRepo={primaryTeammateRepo}
          primaryTeammateInaccessible={false}
          onSessionClick={vi.fn()}
          client={null}
        />
      </AntApp>
    );
    expect(screen.getByTestId('teammate-portrait')).toHaveAttribute('data-primary-size', '200');
    expect(screen.getByRole('button', { name: /Portrait size: medium/ })).toBeInTheDocument();
  });
});
