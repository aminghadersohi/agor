import type { Board, Branch } from '@agor-live/client';
import { getTeammateConfig } from '@agor-live/client';
import { AppstoreOutlined } from '@ant-design/icons';
import { theme } from 'antd';
import type { CSSProperties } from 'react';
import { useCyclingProfileImageUrl } from '../ProfileImage/useCyclingProfileImage';

/** The neutral board glyph — shared so BoardTile, BoardPill, and dropdown
 * fallbacks all render the same icon and can't drift apart. */
export const NeutralBoardIcon = AppstoreOutlined;

/**
 * Resolve a board's own icon first. A primary teammate's emoji remains a
 * compatibility fallback for boards that do not have an icon of their own.
 * Auto-created teammate boards initialize `board.icon` from the teammate, but
 * the two identities may intentionally diverge afterward.
 */
export function getBoardEmoji(
  board: Pick<Board, 'icon' | 'primary_teammate_id'>,
  branchById?: Map<string, Branch> | null
): string | undefined {
  if (board.icon) return board.icon;
  const teammateId = board.primary_teammate_id;
  if (!teammateId || !branchById) return undefined;
  const branch = branchById.get(teammateId);
  return branch ? getTeammateConfig(branch)?.emoji || undefined : undefined;
}

export interface BoardTileProps {
  /** Pre-resolved board emoji (see {@link getBoardEmoji}). */
  emoji?: string;
  /** Board metadata used to render its primary gallery image when configured. */
  board?: Pick<Board, 'board_id' | 'profile_image_id'>;
  size?: number;
  style?: CSSProperties;
}

/**
 * Renders a board's face on a rounded square. The square shape is deliberate:
 * it keeps boards visually distinct from the circular user avatars so a board
 * is never mistaken for a person.
 */
export const BoardTile: React.FC<BoardTileProps> = ({ board, emoji, size = 36, style }) => {
  const { token } = theme.useToken();
  const imageUrl = useCyclingProfileImageUrl(
    board ? { type: 'board', id: board.board_id } : undefined,
    board?.profile_image_id,
    size > 96 ? 'large' : 'small',
    Boolean(board)
  );
  return (
    <div
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: token.borderRadiusLG,
        background: token.colorFillTertiary,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: Math.round(size * 0.56),
        lineHeight: 1,
        flexShrink: 0,
        ...style,
      }}
    >
      {imageUrl ? (
        <img
          src={imageUrl}
          alt=""
          style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'inherit' }}
        />
      ) : emoji ? (
        emoji
      ) : (
        <NeutralBoardIcon
          style={{ fontSize: Math.round(size * 0.5), color: token.colorTextSecondary }}
        />
      )}
    </div>
  );
};

export interface BoardSelectOption {
  value: string;
  label: React.ReactNode;
  /** Plain board name — searchable Selects filter against this, not the node. */
  name: string;
}

/**
 * Options for an AntD board `Select` where every board wears its face — the
 * board emoji, primary-teammate fallback, or neutral {@link BoardTile} — so an
 * assistant-less board never shows as a bare name. Pair with
 * `filterOption={boardSelectFilter}` to keep text search working against `name`.
 */
export function boardSelectOptions(
  boards: Board[],
  branchById?: Map<string, Branch> | null
): BoardSelectOption[] {
  return boards
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((board) => ({
      value: board.board_id,
      label: (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <BoardTile board={board} emoji={getBoardEmoji(board, branchById)} size={18} />
          {board.name}
        </span>
      ),
      name: board.name,
    }));
}

/** `filterOption` for a searchable board Select built from {@link boardSelectOptions}. */
export function boardSelectFilter(input: string, option?: BoardSelectOption): boolean {
  return (option?.name ?? '').toLowerCase().includes(input.toLowerCase());
}
