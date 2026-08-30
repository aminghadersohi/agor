import { enqueueAfterTenantDatabaseCommit } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { SessionAttentionAcknowledgement, UserID } from '@agor/core/types';
import { emitHaNativeSocketEvent, tenantUserChannelName } from '../realtime/routing.js';

type RealtimeApplication = Application & {
  io?: {
    to(room: string): { emit(event: string, payload: unknown): unknown };
  };
};

/** Publish a caller-private acknowledgement to every device for exactly that user. */
export function emitSessionAttentionAcknowledged(
  app: RealtimeApplication,
  tenantId: string | undefined,
  userId: UserID,
  acknowledgement: SessionAttentionAcknowledgement
): void {
  if (!tenantId || !app.io) return;
  const emit = () =>
    emitHaNativeSocketEvent(
      app.io!.to(tenantUserChannelName(tenantId, userId)),
      'session-attention:acknowledged',
      acknowledgement
    );
  if (!enqueueAfterTenantDatabaseCommit(emit)) emit();
}
