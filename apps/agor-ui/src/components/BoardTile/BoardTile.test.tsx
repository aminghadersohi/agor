import type { Board, Branch } from '@agor-live/client';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCyclingProfileImageUrl } from '../ProfileImage/useCyclingProfileImage';
import {
  BoardTile,
  boardSelectFilter,
  boardSelectOptions,
  getBoardEmoji,
  getBoardTeammate,
} from './BoardTile';

vi.mock('../ProfileImage/useCyclingProfileImage', () => ({ useCyclingProfileImageUrl: vi.fn() }));

beforeEach(() => {
  vi.mocked(useCyclingProfileImageUrl).mockReset();
  vi.mocked(useCyclingProfileImageUrl).mockReturnValue(undefined);
});

const teammateBranch = (emoji: string, profileImageId?: string, branchId = 'b1'): Branch =>
  ({
    branch_id: branchId,
    custom_context: { teammate: { kind: 'teammate', emoji, profileImageId } },
  }) as unknown as Branch;

/** Mock the board gallery and teammate gallery hook calls independently. */
const mockImageBySubject = (urls: Partial<Record<'board' | 'teammate', string>>) => {
  vi.mocked(useCyclingProfileImageUrl).mockImplementation((subject) =>
    subject ? urls[subject.type as 'board' | 'teammate'] : undefined
  );
};

const board = (id: string, name: string, primary_teammate_id?: string): Board =>
  ({ board_id: id, name, primary_teammate_id }) as unknown as Board;

describe('getBoardEmoji', () => {
  it('prefers the board-owned icon over its primary teammate emoji', () => {
    const branchById = new Map<string, Branch>([['b1', teammateBranch('🦊')]]);
    expect(getBoardEmoji({ icon: '🧭', primary_teammate_id: 'b1' } as Board, branchById)).toBe(
      '🧭'
    );
  });

  it('resolves the primary teammate branch emoji', () => {
    const branchById = new Map<string, Branch>([['b1', teammateBranch('🦊')]]);
    expect(getBoardEmoji({ primary_teammate_id: 'b1' } as Board, branchById)).toBe('🦊');
  });

  it('returns undefined when the board has no primary teammate', () => {
    expect(getBoardEmoji({} as Board, new Map())).toBeUndefined();
  });

  it('returns undefined when the teammate branch is not loaded', () => {
    expect(getBoardEmoji({ primary_teammate_id: 'missing' } as Board, new Map())).toBeUndefined();
  });
});

describe('BoardTile', () => {
  it('renders the assistant emoji when one is provided', () => {
    render(<BoardTile emoji="🦊" />);
    expect(screen.getByText('🦊')).toBeInTheDocument();
  });

  it('falls back to a neutral glyph when there is no emoji', () => {
    const { container } = render(<BoardTile />);
    expect(container.querySelector('.anticon')).toBeInTheDocument();
  });

  it('renders the board primary image ahead of its emoji', () => {
    vi.mocked(useCyclingProfileImageUrl).mockReturnValue('blob:board-image');
    const { container } = render(
      <BoardTile board={{ board_id: 'board-1', profile_image_id: 'image-1' } as Board} emoji="🦊" />
    );

    expect(container.querySelector('img')).toHaveAttribute('src', 'blob:board-image');
    expect(screen.queryByText('🦊')).not.toBeInTheDocument();
    expect(useCyclingProfileImageUrl).toHaveBeenCalledWith(
      { type: 'board', id: 'board-1' },
      'image-1',
      'small',
      true
    );
  });

  it('does not read a gallery for a board without a primary image', () => {
    render(<BoardTile board={{ board_id: 'board-1' } as Board} emoji="🦊" />);

    expect(screen.getByText('🦊')).toBeInTheDocument();
    expect(useCyclingProfileImageUrl).toHaveBeenCalledWith(
      undefined,
      undefined,
      'small',
      false,
      undefined
    );
    // No gallery hook runs enabled (the 4th argument is its `enabled` flag).
    expect(vi.mocked(useCyclingProfileImageUrl).mock.calls.some((call) => call[3] === true)).toBe(
      false
    );
  });

  it('falls back to the primary teammate photo when the board has no image', () => {
    mockImageBySubject({ teammate: 'blob:teammate-image' });
    const { container } = render(
      <BoardTile
        board={{ board_id: 'board-1' } as Board}
        teammate={teammateBranch('🦊', 'tm-image')}
        emoji="🦊"
      />
    );

    expect(container.querySelector('img')).toHaveAttribute('src', 'blob:teammate-image');
    expect(screen.queryByText('🦊')).not.toBeInTheDocument();
    expect(useCyclingProfileImageUrl).toHaveBeenCalledWith(
      { type: 'teammate', id: 'b1' },
      'tm-image',
      'small',
      true,
      undefined
    );
  });

  it("restricts the teammate fallback to the teammate's active photo theme", () => {
    mockImageBySubject({ teammate: 'blob:teammate-image' });
    const branch = teammateBranch('🦊', 'tm-image');
    (branch.custom_context as { teammate: Record<string, unknown> }).teammate.activePhotoTheme =
      'Winter';
    render(<BoardTile board={{ board_id: 'board-1' } as Board} teammate={branch} />);

    expect(useCyclingProfileImageUrl).toHaveBeenCalledWith(
      { type: 'teammate', id: 'b1' },
      'tm-image',
      'small',
      true,
      'Winter'
    );
  });

  it('prefers the board image and skips the teammate gallery read', () => {
    mockImageBySubject({ board: 'blob:board-image', teammate: 'blob:teammate-image' });
    const { container } = render(
      <BoardTile
        board={{ board_id: 'board-1', profile_image_id: 'image-1' } as Board}
        teammate={teammateBranch('🦊', 'tm-image')}
      />
    );

    expect(container.querySelector('img')).toHaveAttribute('src', 'blob:board-image');
    expect(useCyclingProfileImageUrl).toHaveBeenCalledWith(
      undefined,
      undefined,
      'small',
      false,
      undefined
    );
    expect(
      vi.mocked(useCyclingProfileImageUrl).mock.calls.some((call) => call[0]?.type === 'teammate')
    ).toBe(false);
  });

  it('does not read a gallery for a teammate without a photo', () => {
    render(
      <BoardTile
        board={{ board_id: 'board-1' } as Board}
        teammate={teammateBranch('🦊')}
        emoji="🦊"
      />
    );

    expect(screen.getByText('🦊')).toBeInTheDocument();
    for (const call of vi.mocked(useCyclingProfileImageUrl).mock.calls) {
      expect(call.slice(0, 4)).toEqual([undefined, undefined, 'small', false]);
    }
  });
});

describe('getBoardTeammate', () => {
  it('resolves the loaded primary teammate branch', () => {
    const tm = teammateBranch('🦊');
    expect(getBoardTeammate({ primary_teammate_id: 'b1' } as Board, new Map([['b1', tm]]))).toBe(
      tm
    );
  });

  it('ignores missing or non-teammate branches', () => {
    const plain = { branch_id: 'b2', custom_context: {} } as unknown as Branch;
    expect(getBoardTeammate({ primary_teammate_id: 'b1' } as Board, new Map())).toBeUndefined();
    expect(
      getBoardTeammate({ primary_teammate_id: 'b2' } as Board, new Map([['b2', plain]]))
    ).toBeUndefined();
    expect(getBoardTeammate({} as Board, new Map([['b1', teammateBranch('🦊')]]))).toBeUndefined();
  });
});

describe('boardSelectOptions', () => {
  const branchById = new Map<string, Branch>([['b1', teammateBranch('🦊')]]);

  it('sorts by name and carries a plain-name field for filtering', () => {
    const opts = boardSelectOptions([board('2', 'Zebra'), board('1', 'Alpha')], branchById);
    expect(opts.map((o) => o.name)).toEqual(['Alpha', 'Zebra']);
    expect(opts.map((o) => o.value)).toEqual(['1', '2']);
  });

  it('passes each board so its primary image can render', () => {
    vi.mocked(useCyclingProfileImageUrl).mockReturnValue('blob:board-image');
    const [opt] = boardSelectOptions(
      [{ ...board('1', 'Alpha', 'b1'), profile_image_id: 'image-1' } as Board],
      branchById
    );
    const { container } = render(<>{opt.label}</>);
    expect(container.querySelector('img')).toHaveAttribute('src', 'blob:board-image');
  });

  it('renders the primary teammate photo for a board without its own image', () => {
    mockImageBySubject({ teammate: 'blob:teammate-image' });
    const [opt] = boardSelectOptions(
      [board('1', 'Alpha', 'b1')],
      new Map([['b1', teammateBranch('🦊', 'tm-image')]])
    );
    const { container } = render(<>{opt.label}</>);
    expect(container.querySelector('img')).toHaveAttribute('src', 'blob:teammate-image');
  });

  it('renders the assistant emoji for a board that has one', () => {
    const [opt] = boardSelectOptions([board('1', 'Alpha', 'b1')], branchById);
    render(<>{opt.label}</>);
    expect(screen.getByText('🦊')).toBeInTheDocument();
    expect(screen.getByText('Alpha')).toBeInTheDocument();
  });

  it('renders the board-owned icon when it differs from the primary teammate', () => {
    const [opt] = boardSelectOptions(
      [{ ...board('1', 'Alpha', 'b1'), icon: '🧭' } as Board],
      branchById
    );
    render(<>{opt.label}</>);
    expect(screen.getByText('🧭')).toBeInTheDocument();
    expect(screen.queryByText('🦊')).not.toBeInTheDocument();
  });

  it('renders the neutral tile (never a bare name) for an assistant-less board', () => {
    const [opt] = boardSelectOptions([board('1', 'Alpha')], branchById);
    const { container } = render(<>{opt.label}</>);
    expect(container.querySelector('.anticon')).toBeInTheDocument();
    expect(screen.getByText('Alpha')).toBeInTheDocument();
  });
});

describe('boardSelectFilter', () => {
  const opt = { value: '1', label: null, name: 'Design Board' };

  it('matches on the board name, case-insensitively', () => {
    expect(boardSelectFilter('design', opt)).toBe(true);
    expect(boardSelectFilter('BOARD', opt)).toBe(true);
    expect(boardSelectFilter('xyz', opt)).toBe(false);
  });
});
