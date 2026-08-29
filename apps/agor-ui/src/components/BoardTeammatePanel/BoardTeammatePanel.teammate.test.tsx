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
  TeammateBoardPortrait: ({
    primarySize,
    alternativeSize,
    maxAlternatives,
    fill,
  }: {
    primarySize: number;
    alternativeSize: number;
    maxAlternatives?: number;
    fill?: boolean;
  }) => (
    <div
      data-testid="teammate-portrait"
      data-primary-size={primarySize}
      data-alternative-size={alternativeSize}
      data-max-alternatives={String(maxAlternatives)}
      // Mirrors the real component's default, so an omitted prop reads as off
      // rather than as the string "undefined".
      data-fill={String(Boolean(fill))}
    />
  ),
}));

vi.mock('../TeammateStage', () => ({ TeammateStageModal: () => null }));

const board = { board_id: 'board-1', name: 'Board', slug: 'board' } as Board;
const primaryTeammateBranch = {
  branch_id: 'branch-1',
  repo_id: 'repo-1',
  name: 'teammate',
  filesystem_status: 'ready',
} as Branch;
const primaryTeammateRepo = { repo_id: 'repo-1', slug: 'preset-io/agor' } as Repo;

const PORTRAIT_SIZE_STORAGE_KEY = 'agor:teammate-panel-portrait-size';

function renderPanel() {
  return render(
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
}

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
    const { unmount } = renderPanel();

    expect(screen.getByTestId('teammate-portrait')).toHaveAttribute('data-primary-size', '300');
    const sizeControl = screen.getByRole('button', {
      name: 'Portrait size: large. Click for panel width.',
    });
    fireEvent.click(sizeControl);
    expect(screen.getByTestId('teammate-portrait')).toHaveAttribute('data-fill', 'true');
    expect(sizeControl).toHaveAccessibleName('Portrait size: panel width. Click for tiny.');
    fireEvent.click(sizeControl);
    expect(screen.getByTestId('teammate-portrait')).toHaveAttribute('data-primary-size', '36');
    expect(sizeControl).toHaveAccessibleName('Portrait size: tiny. Click for small.');
    fireEvent.click(sizeControl);
    expect(screen.getByTestId('teammate-portrait')).toHaveAttribute('data-primary-size', '112');
    expect(sizeControl).toHaveAccessibleName('Portrait size: small. Click for medium.');
    fireEvent.click(sizeControl);
    expect(screen.getByTestId('teammate-portrait')).toHaveAttribute('data-primary-size', '200');
    expect(sizeControl).toHaveAccessibleName('Portrait size: medium. Click for large.');
    unmount();

    renderPanel();
    expect(screen.getByTestId('teammate-portrait')).toHaveAttribute('data-primary-size', '200');
    expect(screen.getByRole('button', { name: /Portrait size: medium/ })).toBeInTheDocument();
  });

  it('restores the pre-hero 36px portrait at the smallest step, without an alternates strip', () => {
    localStorage.setItem(PORTRAIT_SIZE_STORAGE_KEY, 'tiny');
    renderPanel();

    const portrait = screen.getByTestId('teammate-portrait');
    expect(portrait).toHaveAttribute('data-primary-size', '36');
    expect(portrait).toHaveAttribute('data-max-alternatives', '0');
    expect(portrait).toHaveAttribute('data-fill', 'false');
  });

  it('caps the panel-width step at the largest stored variant and lets it fill', () => {
    localStorage.setItem(PORTRAIT_SIZE_STORAGE_KEY, 'fill');
    renderPanel();

    const portrait = screen.getByTestId('teammate-portrait');
    expect(portrait).toHaveAttribute('data-fill', 'true');
    expect(portrait).toHaveAttribute('data-primary-size', '768');
  });

  // The three names this control shipped with are still the same three names,
  // so a value written by the previous build must survive the migration.
  it.each([
    ['small', '112'],
    ['medium', '200'],
    ['large', '300'],
  ])('keeps honouring the pre-existing stored size %s', (stored, expectedPrimary) => {
    localStorage.setItem(PORTRAIT_SIZE_STORAGE_KEY, stored);
    renderPanel();

    expect(screen.getByTestId('teammate-portrait')).toHaveAttribute(
      'data-primary-size',
      expectedPrimary
    );
    expect(
      screen.getByRole('button', { name: new RegExp(`^Portrait size: ${stored}\\.`) })
    ).toBeInTheDocument();
  });

  it.each(['huge', '', 'toString', '__proto__'])(
    'falls back to the default size for the unrenderable stored value %j',
    (stored) => {
      localStorage.setItem(PORTRAIT_SIZE_STORAGE_KEY, stored);
      renderPanel();

      expect(screen.getByTestId('teammate-portrait')).toHaveAttribute('data-primary-size', '300');
      expect(screen.getByRole('button', { name: /^Portrait size: large\./ })).toBeInTheDocument();
    }
  );
});
