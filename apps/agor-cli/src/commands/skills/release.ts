import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';

export default class SkillsRelease extends BaseCommand {
  static override description =
    'Cut a skill set release in the configured skills provider namespaces (admin, outside any Agor session). Pins the current version of every skill assigned to the teammate; the first release of each teammate is cut this way.';

  static override examples = [
    '<%= config.bin %> skills release --all',
    '<%= config.bin %> skills release --teammate fritz',
    '<%= config.bin %> skills release --teammate fritz --namespace team-skills --expected-version 3',
  ];

  static override flags = {
    teammate: Flags.string({
      description: 'Teammate display name, folder key, or branch id',
      exclusive: ['all'],
    }),
    all: Flags.boolean({
      description: 'Release every teammate with skills',
      exclusive: ['teammate'],
    }),
    namespace: Flags.string({ description: 'Only this provider namespace (slug)' }),
    'expected-version': Flags.integer({
      description: 'Manifest version you last read (0 = no release may exist yet)',
      min: 0,
      exclusive: ['all'],
    }),
    json: Flags.boolean({ description: 'Output the result as JSON' }),
  };

  async run() {
    const { flags } = await this.parse(SkillsRelease);
    if (!flags.teammate === !flags.all) this.error('Pass exactly one of --teammate or --all.');
    const client = await this.connectToDaemon();
    let failed = false;
    try {
      const result = await client.service('skills/releases').create({
        ...(flags.teammate ? { teammate: flags.teammate } : { all: true }),
        ...(flags.namespace ? { namespace: flags.namespace } : {}),
        ...(flags['expected-version'] !== undefined
          ? { expectedVersion: flags['expected-version'] }
          : {}),
      });
      if (flags.json) {
        this.log(JSON.stringify(result, null, 2));
      } else {
        for (const row of result.results) {
          const release = row.release ? ` r${row.release}` : '';
          const reason = row.reason ? ` — ${row.reason}` : '';
          this.log(
            `${row.status.padEnd(9)} ${row.namespace}/${row.path ?? row.teammate}${release}${reason}`
          );
        }
        this.log(
          Object.entries(result.counts)
            .map(([status, count]) => `${count} ${status}`)
            .join(', ') || 'Nothing to release.'
        );
      }
      failed = result.failed;
    } catch (error) {
      this.error(error instanceof Error ? error.message : String(error));
    } finally {
      await this.cleanupClient(client);
    }
    if (failed) this.exit(1);
  }
}
