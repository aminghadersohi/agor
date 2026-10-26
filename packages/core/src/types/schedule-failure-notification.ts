import type { GatewayChannelID } from './gateway';
import type { BranchID, SessionID, TaskID, UserID } from './id';
import type { ScheduleID } from './schedule';

/** Content-free durable intent. Original identities survive Session/Task retention. */
export interface ScheduleFailureNotification {
  task_id: TaskID;
  session_id: SessionID;
  schedule_id: ScheduleID;
  branch_id: BranchID;
  created_by: UserID;
  scheduled_run_at: number;
  status: 'pending' | 'sending' | 'delivered' | 'uncertain';
  next_attempt_at: string;
  created_at: string;
  updated_at: string;
  gateway_channel_id: GatewayChannelID | null;
  target: string | null;
  platform_message_id: string | null;
  last_error_code: string | null;
}

/** Admin-owned Slack gateway config key; never a secret or an implicit target. */
export const SCHEDULE_FAILURE_ALERT_TARGET = 'schedule_failure_alert_target' as const;

export const SCHEDULE_FAILURE_ALERT_PURPOSE = 'schedule_failure' as const;
