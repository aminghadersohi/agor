import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('power admission safety wiring', () => {
  it('keeps the sole Task dispatch claim behind the controller fence', async () => {
    const source = await readFile(new URL('../register-routes.ts', import.meta.url), 'utf8');
    expect(source.match(/claimDispatchAndProjectSession\(/g)).toHaveLength(1);
    const fenceStart = source.indexOf('powerPolicyController.withDispatchPermit(');
    const claim = source.indexOf('claimDispatchAndProjectSession(', fenceStart);
    const heldOutcome = source.indexOf("fencedClaim.decision.outcome === 'held'", claim);
    expect(fenceStart).toBeGreaterThan(0);
    expect(claim).toBeGreaterThan(fenceStart);
    expect(heldOutcome).toBeGreaterThan(claim);
    expect(source.slice(fenceStart, heldOutcome)).toContain('runWithTenantDatabaseTransaction');
  });

  it('turns a power-held explicit manual Task into durable queued work', async () => {
    const source = await readFile(new URL('../register-routes.ts', import.meta.url), 'utf8');
    const runStart = source.indexOf("'/tasks/:id/run'");
    const runEnd = source.indexOf("'/sessions/:id/spawn-prompt'", runStart);
    const route = source.slice(runStart, runEnd);
    const held = route.indexOf('result.power_hold?.held');
    const queue = route.indexOf('taskRepo.createPending({', held);
    const legacyConflict = route.indexOf('result.status === TaskStatus.CREATED', queue);
    expect(held).toBeGreaterThan(0);
    expect(queue).toBeGreaterThan(held);
    expect(route.slice(queue, legacyConflict)).toContain('status: TaskStatus.QUEUED');
    expect(legacyConflict).toBeGreaterThan(queue);
  });

  it('does not introduce process suspension or host shutdown ownership', async () => {
    const files = await Promise.all(
      ['controller.ts', 'state-machine.ts', 'macos-provider.ts'].map((name) =>
        readFile(new URL(name, import.meta.url), 'utf8')
      )
    );
    const source = files.join('\n');
    expect(source).not.toMatch(/SIGSTOP|SIGCONT|shutdown\s+-h|halt\b/);
  });

  it('starts observation before admission workers and stops it at the drain fence', async () => {
    const startup = await readFile(new URL('../startup.ts', import.meta.url), 'utf8');
    const start = startup.indexOf('powerPolicyController.start()');
    expect(start).toBeGreaterThan(0);
    expect(start).toBeLessThan(startup.indexOf('sessionQueueWorker.start()'));
    expect(start).toBeLessThan(startup.indexOf('schedulerService.start()'));
    const beginDrain = startup.indexOf('beginExecutorResponseDrain()');
    const stop = startup.indexOf('powerPolicyController.stop()', beginDrain);
    expect(stop).toBeGreaterThan(beginDrain);
    expect(stop).toBeLessThan(startup.indexOf('sessionQueueWorker?.stop()', stop));
  });
});
