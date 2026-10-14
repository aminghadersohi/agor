import type { Board, Branch, Repo } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { BoardTeammatePanel } from './BoardTeammatePanel';

// Profile galleries and portraits load from the daemon; keep these tests hermetic.
vi.mock('../ProfileImage/profileImageApi', () => ({
  listProfileImages: vi.fn(async () => ({ images: [], max_images: 100 })),
  fetchProfileImageBlob: vi.fn(),
  uploadProfileImage: vi.fn(),
  patchProfileImage: vi.fn(),
  deleteProfileImage: vi.fn(),
  reorderProfileImages: vi.fn(),
  bulkDeleteProfileImages: vi.fn(),
  bulkSetProfileImageTheme: vi.fn(),
  setTeammateActiveTheme: vi.fn(),
}));

vi.mock('../BranchCard', () => ({
  BranchSessionSections: () => <div data-testid="teammate-session-sections" />,
}));

vi.mock('../BranchHeaderPill', () => ({
  BranchHeaderPill: () => <div data-testid="branch-header-pill" />,
}));

// The panel itself is covered by TeammateSkillsPanel.test.tsx.
vi.mock('../TeammateSkillsPanel', () => ({
  TeammateSkillsPanel: ({
    branch,
    onOpenFiles,
    onClose,
  }: {
    branch: Branch;
    onOpenFiles?: () => void;
    onClose?: () => void;
  }) => (
    <div data-testid="skills-panel">
      skills:{branch.branch_id}
      <button type="button" onClick={onOpenFiles}>
        files
      </button>
      <button type="button" onClick={onClose}>
        close
      </button>
    </div>
  ),
}));

const board = { board_id: 'board-1', name: 'Board', slug: 'board' } as Board;
const teammate = {
  branch_id: 'branch-1',
  repo_id: 'repo-1',
  name: 'teammate',
  filesystem_status: 'ready',
} as Branch;
const repo = { repo_id: 'repo-1', slug: 'example/repo' } as Repo;

function renderPanel(onOpenSettings = vi.fn()) {
  render(
    <AntApp>
      <BoardTeammatePanel
        board={board}
        activeTab="teammate"
        onTabChange={vi.fn()}
        primaryTeammateBranch={teammate}
        primaryTeammateRepo={repo}
        primaryTeammateInaccessible={false}
        onSessionClick={vi.fn()}
        onOpenSettings={onOpenSettings}
        client={null}
      />
    </AntApp>
  );
  return { onOpenSettings };
}

describe('BoardTeammatePanel skills', () => {
  beforeEach(() => {
    agorStore.setState({ ...EMPTY_MAPS });
  });

  it('keeps the tab bar unchanged', () => {
    renderPanel();
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Teammate',
      'Sessions',
      'Branches',
      'Comments',
    ]);
  });

  it("opens the primary teammate's skills in a drawer, only on demand", async () => {
    renderPanel();
    expect(screen.queryByTestId('skills-panel')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open skills' }));

    expect(await screen.findByTestId('skills-panel')).toHaveTextContent('skills:branch-1');
  });

  it('closes the drawer before opening the Files tab', async () => {
    const { onOpenSettings } = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Open skills' }));
    fireEvent.click(await screen.findByRole('button', { name: 'files' }));
    expect(onOpenSettings).toHaveBeenCalledWith('branch-1', 'files');
  });
});
