import type { Board, Branch } from '@agor-live/client';
import { getTeammateConfig, isTeammate } from '@agor-live/client';
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

/**
 * The primary teammate branch whose photo a board without its own gallery
 * image falls back to. Undefined when the board has no primary teammate or its
 * branch is not loaded.
 */
export function getBoardTeammate(
  board: Pick<Board, 'primary_teammate_id'>,
  branchById?: Map<string, Branch> | null
): Branch | undefined {
  const teammateId = board.primary_teammate_id;
  if (!teammateId || !branchById) return undefined;
  const branch = branchById.get(teammateId);
  return branch && isTeammate(branch) ? branch : undefined;
}

export interface BoardTileProps {
  /** Pre-resolved board emoji (see {@link getBoardEmoji}). */
  emoji?: string;
  /** Board whose primary gallery image, when set, is shown ahead of the emoji. */
  board?: Pick<Board, 'board_id' | 'profile_image_id'>;
  /**
   * Primary teammate (see {@link getBoardTeammate}) whose photo is shown when
   * the board has no gallery image of its own, ahead of the emoji.
   */
  teammate?: Branch | null;
  size?: number;
  style?: CSSProperties;
}

/**
 * Renders a board's face on a rounded square. The square shape is deliberate:
 * it keeps boards visually distinct from the circular user avatars so a board
 * is never mistaken for a person.
 */
export const BoardTile: React.FC<BoardTileProps> = ({
  board,
  teammate,
  emoji,
  size = 36,
  style,
}) => {
  const { token } = theme.useToken();
  const variant = size > 96 ? 'large' : 'small';
  // Only subjects with a projected primary have a gallery, so image-less boards
  // and teammates never trigger a gallery read — lists render one tile per board.
  const hasBoardGallery = Boolean(board?.profile_image_id);
  const boardImageUrl = useCyclingProfileImageUrl(
    board && hasBoardGallery ? { type: 'board', id: board.board_id } : undefined,
    board?.profile_image_id,
    variant,
    hasBoardGallery
  );
  // The teammate gallery is only read when the board has none of its own.
  const teammateImageId =
    teammate && isTeammate(teammate) ? getTeammateConfig(teammate)?.profileImageId : undefined;
  const hasTeammateGallery = !hasBoardGallery && Boolean(teammate && teammateImageId);
  const teammateImageUrl = useCyclingProfileImageUrl(
    teammate && hasTeammateGallery ? { type: 'teammate', id: teammate.branch_id } : undefined,
    hasTeammateGallery ? teammateImageId : undefined,
    variant,
    hasTeammateGallery
  );
  const imageUrl = boardImageUrl ?? teammateImageUrl;
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
 * board image, primary-teammate photo or emoji, or neutral {@link BoardTile} — so an
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
          <BoardTile
            board={board}
            teammate={getBoardTeammate(board, branchById)}
            emoji={getBoardEmoji(board, branchById)}
            size={18}
          />
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
