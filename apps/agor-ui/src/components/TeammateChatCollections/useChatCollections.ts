import type { ChatCollection, ChatCollectionPreferences, Session, User } from '@agor-live/client';
import { useMemo } from 'react';
import {
  type AgorState,
  agorStore,
  shallow,
  useAgorStore,
  useStoreWithEqualityFn,
} from '../../store/agorStore';
import { readTeammateChatPreferences } from './preferences';

/**
 * The caller's chat collections. The store copy of the user wins because it follows
 * realtime patches; the shell's auth snapshot covers callers the store doesn't list.
 */
export function useChatCollections(
  currentUser: Pick<User, 'user_id' | 'preferences'> | null | undefined
): ChatCollectionPreferences {
  const userId = currentUser?.user_id;
  const storedPreferences = useAgorStore((s) =>
    userId ? s.userById.get(userId)?.preferences : undefined
  );
  const preferences = storedPreferences ?? currentUser?.preferences;
  return useMemo(() => readTeammateChatPreferences(preferences), [preferences]);
}

export interface PinnedCollection {
  collection: ChatCollection;
  /** Live, unarchived sessions on unarchived branches, most recently active first. */
  sessions: Session[];
}

const NO_SESSIONS: (Session | null)[] = [];

/**
 * Every pinned id resolved to its live session, in collection order, or null when it is
 * gone, archived, or on an archived branch. Flat, so a shallow compare skips patches to
 * sessions nobody pinned.
 */
const makePinnedSessionsSelector = (collections: ChatCollection[]) => (s: AgorState) =>
  collections.flatMap((collection) =>
    collection.session_ids.map((sessionId) => {
      const session = s.sessionById.get(sessionId);
      if (!session || session.archived) return null;
      const branch = s.branchById.get(session.branch_id);
      return branch && !branch.archived ? session : null;
    })
  );

const byRecency = (a: Session, b: Session) =>
  (Date.parse(b.last_updated) || 0) - (Date.parse(a.last_updated) || 0);

/** Each collection with the sessions it can still open. */
export function usePinnedCollections(collections: ChatCollection[]): PinnedCollection[] {
  const pinned = useStoreWithEqualityFn(
    agorStore,
    useMemo(
      () => (collections.length ? makePinnedSessionsSelector(collections) : () => NO_SESSIONS),
      [collections]
    ),
    shallow
  );
  return useMemo(() => {
    let offset = 0;
    return collections.map((collection) => {
      const sessions = pinned
        .slice(offset, offset + collection.session_ids.length)
        .filter((session): session is Session => !!session)
        .sort(byRecency);
      offset += collection.session_ids.length;
      return { collection, sessions };
    });
  }, [collections, pinned]);
}
