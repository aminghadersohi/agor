import { readFileSync } from 'node:fs';
import {
  AgenticToolPresetRepository,
  decryptApiKey,
  eq,
  GatewayChannelRepository,
  gatewayChannels,
  select,
} from '@agor/core/db';
import type { GatewayChannel } from '@agor/core/types';
import { GATEWAY_REDACTED_SENTINEL } from '@agor/core/types';
import { beforeAll, describe, expect, it } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { GatewayChannelsService } from '../services/gateway-channels';
import { channelData } from '../services/gateway-channels.test-support';
import { resolveGatewayAgenticConfigPatch } from './gateway-channel-agentic-patch';

beforeAll(() => {
  process.env.AGOR_MASTER_SECRET ||= 'gateway-channel-agentic-patch-test-secret';
});

const envVar = (value: string) => ({ key: 'TOKEN', value, forceOverride: false });

describe('resolveGatewayAgenticConfigPatch (unit)', () => {
  const stored = { agent: 'claude-code', envVars: [envVar('stored-secret')] } as NonNullable<
    GatewayChannel['agentic_config']
  >;

  it('leaves a patch without agentic_config untouched and never reads the channel', async () => {
    const data: Record<string, unknown> = { config: { x: 1 }, enabled: true };
    await resolveGatewayAgenticConfigPatch(data, async () => {
      throw new Error('must not load');
    });
    expect(data).toEqual({ config: { x: 1 }, enabled: true });
    expect('agentic_config' in data).toBe(false);
  });

  it('keeps an explicit null clear as null', async () => {
    const data: Record<string, unknown> = { agentic_config: null };
    await resolveGatewayAgenticConfigPatch(data, async () => stored);
    expect(data).toEqual({ agentic_config: null });
  });

  it('preserves stored env vars when envVars is omitted, deletes on [], substitutes sentinels', async () => {
    const omitted: Record<string, unknown> = { agentic_config: { agent: 'claude-code' } };
    await resolveGatewayAgenticConfigPatch(omitted, async () => stored);
    expect(omitted.agentic_config).toEqual({ agent: 'claude-code', envVars: stored.envVars });

    const cleared: Record<string, unknown> = {
      agentic_config: { agent: 'claude-code', envVars: [] },
    };
    await resolveGatewayAgenticConfigPatch(cleared, async () => stored);
    expect((cleared.agentic_config as { envVars: unknown[] }).envVars).toEqual([]);

    const sentinel: Record<string, unknown> = {
      agentic_config: {
        agent: 'claude-code',
        envVars: [envVar(GATEWAY_REDACTED_SENTINEL), { ...envVar('new'), key: 'OTHER' }],
      },
    };
    await resolveGatewayAgenticConfigPatch(sentinel, async () => stored);
    expect((sentinel.agentic_config as { envVars: unknown[] }).envVars).toEqual([
      envVar('stored-secret'),
      { ...envVar('new'), key: 'OTHER' },
    ]);
  });
});

describe('gateway channel update: config and agenticConfig stay independent', () => {
  dbTest(
    'a config-only update does not rewrite or re-materialize agentic config',
    async ({ db }) => {
      const { data, owner } = await channelData(db, true);
      const service = new GatewayChannelsService(db);
      const created = await service.create(
        {
          ...data,
          config: { bot_token: 'synthetic-bot', app_token: 'synthetic-app' },
          agentic_config: {
            agent: 'opencode',
            envVars: [envVar('secret-value')],
          },
        },
        { user: owner } as never
      );
      const rawBefore = await select(db)
        .from(gatewayChannels)
        .where(eq(gatewayChannels.id, created.id))
        .one();
      // modelConfig.updated_at is stamped on materialization; a later rewrite
      // would move it.
      await new Promise((resolve) => setTimeout(resolve, 15));

      const patch: Record<string, unknown> = { config: { allowed_channel_ids: ['C0123456789'] } };
      await resolveGatewayAgenticConfigPatch(
        patch,
        async () => (await new GatewayChannelRepository(db).findById(created.id))?.agentic_config
      );
      await service.patch(created.id, patch as never, { user: owner } as never);

      const rawAfter = await select(db)
        .from(gatewayChannels)
        .where(eq(gatewayChannels.id, created.id))
        .one();
      expect(rawAfter?.agentic_config).toEqual(rawBefore?.agentic_config);
      expect(rawAfter?.agentic_tool_preset_id).toEqual(rawBefore?.agentic_tool_preset_id);
      const reloaded = await new GatewayChannelRepository(db).findById(created.id);
      expect(reloaded?.config).toMatchObject({
        bot_token: 'synthetic-bot',
        app_token: 'synthetic-app',
        allowed_channel_ids: ['C0123456789'],
      });
      expect(reloaded?.agentic_config?.envVars?.[0]?.value).toBe('secret-value');
    }
  );

  dbTest(
    'a config-only update succeeds for a channel that references an agentic preset',
    async ({ db }) => {
      const { data, owner } = await channelData(db);
      const preset = await new AgenticToolPresetRepository(db).create(
        {
          tool: 'opencode',
          name: 'Gateway preset',
          configuration: {
            modelConfig: { mode: 'exact', provider: 'openai', model: 'gpt-preset' },
          },
        },
        owner.user_id
      );
      const service = new GatewayChannelsService(db);
      const created = await service.create(
        { ...data, agentic_config: { agent: 'opencode', presetId: preset.preset_id } },
        { user: owner } as never
      );
      const rawBefore = await select(db)
        .from(gatewayChannels)
        .where(eq(gatewayChannels.id, created.id))
        .one();

      const patch: Record<string, unknown> = { config: { allowed_channel_ids: ['C0123456789'] } };
      await resolveGatewayAgenticConfigPatch(
        patch,
        async () => (await new GatewayChannelRepository(db).findById(created.id))?.agentic_config
      );
      await service.patch(created.id, patch as never, { user: owner } as never);

      const rawAfter = await select(db)
        .from(gatewayChannels)
        .where(eq(gatewayChannels.id, created.id))
        .one();
      expect(rawAfter?.agentic_tool_preset_id).toBe(preset.preset_id);
      expect(rawAfter?.agentic_config).toEqual(rawBefore?.agentic_config);
    }
  );

  dbTest('an agenticConfig-only update does not touch config', async ({ db }) => {
    const { data, owner } = await channelData(db, true);
    const service = new GatewayChannelsService(db);
    const created = await service.create(
      {
        ...data,
        config: { bot_token: 'synthetic-bot', app_token: 'synthetic-app' },
        agentic_config: { agent: 'opencode', envVars: [envVar('secret-value')] },
      },
      { user: owner } as never
    );
    const rawBefore = await select(db)
      .from(gatewayChannels)
      .where(eq(gatewayChannels.id, created.id))
      .one();

    const patch: Record<string, unknown> = {
      agentic_config: { agent: 'opencode', envVars: [envVar(GATEWAY_REDACTED_SENTINEL)] },
    };
    await resolveGatewayAgenticConfigPatch(
      patch,
      async () => (await new GatewayChannelRepository(db).findById(created.id))?.agentic_config
    );
    await service.patch(created.id, patch as never, { user: owner } as never);

    const rawAfter = await select(db)
      .from(gatewayChannels)
      .where(eq(gatewayChannels.id, created.id))
      .one();
    expect(rawAfter?.config).toEqual(rawBefore?.config);
    expect(rawAfter?.enabled).toEqual(rawBefore?.enabled);
    const stored = rawAfter?.agentic_config as { envVars: Array<{ value: string }> };
    expect(decryptApiKey(stored.envVars[0].value)).toBe('secret-value');
  });
});

describe('gateway-channels patch hook wiring', () => {
  it('delegates agentic-config resolution and never copies the stored config into a patch', () => {
    const source = readFileSync(new URL('../register-hooks.ts', import.meta.url), 'utf8');
    expect(source).toContain('await resolveGatewayAgenticConfigPatch(data');
    expect(source).not.toContain('existing.agentic_config as unknown as Record<string, unknown>');
  });
});
