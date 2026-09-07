import type { Session, SessionAttentionAcknowledgement, UserID } from '@agor/core/types';
import { inArray, sql } from 'drizzle-orm';
import type { Database } from '../client';
import { insert, isPostgresDatabase, select } from '../database-wrapper';
import { type SessionAttentionStateRow, sessionAttentionStates } from '../schema';
import { getCurrentTenantId } from '../tenant-context';
import {
  attachHiddenTenant,
  currentTenantInsert,
  getHiddenTenantId,
  RepositoryError,
} from './base';

type PostgresSessionAttentionStates = typeof import('../schema.postgres').sessionAttentionStates;

/** Persistence for caller-private acknowledgement of shared session attention. */
export class SessionAttentionStateRepository {
  constructor(private readonly db: Database) {}

  async enrichForViewer(sessions: Session[], userId: UserID): Promise<Session[]> {
    if (sessions.length === 0) return sessions;

    const ids = [...new Set(sessions.map((session) => session.session_id))];
    const rows = (await select(this.db)
      .from(sessionAttentionStates)
      .where(
        sql`${sessionAttentionStates.user_id} = ${userId} AND ${inArray(
          sessionAttentionStates.session_id,
          ids
        )}`
      )
      .all()) as SessionAttentionStateRow[];
    const seenBySession = new Map<string, number>(
      rows.map((row) => [row.session_id, row.seen_attention_generation] as const)
    );

    return sessions.map((session) =>
      attachHiddenTenant(
        {
          ...session,
          viewer_seen_attention_generation: seenBySession.get(session.session_id) ?? 0,
        },
        session
      )
    );
  }

  async acknowledge(
    session: Pick<Session, 'session_id' | 'attention_generation'>,
    userId: UserID
  ): Promise<SessionAttentionAcknowledgement> {
    const sessionTenantId = getHiddenTenantId(session);
    const currentTenantId = getCurrentTenantId();
    if (sessionTenantId && currentTenantId && sessionTenantId !== currentTenantId) {
      throw new RepositoryError('Cannot acknowledge session attention across tenants');
    }

    const now = new Date();
    const generation = session.attention_generation;
    const postgres = isPostgresDatabase(this.db);
    const values = {
      ...(postgres ? currentTenantInsert() : {}),
      user_id: userId,
      session_id: session.session_id,
      seen_attention_generation: generation,
      seen_at: now,
    };
    const postgresTable = sessionAttentionStates as PostgresSessionAttentionStates;
    const target = postgres
      ? [postgresTable.tenant_id, sessionAttentionStates.user_id, sessionAttentionStates.session_id]
      : [sessionAttentionStates.user_id, sessionAttentionStates.session_id];

    await insert(this.db, sessionAttentionStates)
      .values(values)
      .onConflictDoUpdate({
        target,
        set: {
          seen_attention_generation: sql`CASE
            WHEN ${sessionAttentionStates.seen_attention_generation} > ${generation}
            THEN ${sessionAttentionStates.seen_attention_generation}
            ELSE ${generation}
          END`,
          seen_at: now,
        },
      })
      .run();

    const persisted = await select(this.db)
      .from(sessionAttentionStates)
      .where(
        sql`${sessionAttentionStates.user_id} = ${userId}
          AND ${sessionAttentionStates.session_id} = ${session.session_id}`
      )
      .one();
    if (!persisted) {
      throw new RepositoryError('Session attention acknowledgement was not persisted');
    }

    return {
      session_id: session.session_id,
      attention_generation: generation,
      seen_attention_generation: persisted.seen_attention_generation,
    };
  }
}
