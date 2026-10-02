import type { Board, Branch } from '@agor-live/client';
import { useMemo } from 'react';
import { useAgorStore } from '../../store/agorStore';
import { makeBranchSelector } from '../../store/selectors';
import { getBoardTeammate } from '../BoardTile';

/**
 * The board's primary teammate, whose photo a board tile falls back to when
 * the board has no gallery image. Subscribes to that one branch only.
 */
export function useBoardTeammate(
  board: Pick<Board, 'primary_teammate_id'> | undefined
): Branch | undefined {
  const teammateId = board?.primary_teammate_id;
  const branch = useAgorStore(useMemo(() => makeBranchSelector(teammateId), [teammateId]));
  return board && branch
    ? getBoardTeammate(board, new Map([[branch.branch_id, branch]]))
    : undefined;
}
