import {
  acquireMaintenanceAdmission,
  createDatabase,
  getDatabaseUrl,
  inspectMaintenanceAdmission,
  releaseMaintenanceAdmission,
  sealMaintenanceAdmission,
} from '@agor/core/db';
import type { MaintenanceAdmissionStatus } from '@agor/core/types';
import { Command, Flags } from '@oclif/core';

/** External foreground operator only; no daemon job, tenant/MCP method or retry. */
export default class DbMaintenance extends Command {
  static description =
    'Hold, drain, inspect or release database-wide admission (PostgreSQL operator only)';
  static flags = {
    action: Flags.string({ required: true, options: ['acquire', 'inspect', 'seal', 'release'] }),
    install: Flags.boolean({
      default: false,
      description:
        'Explicitly install versioned DB triggers when acquiring, including on an older daemon',
    }),
    'ttl-seconds': Flags.integer({ default: 900, min: 60, max: 14400 }),
    database: Flags.string({
      description: 'Database identity returned by acquire (does not change the connection)',
    }),
    generation: Flags.string(),
    'expires-at': Flags.string(),
  };
  async run(): Promise<void> {
    const { flags } = await this.parse(DbMaintenance);
    try {
      if (flags.install && flags.action !== 'acquire')
        throw new Error('--install is only valid with acquire');
      const db = createDatabase({ url: getDatabaseUrl() });
      let result: unknown;
      if (flags.action === 'acquire')
        result = await acquireMaintenanceAdmission(db, {
          ttlMs: flags['ttl-seconds'] * 1000,
          install: flags.install,
        });
      else if (flags.action === 'inspect') result = await inspectMaintenanceAdmission(db);
      else {
        if (!flags.database || !flags.generation || !flags['expires-at'])
          throw new Error('Exact --database, --generation and --expires-at are required');
        const lease = {
          database: flags.database,
          generation: flags.generation,
          expiresAt: flags['expires-at'],
        };
        if (flags.action === 'seal') result = await sealMaintenanceAdmission(db, lease);
        else {
          await releaseMaintenanceAdmission(db, lease);
          result = { released: true };
        }
      }
      this.log(JSON.stringify(result));
      if (flags.action === 'seal' && !(result as MaintenanceAdmissionStatus).admissionDrained)
        process.exit(3);
      process.exit(0);
    } catch {
      // Driver errors can contain SQL/connection information. No raw error or stack.
      this.logToStderr(
        'Maintenance operation refused or failed. Inspect operator authority, installation, exact lease and database health before another action.'
      );
      process.exit(1);
    }
  }
}
