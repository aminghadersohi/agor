/** Operator-owned, database-wide Task admission fence; never tenant authority. */
export interface MaintenanceAdmissionLease {
  database: string;
  generation: string;
  expiresAt: string;
}

export interface MaintenanceAdmissionStatus {
  version: 1;
  database: string;
  phase: 'released' | 'draining' | 'sealed';
  generation: string | null;
  expiresAt: string | null;
  observedAt: string;
  expired: boolean;
  /** All tenants, all unknown/nonterminal statuses, no caller/coordinator exclusion. */
  unfinishedTasks: number;
  pendingRestartRecoveries: number;
  branchOperations: number;
  idleSince: string | null;
  /** DB admission only. Never an OS/process/quiesced-backup/deployment proof. */
  admissionDrained: boolean;
}
