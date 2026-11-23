import type { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@agor/core/db', () => ({
  BoardObjectRepository: class BoardObjectRepository {},
  enqueueAfterTenantDatabaseCommit: () => false,
  getCurrentTenantId: () => undefined,
  runWithTenantDatabaseScope: vi.fn((_db, _tenantId, work) => work()),
}));

vi.mock('../server.js', () => ({
  coerceString: (value: unknown) =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined,
  textResult: (data: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  }),
}));

const { registerCardTools } = await import('./cards.js');

type ToolConfig = {
  inputSchema?: {
    safeParse: (value: unknown) => {
      success: boolean;
      error?: { issues?: Array<{ path: Array<string | number>; message: string }> };
    };
  };
};

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

function captureHandler(
  toolName: string,
  ctx: Parameters<typeof registerCardTools>[1]
): ToolHandler {
  let handler: ToolHandler | undefined;
  const fakeServer = {
    registerTool: (name: string, _cfg: ToolConfig, cb: ToolHandler) => {
      if (name === toolName) handler = cb;
    },
  } as unknown as McpServer;

  registerCardTools(fakeServer, ctx);
  if (!handler) throw new Error(`${toolName} was not registered`);
  return handler;
}

function captureConfig(toolName: string): ToolConfig {
  let config: ToolConfig | undefined;
  const fakeServer = {
    registerTool: (name: string, cfg: ToolConfig) => {
      if (name === toolName) config = cfg;
    },
  } as unknown as McpServer;

  registerCardTools(fakeServer, {} as Parameters<typeof registerCardTools>[1]);

  if (!config) throw new Error(`${toolName} was not registered`);
  return config;
}

describe('card MCP tool input schemas', () => {
  it('rejects an empty required title with a field-specific message', () => {
    const parsed = captureConfig('agor_cards_create').inputSchema?.safeParse({
      boardId: 'board-1',
      title: '',
    });

    expect(parsed?.success).toBe(false);
    expect(parsed?.error?.issues?.[0]).toMatchObject({
      path: ['title'],
      message: 'title cannot be empty.',
    });
  });

  it('validates list pagination as positive/non-negative integers', () => {
    const schema = captureConfig('agor_cards_list').inputSchema;

    const badLimit = schema?.safeParse({ limit: 0 });
    expect(badLimit?.success).toBe(false);
    expect(badLimit?.error?.issues?.[0]).toMatchObject({
      path: ['limit'],
      message: 'limit must be greater than 0.',
    });

    const badOffset = schema?.safeParse({ offset: -1 });
    expect(badOffset?.success).toBe(false);
    expect(badOffset?.error?.issues?.[0]).toMatchObject({
      path: ['offset'],
      message: 'offset must be greater than or equal to 0.',
    });
  });

  it('rejects empty bulk operation arrays in schema before the handler runs', () => {
    const parsed = captureConfig('agor_cards_bulk_create').inputSchema?.safeParse({
      boardId: 'board-1',
      cards: [],
    });

    expect(parsed?.success).toBe(false);
    expect(parsed?.error?.issues?.[0]).toMatchObject({
      path: ['cards'],
      message: 'cards must contain at least one card.',
    });
  });

  it('rejects empty nested card IDs in bulk updates', () => {
    const parsed = captureConfig('agor_cards_bulk_update').inputSchema?.safeParse({
      updates: [{ cardId: '' }],
    });

    expect(parsed?.success).toBe(false);
    expect(parsed?.error?.issues?.[0]).toMatchObject({
      path: ['updates', 0, 'cardId'],
      message: 'updates[].cardId cannot be empty. Example: { "updates[].cardId": "01abcdef" }',
    });
  });
});

describe('agor_cards_list', () => {
  it('uses the authenticated service find path with stable server-side paging', async () => {
    const baseServiceParams = {
      authenticated: true,
      provider: 'mcp',
      user: { user_id: 'user-1', role: 'member' },
    };
    const find = vi.fn(async () => ({
      total: 3,
      limit: 2,
      skip: 0,
      data: [
        { card_id: 'card-2', board_id: 'board-1', title: 'Second' },
        { card_id: 'card-1', board_id: 'board-1', title: 'First' },
      ],
    }));
    const ctx = {
      app: {
        service: (name: string) =>
          name === 'boards' ? { get: vi.fn(async () => ({ board_id: 'board-1' })) } : { find },
      },
      baseServiceParams,
    } as unknown as Parameters<typeof registerCardTools>[1];

    const result = (await captureHandler(
      'agor_cards_list',
      ctx
    )({
      boardId: 'board-1',
      search: 'term',
      limit: 2,
    })) as { content: Array<{ text: string }> };

    expect(find).toHaveBeenCalledWith({
      query: {
        archived: false,
        board_id: 'board-1',
        search: 'term',
        $limit: 2,
        $skip: 0,
        $sort: { created_at: -1, card_id: 1 },
      },
      ...baseServiceParams,
    });
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      total: 3,
      hasMore: true,
      nextOffset: 2,
    });
  });
});

describe('card MCP realtime events', () => {
  it('passes caller params to every board-authorized card method and emits correctly-shaped events', async () => {
    const params = {
      authenticated: true,
      provider: 'mcp',
      tenant: { tenant_id: 'tenant-a', source: 'auth_claim' },
      user: { user_id: 'user-1', role: 'member' },
    };
    const card = { card_id: 'card-1', board_id: 'board-1', title: 'Card' };
    const boardObject = {
      object_id: 'object-1',
      board_id: 'board-1',
      card_id: 'card-1',
      entity_type: 'card',
    };
    const cardsEmit = vi.fn();
    const boardObjectsEmit = vi.fn();
    const createWithPlacement = vi.fn(async () => ({ card, boardObject }));
    const moveToZone = vi.fn(async () => boardObject);
    const archive = vi.fn(async () => ({ card: { ...card, archived: true } }));
    const cardsGet = vi.fn(async () => card);
    const boardsGet = vi.fn(async () => ({ board_id: 'board-1', objects: {} }));
    const app = {
      service(name: string) {
        if (name === 'cards') {
          return { createWithPlacement, moveToZone, archive, get: cardsGet, emit: cardsEmit };
        }
        if (name === 'boards') return { get: boardsGet };
        if (name === 'board-objects') return { emit: boardObjectsEmit };
        throw new Error(`Unexpected service call: ${name}`);
      },
    };
    const ctx = {
      app,
      db: {},
      userId: 'user-1',
      authenticatedUser: params.user,
      baseServiceParams: params,
    } as unknown as Parameters<typeof registerCardTools>[1];

    await captureHandler('agor_cards_create', ctx)({ boardId: 'board-1', title: 'Card' });
    await captureHandler('agor_cards_move', ctx)({ cardId: 'card-1', zoneId: null });
    await captureHandler('agor_cards_archive', ctx)({ cardId: 'card-1' });

    expect(boardsGet).toHaveBeenCalledOnce();
    expect(createWithPlacement).toHaveBeenCalledWith(expect.any(Object), params);
    expect(moveToZone).toHaveBeenCalledWith('card-1', null, undefined, params);
    expect(archive).toHaveBeenCalledWith('card-1', params, { removeFromBoard: false });
    expect(cardsEmit).toHaveBeenCalledWith(
      'created',
      card,
      expect.objectContaining({ path: 'cards', method: 'create', params: {}, result: card })
    );
    expect(cardsEmit).toHaveBeenCalledWith(
      'patched',
      expect.objectContaining({ archived: true }),
      expect.objectContaining({ path: 'cards', method: 'patch', params: {} })
    );
    expect(boardObjectsEmit).toHaveBeenCalledWith(
      'patched',
      boardObject,
      expect.objectContaining({ path: 'board-objects', method: 'patch', params: {} })
    );
  });
});

describe('card MCP color overrides', () => {
  function colorCtx() {
    const createWithPlacement = vi.fn(async (data: Record<string, unknown>) => ({
      card: { card_id: 'card-1', ...data },
      boardObject: { object_id: 'object-1' },
    }));
    const patch = vi.fn(async (id: string, data: Record<string, unknown>) => ({
      card_id: id,
      ...data,
    }));
    const app = {
      service(name: string) {
        if (name === 'cards') return { createWithPlacement, patch, emit: vi.fn() };
        if (name === 'boards') return { get: vi.fn(async () => ({ board_id: 'board-1' })) };
        if (name === 'board-objects') return { emit: vi.fn() };
        throw new Error(`Unexpected service call: ${name}`);
      },
    };
    const ctx = {
      app,
      db: {},
      userId: 'user-1',
      baseServiceParams: {},
    } as unknown as Parameters<typeof registerCardTools>[1];
    return { ctx, createWithPlacement, patch };
  }

  it('normalizes hex, clears on null, and rejects non-hex on create and update', async () => {
    const { ctx, createWithPlacement, patch } = colorCtx();

    await captureHandler(
      'agor_cards_create',
      ctx
    )({
      boardId: 'board-1',
      title: 'Card',
      colorOverride: '#FF5630',
    });
    expect(createWithPlacement).toHaveBeenCalledWith(
      expect.objectContaining({ color_override: '#ff5630' }),
      {}
    );
    await expect(
      captureHandler(
        'agor_cards_create',
        ctx
      )({
        boardId: 'board-1',
        title: 'Card',
        colorOverride: 'red',
      })
    ).rejects.toThrow('colorOverride must be a hex color like #ff5630 (received "red")');

    await captureHandler('agor_cards_update', ctx)({ cardId: 'card-1', colorOverride: null });
    expect(patch).toHaveBeenLastCalledWith('card-1', { color_override: null }, {});
    await expect(
      captureHandler('agor_cards_update', ctx)({ cardId: 'card-1', colorOverride: 'blue' })
    ).rejects.toThrow('colorOverride must be a hex color');
    expect(patch).toHaveBeenCalledTimes(1);
  });

  it('validates every bulk color before writing any card', async () => {
    const { ctx, createWithPlacement, patch } = colorCtx();

    await expect(
      captureHandler(
        'agor_cards_bulk_create',
        ctx
      )({
        boardId: 'board-1',
        cards: [
          { title: 'Good', colorOverride: '#abc' },
          { title: 'Bad', colorOverride: 'tomato' },
        ],
      })
    ).rejects.toThrow('cards[1].colorOverride must be a hex color');
    expect(createWithPlacement).not.toHaveBeenCalled();

    await expect(
      captureHandler(
        'agor_cards_bulk_update',
        ctx
      )({
        updates: [
          { cardId: 'card-1', colorOverride: '#123456' },
          { cardId: 'card-2', colorOverride: 'rgb(0,0,0)' },
        ],
      })
    ).rejects.toThrow('updates[1].colorOverride must be a hex color');
    expect(patch).not.toHaveBeenCalled();

    await captureHandler(
      'agor_cards_bulk_update',
      ctx
    )({
      updates: [
        { cardId: 'card-1', colorOverride: '#123456' },
        { cardId: 'card-2', colorOverride: null },
        { cardId: 'card-3', title: 'No color change' },
      ],
    });
    expect(patch.mock.calls.map(([id, data]) => [id, data])).toEqual([
      ['card-1', { color_override: '#123456' }],
      ['card-2', { color_override: null }],
      ['card-3', { title: 'No color change' }],
    ]);
  });
});

describe('card MCP archive', () => {
  function archiveCtx() {
    const card = { card_id: 'card-1', board_id: 'board-1', title: 'Card', archived: false };
    const placement = {
      object_id: 'object-1',
      board_id: 'board-1',
      card_id: 'card-1',
      entity_type: 'card',
    };
    const cardsEmit = vi.fn();
    const boardObjectsEmit = vi.fn();
    const archive = vi.fn(
      async (_id: string, _params: unknown, options?: { removeFromBoard?: boolean }) => ({
        card: { ...card, archived: true },
        ...(options?.removeFromBoard ? { removedBoardObject: placement } : {}),
      })
    );
    const unarchive = vi.fn(async () => ({ card, createdBoardObject: placement }));
    const patch = vi.fn(async (id: string, data: Record<string, unknown>) => ({
      ...card,
      card_id: id,
      ...data,
    }));
    const find = vi.fn(async () => ({ total: 0, limit: 50, skip: 0, data: [] }));
    const app = {
      service(name: string) {
        if (name === 'cards') return { archive, unarchive, patch, find, emit: cardsEmit };
        if (name === 'board-objects') return { emit: boardObjectsEmit };
        throw new Error(`Unexpected service call: ${name}`);
      },
    };
    const ctx = {
      app,
      db: {},
      userId: 'user-1',
      baseServiceParams: {},
    } as unknown as Parameters<typeof registerCardTools>[1];
    return { ctx, archive, unarchive, patch, find, cardsEmit, boardObjectsEmit, placement };
  }

  it('removeFromBoard deletes the placement and publishes its removal', async () => {
    const { ctx, archive, boardObjectsEmit, placement } = archiveCtx();
    const result = (await captureHandler(
      'agor_cards_archive',
      ctx
    )({ cardId: 'card-1', removeFromBoard: true })) as { content: Array<{ text: string }> };

    expect(archive).toHaveBeenCalledWith('card-1', {}, { removeFromBoard: true });
    expect(boardObjectsEmit).toHaveBeenCalledWith(
      'removed',
      placement,
      expect.objectContaining({ path: 'board-objects', method: 'remove' })
    );
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      archived: true,
      removedBoardObjectId: 'object-1',
    });
  });

  it('archiving without removeFromBoard leaves the placement alone', async () => {
    const { ctx, boardObjectsEmit } = archiveCtx();
    await captureHandler('agor_cards_archive', ctx)({ cardId: 'card-1' });
    expect(boardObjectsEmit).not.toHaveBeenCalled();
  });

  it('unarchive publishes a re-created placement', async () => {
    const { ctx, unarchive, boardObjectsEmit, cardsEmit, placement } = archiveCtx();
    await captureHandler('agor_cards_unarchive', ctx)({ cardId: 'card-1' });

    expect(unarchive).toHaveBeenCalledWith('card-1', {}, { restorePlacement: undefined });
    expect(cardsEmit).toHaveBeenCalledWith(
      'patched',
      expect.objectContaining({ archived: false }),
      expect.objectContaining({ path: 'cards' })
    );
    expect(boardObjectsEmit).toHaveBeenCalledWith(
      'created',
      placement,
      expect.objectContaining({ path: 'board-objects', method: 'create' })
    );
  });

  it('update archived routes through the archive path, after any metadata patch', async () => {
    const { ctx, archive, unarchive, patch } = archiveCtx();

    await captureHandler('agor_cards_update', ctx)({ cardId: 'card-1', archived: true });
    expect(patch).not.toHaveBeenCalled();
    expect(archive).toHaveBeenCalledWith('card-1', {}, { removeFromBoard: undefined });

    await captureHandler(
      'agor_cards_update',
      ctx
    )({ cardId: 'card-1', note: 'shipped', archived: true });
    expect(patch).toHaveBeenCalledWith('card-1', { note: 'shipped' }, {});
    expect(patch.mock.invocationCallOrder[0]).toBeLessThan(
      archive.mock.invocationCallOrder[1] ?? Number.POSITIVE_INFINITY
    );

    await captureHandler(
      'agor_cards_bulk_update',
      ctx
    )({
      updates: [{ cardId: 'card-2', archived: false }],
    });
    expect(unarchive).toHaveBeenCalledWith('card-2', {}, { restorePlacement: undefined });
  });

  it('list hides archived cards by default and includeArchived lists both states', async () => {
    const { ctx, find } = archiveCtx();
    const list = captureHandler('agor_cards_list', ctx);
    const queryOf = (call: number) =>
      (find.mock.calls[call] as unknown as [{ query: Record<string, unknown> }])[0].query;

    await list({});
    expect(queryOf(0).archived).toBe(false);

    await list({ includeArchived: true });
    expect(queryOf(1)).not.toHaveProperty('archived');

    await list({ archived: true, includeArchived: false });
    expect(queryOf(2).archived).toBe(true);

    await list({ archived: false, includeArchived: true });
    expect(queryOf(3).archived).toBe(false);
  });
});
