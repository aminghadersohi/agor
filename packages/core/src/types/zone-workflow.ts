import type { CardID } from './card';
import type { BoardID, BranchID, UUID } from './id';

/** Action performed after an explicit workflow advance reaches its target zone. */
export type ZoneWorkflowTransitionBehavior = 'guidance_only' | 'target_zone_prompt';

/** Persistent directed edge between two zones on one board. */
export interface ZoneWorkflowTransition {
  transition_id: UUID;
  board_id: BoardID;
  source_zone_id: string;
  target_zone_id: string;
  label: string;
  reason?: string;
  enabled: boolean;
  behavior: ZoneWorkflowTransitionBehavior;
  created_by: UUID;
  created_at: string;
  updated_at: string;
}

export interface ZoneWorkflowTransitionCreate {
  board_id: BoardID;
  source_zone_id: string;
  target_zone_id: string;
  label: string;
  reason?: string;
  enabled?: boolean;
  behavior?: ZoneWorkflowTransitionBehavior;
}

export interface ZoneWorkflowTransitionPatch {
  label?: string;
  reason?: string | null;
  enabled?: boolean;
  behavior?: ZoneWorkflowTransitionBehavior;
}

export type ZoneWorkflowEntityRef =
  | { entity_type: 'branch'; entity_id: BranchID }
  | { entity_type: 'card'; entity_id: CardID };

export interface ZoneWorkflowAdvanceRequest {
  transition_id: UUID;
  /** Caller-generated UUID. Reusing it returns the original audit record without moving again. */
  idempotency_key: UUID;
  entities: ZoneWorkflowEntityRef[];
}

export type ZoneWorkflowAdvancedEntity = ZoneWorkflowEntityRef & { board_object_id: UUID };

export type ZoneWorkflowPromptOutcome =
  | 'not_requested'
  | 'not_applicable'
  | 'triggered'
  | 'target_has_no_trigger'
  | 'target_requires_picker'
  | 'failed';

/** Durable audit row for one atomic, idempotent advance request. */
export interface ZoneWorkflowAdvance {
  advance_id: UUID;
  transition_id: UUID;
  board_id: BoardID;
  idempotency_key: UUID;
  source_zone_id: string;
  target_zone_id: string;
  transition_label: string;
  transition_reason?: string;
  behavior: ZoneWorkflowTransitionBehavior;
  entities: ZoneWorkflowAdvancedEntity[];
  requested_by: UUID;
  requested_at: string;
  prompt_outcome: ZoneWorkflowPromptOutcome;
  prompt_error?: string;
  replayed?: boolean;
}
