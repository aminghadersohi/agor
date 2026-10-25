import {
  AgenticToolPresetRepository,
  decryptApiKey,
  eq,
  GatewayChannelRepository,
  gatewayChannels,
  isEncrypted,
  select,
  type TenantScopeAwareDatabase,
  update,
} from '@agor/core/db';
import type { GatewayChannel } from '@agor/core/types';
import { GATEWAY_REDACTED_SENTINEL, USER_DEFAULT_AGENTIC_CONFIGURATION } from '@agor/core/types';
import { beforeAll, describe, expect, it } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { GatewayChannelsService } from './gateway-channels';
import { channelData } from './gateway-channels.test-support';

beforeAll(() => {
  process.env.AGOR_MASTER_SECRET ||= 'gateway-channel-agentic-config-test-secret';
});

describe('GatewayChannelsService exact agentic configuration', () => {
  dbTest(
    'display find/get retain metadata and sentinels while runtime reads retain secrets',
    async ({ db }) => {
      const { data, owner } = await channelData(db);
      const repo = new GatewayChannelRepository(db);
      const created = await repo.create({
        ...data,
        created_by: owner.user_id,
        config: { bot_token: 'synthetic-bot', app_token: 'synthetic-app' },
      });
      const service = new GatewayChannelsService(db);
      const params = { user: owner, query: { id: created.id, $limit: 1 } } as never;
      const result = await service.find(params);
      const records = Array.isArray(result) ? result : result.data;
      expect(records).toHaveLength(1);
      expect(records[0].config.bot_token).toBe(GATEWAY_REDACTED_SENTINEL);
      const display = await service.get(created.id, params);
      expect(display.config.app_token).toBe(GATEWAY_REDACTED_SENTINEL);
      expect(display.name).toBe(created.name);
      expect((await repo.findById(created.id))?.config.bot_token).toBe('synthetic-bot');
    }
  );

  it('rejects My default when execution-owner alignment is unstable', async () => {
    await expect(
      new GatewayChannelsService({} as TenantScopeAwareDatabase).create({
        agor_user_id: 'fallback-user',
        config: { align_slack_users: true },
        agentic_config: {
          agent: 'claude-code',
          presetId: USER_DEFAULT_AGENTIC_CONFIGURATION,
        },
      })
    ).rejects.toThrow(/stable execution owner/i);
  });

  dbTest('rejects an incomplete inline OpenCode pair before persistence', async ({ db }) => {
    const { data, owner } = await channelData(db);

    await expect(
      new GatewayChannelsService(db).create(
        {
          ...data,
          agentic_config: {
            agent: 'opencode',
            modelConfig: { mode: 'exact', provider: 'openai' },
          } as unknown as GatewayChannel['agentic_config'],
        },
        { user: owner } as never
      )
    ).rejects.toThrow(/provider and model/i);
    expect(await new GatewayChannelRepository(db).findAll()).toHaveLength(0);
  });

  for (const [agent, model, owner] of [
    ['codex', 'claude-opus-5-5', 'claude-code'],
    ['claude-code', 'gpt-6-astra', 'codex'],
  ] as const) {
    dbTest(`rejects a ${owner} model on a ${agent} channel before persistence`, async ({ db }) => {
      const { data, owner: user } = await channelData(db);
      const service = new GatewayChannelsService(db);
      await expect(
        service.create(
          {
            ...data,
            agentic_config: {
              agent,
              modelConfig: { mode: 'exact', model, effort: 'medium' },
            } as unknown as GatewayChannel['agentic_config'],
          },
          { user } as never
        )
      ).rejects.toThrow(`Model "${model}" is a ${owner} model and cannot run on a ${agent}`);
      expect(await new GatewayChannelRepository(db).findAll()).toHaveLength(0);
    });
  }

  dbTest('resolves an exact OpenCode pair from the stable execution owner', async ({ db }) => {
    const { data, owner } = await channelData(db, true);

    const created = await new GatewayChannelsService(db).create(data, { user: owner } as never);

    expect(created.agentic_config).toMatchObject({
      agent: 'opencode',
      modelConfig: {
        mode: 'exact',
        provider: 'openai',
        model: 'gpt-test',
        updated_at: expect.any(String),
      },
    });
  });

  dbTest('round-trips a stable-owner My default create outside the preset FK', async ({ db }) => {
    const { data, owner } = await channelData(db, true);
    const created = await new GatewayChannelsService(db).create(
      {
        ...data,
        agentic_config: {
          agent: 'opencode',
          presetId: USER_DEFAULT_AGENTIC_CONFIGURATION,
          envVars: [{ key: 'TOKEN', value: 'secret-value', forceOverride: false }],
        },
      },
      { user: owner } as never
    );

    expect(created.agentic_config).toMatchObject({
      presetId: USER_DEFAULT_AGENTIC_CONFIGURATION,
      envVars: [{ key: 'TOKEN', value: 'secret-value', forceOverride: false }],
    });
    const raw = await select(db)
      .from(gatewayChannels)
      .where(eq(gatewayChannels.id, created.id))
      .one();
    const stored = raw?.agentic_config as Record<string, unknown>;
    expect(raw?.agentic_tool_preset_id).toBeNull();
    expect(stored.presetId).toBe(USER_DEFAULT_AGENTIC_CONFIGURATION);
    const storedValue = (stored.envVars as Array<{ value: string }>)[0]?.value ?? '';
    expect(isEncrypted(storedValue)).toBe(true);
    expect(decryptApiKey(storedValue)).toBe('secret-value');
  });

  dbTest('rejects unsafe gateway environment maps at the service boundary', async ({ db }) => {
    const { data, owner } = await channelData(db, true);
    const service = new GatewayChannelsService(db);
    const base = {
      ...data,
      agentic_config: {
        agent: 'opencode' as const,
        presetId: USER_DEFAULT_AGENTIC_CONFIGURATION,
      },
    };

    await expect(
      service.create(
        {
          ...base,
          agentic_config: {
            ...base.agentic_config,
            envVars: [{ key: 'bad-key', value: 'secret', forceOverride: false }],
          },
        },
        { user: owner } as never
      )
    ).rejects.toThrow(/invalid gateway environment variable/i);
    await expect(
      service.create(
        {
          ...base,
          agentic_config: {
            ...base.agentic_config,
            envVars: [{ key: 'SAFE_KEY', value: 'bad\0value', forceOverride: false }],
          },
        },
        { user: owner } as never
      )
    ).rejects.toThrow(/NUL character/i);
    await expect(
      service.create(
        {
          ...base,
          agentic_config: {
            ...base.agentic_config,
            envVars: [
              { key: 'DUPLICATE', value: 'one', forceOverride: false },
              { key: 'DUPLICATE', value: 'two', forceOverride: true },
            ],
          },
        },
        { user: owner } as never
      )
    ).rejects.toThrow(/duplicate gateway environment variable/i);
    await expect(
      service.create(
        {
          ...base,
          agentic_config: {
            ...base.agentic_config,
            envVars: [
              {
                key: 'SENTINEL',
                value: GATEWAY_REDACTED_SENTINEL,
                forceOverride: false,
              },
            ],
          },
        },
        { user: owner } as never
      )
    ).rejects.toThrow(/unresolved redaction sentinel/i);

    expect(await new GatewayChannelRepository(db).findAll()).toHaveLength(0);
  });

  dbTest('never turns an unreadable stored envelope into a runtime credential', async ({ db }) => {
    const { data, owner } = await channelData(db, true);
    const created = await new GatewayChannelsService(db).create(
      {
        ...data,
        agentic_config: {
          agent: 'opencode',
          presetId: USER_DEFAULT_AGENTIC_CONFIGURATION,
          envVars: [{ key: 'TOKEN', value: 'secret-value', forceOverride: false }],
        },
      },
      { user: owner } as never
    );
    const raw = await select(db)
      .from(gatewayChannels)
      .where(eq(gatewayChannels.id, created.id))
      .one();
    const stored = structuredClone(raw?.agentic_config as Record<string, unknown>);
    const envVars = stored.envVars as Array<{ key: string; value: string; forceOverride: boolean }>;
    const envelope = envVars[0].value;
    const [salt, iv, tag, ciphertext] = envelope.split(':');
    envVars[0].value = `${salt}:${iv}:${tag.slice(0, -1)}${tag.at(-1) === '0' ? '1' : '0'}:${ciphertext}`;
    await update(db, gatewayChannels)
      .set({ agentic_config: stored })
      .where(eq(gatewayChannels.id, created.id))
      .run();

    const reloaded = await new GatewayChannelRepository(db).findById(created.id);

    expect(reloaded?.agentic_config?.envVars).toEqual([]);
  });

  dbTest('round-trips a stable-owner My default patch outside the preset FK', async ({ db }) => {
    const { data, owner } = await channelData(db, true);
    const service = new GatewayChannelsService(db);
    const created = await service.create(data, { user: owner } as never);
    const patched = await service.patch(
      created.id,
      {
        agentic_config: {
          agent: 'opencode',
          presetId: USER_DEFAULT_AGENTIC_CONFIGURATION,
        },
      },
      { user: owner } as never
    );

    expect(patched.agentic_config?.presetId).toBe(USER_DEFAULT_AGENTIC_CONFIGURATION);
    const raw = await select(db)
      .from(gatewayChannels)
      .where(eq(gatewayChannels.id, created.id))
      .one();
    expect(raw).toBeDefined();
    expect(raw?.agentic_tool_preset_id).toBeNull();
    expect((raw?.agentic_config as Record<string, unknown> | undefined)?.presetId).toBe(
      USER_DEFAULT_AGENTIC_CONFIGURATION
    );
  });

  dbTest('stores a real preset only in the preset FK', async ({ db }) => {
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
    const created = await new GatewayChannelsService(db).create(
      {
        ...data,
        agentic_config: { agent: 'opencode', presetId: preset.preset_id },
      },
      { user: owner } as never
    );

    expect(created.agentic_config?.presetId).toBe(preset.preset_id);
    const raw = await select(db)
      .from(gatewayChannels)
      .where(eq(gatewayChannels.id, created.id))
      .one();
    expect(raw).toBeDefined();
    expect(raw?.agentic_tool_preset_id).toBe(preset.preset_id);
    expect((raw?.agentic_config as Record<string, unknown> | undefined)?.presetId).toBeUndefined();
  });
});
