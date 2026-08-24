import type { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import { registerBoardTools } from './boards.js';

vi.mock('@agor/core/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agor/core/db')>()),
  runWithTenantDatabaseScope: vi.fn((_db, _tenantId, work) => work()),
}));

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

type ToolConfig = {
  inputSchema?: {
    safeParse: (
      value: unknown
    ) =>
      | { success: true; data: unknown }
      | { success: false; error: { issues: Array<{ message: string }> } };
  };
};

function makeMcpContext(ctx: {
  app: unknown;
  userId: string;
  baseServiceParams?: Record<string, unknown>;
}): Parameters<typeof registerBoardTools>[1] {
  return {
    app: ctx.app as Parameters<typeof registerBoardTools>[1]['app'],
    db: {} as Parameters<typeof registerBoardTools>[1]['db'],
    userId: ctx.userId as Parameters<typeof registerBoardTools>[1]['userId'],
    authenticatedUser: { user_id: ctx.userId, role: 'member' } as Parameters<
      typeof registerBoardTools
    >[1]['authenticatedUser'],
    baseServiceParams: (ctx.baseServiceParams ?? {}) as Parameters<
      typeof registerBoardTools
    >[1]['baseServiceParams'],
  };
}

function registerAndCaptureHandler(
  toolName: string,
  ctx: {
    app: unknown;
    userId: string;
    baseServiceParams?: Record<string, unknown>;
  }
): ToolHandler {
  let handler: ToolHandler | undefined;
  const fakeServer = {
    registerTool: (name: string, _cfg: unknown, cb: ToolHandler) => {
      if (name === toolName) handler = cb;
    },
  } as unknown as McpServer;

  registerBoardTools(fakeServer, makeMcpContext(ctx));

  if (!handler) throw new Error(`${toolName} was not registered`);
  return handler;
}

function registerAndCaptureConfig(
  toolName: string,
  ctx: {
    app: unknown;
    userId: string;
    baseServiceParams?: Record<string, unknown>;
  }
): ToolConfig {
  let config: ToolConfig | undefined;
  const fakeServer = {
    registerTool: (name: string, cfg: ToolConfig, _cb: ToolHandler) => {
      if (name === toolName) config = cfg;
    },
  } as unknown as McpServer;

  registerBoardTools(fakeServer, makeMcpContext(ctx));

  if (!config) throw new Error(`${toolName} was not registered`);
  return config;
}

describe('agor_boards_list pagination', () => {
  const baseServiceParams = { authenticated: true, provider: 'mcp' };

  it('uses a lean bounded default and reports how to advance pages', async () => {
    const find = vi.fn(async ({ query }: { query: Record<string, unknown> }) => ({
      total: 30,
      limit: query.$limit,
      skip: query.$skip,
      data: Array.from({ length: 25 }, (_, i) => ({ board_id: `board-${i}` })),
    }));
    const list = registerAndCaptureHandler('agor_boards_list', {
      app: { service: () => ({ find }) },
      userId: 'user-1',
      baseServiceParams,
    });

    const parsed = JSON.parse((await list({})).content[0].text);
    expect(find).toHaveBeenCalledWith({
      query: {
        $limit: 25,
        $skip: 0,
        lean: true,
        archived: false,
        $sort: { created_at: -1, board_id: 1 },
      },
      ...baseServiceParams,
    });
    expect(parsed).toMatchObject({
      total: 30,
      limit: 25,
      offset: 0,
      hasMore: true,
      nextOffset: 25,
    });
  });

  it('supports explicit and empty final pages and caps limits in the schema', async () => {
    const find = vi.fn(async () => ({ total: 4, limit: 2, skip: 4, data: [] }));
    const ctx = {
      app: { service: () => ({ find }) },
      userId: 'user-1',
      baseServiceParams,
    };
    const list = registerAndCaptureHandler('agor_boards_list', ctx);
    const parsed = JSON.parse((await list({ limit: 2, offset: 4 })).content[0].text);
    expect(parsed).toMatchObject({ total: 4, data: [], hasMore: false, nextOffset: null });

    const schema = registerAndCaptureConfig('agor_boards_list', ctx).inputSchema!;
    expect(schema.safeParse({ limit: 100 }).success).toBe(true);
    expect(schema.safeParse({ limit: 101 }).success).toBe(false);
  });
});

describe('agor_boards_get', () => {
  const baseServiceParams = {
    authenticated: true,
    provider: 'mcp',
    user: { user_id: 'user-1', role: 'member' },
  };

  const board = {
    board_id: 'board-1',
    name: 'Test Board',
    url: 'http://localhost:5173/ui/b/board-1/',
    created_at: '2026-06-01T00:00:00.000Z',
    last_updated: '2026-06-01T00:00:00.000Z',
    created_by: 'user-1',
    archived: false,
    objects: {
      'zone-review': {
        type: 'zone',
        x: 0,
        y: 0,
        width: 400,
        height: 300,
        label: 'Review',
      },
      'note-1': {
        type: 'markdown',
        x: 500,
        y: 0,
        width: 300,
        content: '# Large note',
      },
      'app-1': {
        type: 'app',
        x: 0,
        y: 400,
        width: 600,
        height: 400,
        title: 'Heavy app',
        template: 'react',
        files: { '/src/App.tsx': 'export default function App() { return null; }' },
      },
    },
  };

  function makeApp(options?: {
    boardObjectsFind?: ReturnType<typeof vi.fn>;
    branchesFind?: ReturnType<typeof vi.fn>;
  }) {
    const boardsGet = vi.fn(async () => board);
    const permissionsFind = vi.fn(async () => ({
      primary_owner_user_id: '00000000-0000-7000-8000-000000000001',
      board_access_revision: 1,
      branch_template_revision: 1,
    }));
    const boardObjectsFind =
      options?.boardObjectsFind ??
      vi.fn(async () => ({
        data: [],
        total: 0,
        limit: 100,
        skip: 0,
      }));
    const branchesFind =
      options?.branchesFind ??
      vi.fn(async (params?: { query?: { branch_id?: { $in?: string[] } } }) =>
        (params?.query?.branch_id?.$in ?? []).map((branch_id) => ({ branch_id, archived: false }))
      );

    return {
      boardsGet,
      boardObjectsFind,
      branchesFind,
      app: {
        service(name: string) {
          if (name === 'boards') return { get: boardsGet };
          if (name === 'boards/:id/permissions') return { find: permissionsFind };
          if (name === 'board-objects') return { find: boardObjectsFind };
          if (name === 'branches') return { find: branchesFind };
          throw new Error(`Unexpected service call: ${name}`);
        },
      },
    };
  }

  it('can return a lean board definition with only zone objects and no entities', async () => {
    const { app, boardObjectsFind } = makeApp();
    const getBoard = registerAndCaptureHandler('agor_boards_get', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const result = await getBoard({ boardId: 'board-1', objectTypes: ['zone'] });
    const parsed = JSON.parse(result.content[0].text);

    expect(result.isError).toBeFalsy();
    expect(Object.keys(parsed.objects)).toEqual(['zone-review']);
    expect(parsed.objects['zone-review'].label).toBe('Review');
    expect(parsed.entities).toBeUndefined();
    expect(boardObjectsFind).not.toHaveBeenCalled();
  });

  it('filters and paginates included positioned entities', async () => {
    const boardObjectsFind = vi.fn(async () => ({
      data: [
        {
          object_id: 'obj-branch-0',
          board_id: 'board-1',
          branch_id: 'branch-0',
          entity_type: 'branch',
          position: { x: 0, y: 0 },
          zone_id: 'zone-review',
          created_at: '2026-06-01T00:00:00.000Z',
        },
        {
          object_id: 'obj-branch-1',
          board_id: 'board-1',
          branch_id: 'branch-1',
          entity_type: 'branch',
          position: { x: 10, y: 20 },
          zone_id: 'zone-review',
          created_at: '2026-06-01T00:00:00.000Z',
        },
        {
          object_id: 'obj-branch-2',
          board_id: 'board-1',
          branch_id: 'branch-2',
          entity_type: 'branch',
          position: { x: 30, y: 40 },
          zone_id: 'zone-review',
          created_at: '2026-06-01T00:00:00.000Z',
        },
      ],
      total: 3,
      limit: 100,
      skip: 0,
    }));
    const branchesFind = vi.fn(async () => [
      { branch_id: 'branch-0', archived: false },
      { branch_id: 'branch-1', archived: false },
      { branch_id: 'branch-2', archived: false },
    ]);
    const { app } = makeApp({ boardObjectsFind, branchesFind });
    const getBoard = registerAndCaptureHandler('agor_boards_get', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const result = await getBoard({
      boardId: 'board-1',
      includeEntities: true,
      entityZoneId: 'zone-review',
      entityType: 'branch',
      entitiesLimit: 1,
      entitiesSkip: 1,
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(boardObjectsFind).toHaveBeenCalledWith({
      query: {
        board_id: 'board-1',
        zone_id: 'zone-review',
        entity_type: 'branch',
      },
      ...baseServiceParams,
    });
    expect(branchesFind).toHaveBeenCalledWith({
      query: {
        branch_id: { $in: ['branch-0', 'branch-1', 'branch-2'] },
        archived: false,
      },
      paginate: false,
      ...baseServiceParams,
    });
    expect(parsed.entities).toHaveLength(1);
    expect(parsed.entities[0].branch_id).toBe('branch-1');
    expect(parsed.entities_pagination).toEqual({ total: 3, limit: 1, skip: 1 });
  });

  it('excludes archived branch entities by default while preserving card entities', async () => {
    const boardObjectsFind = vi.fn(async () => ({
      data: [
        {
          object_id: 'obj-branch-1',
          board_id: 'board-1',
          branch_id: 'branch-1',
          entity_type: 'branch',
          position: { x: 10, y: 20 },
          created_at: '2026-06-01T00:00:00.000Z',
        },
        {
          object_id: 'obj-branch-2',
          board_id: 'board-1',
          branch_id: 'branch-2',
          entity_type: 'branch',
          position: { x: 30, y: 40 },
          created_at: '2026-06-01T00:00:00.000Z',
        },
        {
          object_id: 'obj-card-1',
          board_id: 'board-1',
          card_id: 'card-1',
          entity_type: 'card',
          position: { x: 50, y: 60 },
          created_at: '2026-06-01T00:00:00.000Z',
        },
      ],
      total: 3,
      limit: 100,
      skip: 0,
    }));
    const branchesFind = vi.fn(async () => [{ branch_id: 'branch-1', archived: false }]);
    const { app } = makeApp({ boardObjectsFind, branchesFind });
    const getBoard = registerAndCaptureHandler('agor_boards_get', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const result = await getBoard({ boardId: 'board-1', includeEntities: true });
    const parsed = JSON.parse(result.content[0].text);

    expect(boardObjectsFind).toHaveBeenCalledWith({
      query: { board_id: 'board-1' },
      ...baseServiceParams,
    });
    expect(parsed.entities.map((entity: { object_id: string }) => entity.object_id)).toEqual([
      'obj-branch-1',
      'obj-card-1',
    ]);
    expect(parsed.entities_pagination).toEqual({ total: 2, limit: null, skip: 0 });
  });

  it('includes archived branch entities when includeArchived=true', async () => {
    const boardObjectsFind = vi.fn(async () => ({
      data: [
        {
          object_id: 'obj-branch-1',
          board_id: 'board-1',
          branch_id: 'branch-1',
          entity_type: 'branch',
          position: { x: 10, y: 20 },
          created_at: '2026-06-01T00:00:00.000Z',
        },
      ],
      total: 1,
      limit: 100,
      skip: 0,
    }));
    const branchesFind = vi.fn(async () => []);
    const { app } = makeApp({ boardObjectsFind, branchesFind });
    const getBoard = registerAndCaptureHandler('agor_boards_get', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const result = await getBoard({
      boardId: 'board-1',
      includeEntities: true,
      includeArchived: true,
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(branchesFind).not.toHaveBeenCalled();
    expect(parsed.entities).toHaveLength(1);
    expect(parsed.entities[0].branch_id).toBe('branch-1');
    expect(parsed.entities_pagination).toEqual({ total: 1, limit: null, skip: 0 });
  });

  it('reports null pagination limit when only entitiesSkip is provided', async () => {
    const boardObjectsFind = vi.fn(async () => ({
      data: [
        {
          object_id: 'obj-branch-0',
          board_id: 'board-1',
          branch_id: 'branch-0',
          entity_type: 'branch',
          position: { x: 0, y: 0 },
          created_at: '2026-06-01T00:00:00.000Z',
        },
        {
          object_id: 'obj-branch-1',
          board_id: 'board-1',
          branch_id: 'branch-1',
          entity_type: 'branch',
          position: { x: 10, y: 20 },
          created_at: '2026-06-01T00:00:00.000Z',
        },
      ],
      total: 2,
      limit: 100,
      skip: 0,
    }));
    const { app } = makeApp({ boardObjectsFind });
    const getBoard = registerAndCaptureHandler('agor_boards_get', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const result = await getBoard({
      boardId: 'board-1',
      includeEntities: true,
      entitiesSkip: 1,
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.entities).toHaveLength(1);
    expect(parsed.entities[0].branch_id).toBe('branch-1');
    expect(parsed.entities_pagination).toEqual({ total: 2, limit: null, skip: 1 });
  });

  it('validates entity pagination input constraints in the MCP schema', () => {
    const { app } = makeApp();
    const config = registerAndCaptureConfig('agor_boards_get', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    expect(
      config.inputSchema?.safeParse({
        boardId: 'board-1',
        includeEntities: true,
        entitiesLimit: 25,
        entitiesSkip: 5,
      }).success
    ).toBe(true);
    expect(
      config.inputSchema?.safeParse({
        boardId: 'board-1',
        includeEntities: true,
        entitiesLimit: -1,
      }).success
    ).toBe(false);
    expect(
      config.inputSchema?.safeParse({
        boardId: 'board-1',
        includeEntities: true,
        entitiesLimit: 1.5,
      }).success
    ).toBe(false);
    expect(
      config.inputSchema?.safeParse({
        boardId: 'board-1',
        includeEntities: true,
        entitiesLimit: 0,
      }).success
    ).toBe(false);
    expect(
      config.inputSchema?.safeParse({
        boardId: 'board-1',
        includeEntities: true,
        entitiesSkip: 10001,
      }).success
    ).toBe(false);
  });

  it('rejects empty required boardId with a clear field-specific message', () => {
    const { app } = makeApp();
    const config = registerAndCaptureConfig('agor_boards_get', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const result = config.inputSchema?.safeParse({ boardId: '' });

    expect(result?.success).toBe(false);
    if (result?.success === false) {
      expect(result.error.issues[0]?.message).toMatch(/boardId cannot be empty/i);
    }
  });
});

describe('agor_boards_create schema', () => {
  it('rejects an empty required board name with a clear message', () => {
    const config = registerAndCaptureConfig('agor_boards_create', {
      app: {},
      userId: 'user-1',
    });

    const result = config.inputSchema?.safeParse({ name: '' });

    expect(result?.success).toBe(false);
    if (result?.success === false) {
      expect(result.error.issues[0]?.message).toMatch(/name cannot be empty/i);
    }
  });

  it('accepts None as a board branch-permission default', () => {
    const config = registerAndCaptureConfig('agor_boards_create', {
      app: {},
      userId: 'user-1',
    });

    expect(
      config.inputSchema?.safeParse({ name: 'Private fallback', defaultOthersCan: 'none' }).success
    ).toBe(true);
  });
});

describe('agor_boards_auto_arrange_zone', () => {
  const baseServiceParams = { authenticated: true, provider: 'mcp' };

  it('exposes deck overflow as an explicit opt-in', () => {
    const config = registerAndCaptureConfig('agor_boards_auto_arrange_zone', {
      app: {},
      userId: 'user-1',
    });

    expect(
      config.inputSchema?.safeParse({
        boardId: 'board-1',
        zoneId: 'zone-1',
        overflowStrategy: 'deck',
      }).success
    ).toBe(true);
  });

  it('arranges only active cards, never hidden archived cards', async () => {
    const patches = vi.fn(
      async (_id: string, data: { position: { x: number; y: number } }) => data
    );
    const entities = Array.from({ length: 20 }, (_, index) => ({
      object_id: `card-${index}`,
      board_id: 'board-1',
      card_id: `card-${index}`,
      entity_type: 'card' as const,
      position: { x: 0, y: index * 10 },
      zone_id: 'zone-1',
      created_at: '2026-06-01T00:00:00.000Z',
    }));
    const cardsFind = vi.fn(async () => ({
      data: entities.slice(0, 5).map((entity) => ({ card_id: entity.card_id })),
    }));
    const app = {
      service(name: string) {
        if (name === 'boards')
          return {
            get: vi.fn(async () => ({
              board_id: 'board-1',
              objects: { 'zone-1': { type: 'zone', x: 0, y: 0, width: 1200, height: 1800 } },
            })),
          };
        if (name === 'board-objects')
          return { find: vi.fn(async () => ({ data: entities })), patch: patches };
        if (name === 'cards')
          return { find: cardsFind, get: vi.fn(async () => ({ title: 'Card' })) };
        throw new Error(`Unexpected service call: ${name}`);
      },
    };
    const arrange = registerAndCaptureHandler('agor_boards_auto_arrange_zone', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const parsed = JSON.parse(
      (await arrange({ boardId: 'board-1', zoneId: 'zone-1', columns: 1, strictColumns: true }))
        .content[0].text
    );

    expect(cardsFind).toHaveBeenCalledWith(
      expect.objectContaining({ query: expect.objectContaining({ archived: false }) })
    );
    expect(parsed).toMatchObject({ applied: true, arranged: 5, columns: 1, rows: 5 });
    expect(patches).toHaveBeenCalledTimes(5);
    expect(patches.mock.calls.map(([objectId]) => objectId)).toEqual(
      entities.slice(0, 5).map((entity) => entity.object_id)
    );
  });

  it('uses accessible cascade offsets only when deck overflow is explicit', async () => {
    const patches: Array<{ id: string; position: { x: number; y: number } }> = [];
    const boardObjects = Array.from({ length: 20 }, (_, index) => ({
      object_id: `card-${index}`,
      board_id: 'board-1',
      card_id: `card-${index}`,
      entity_type: 'card' as const,
      position: { x: 0, y: 0 },
      zone_id: 'zone-1',
      created_at: '2026-06-01T00:00:00.000Z',
    }));
    const boardObjectsService = {
      find: vi.fn(async () => ({ data: boardObjects })),
      patch: vi.fn(async (id: string, data: { position: { x: number; y: number } }) => {
        patches.push({ id, position: data.position });
        return data;
      }),
    };
    const app = {
      service(name: string) {
        if (name === 'boards') {
          return {
            get: vi.fn(async () => ({
              board_id: 'board-1',
              objects: {
                'zone-1': { type: 'zone', x: 100, y: 100, width: 620, height: 1800 },
              },
            })),
          };
        }
        if (name === 'board-objects') return boardObjectsService;
        if (name === 'cards')
          return {
            find: vi.fn(async () => ({
              data: boardObjects.map((object) => ({ card_id: object.card_id })),
            })),
            get: vi.fn(async () => ({ title: 'Card', description: 'x'.repeat(1000) })),
          };
        throw new Error(`Unexpected service call: ${name}`);
      },
    };
    const arrange = registerAndCaptureHandler('agor_boards_auto_arrange_zone', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const rejected = JSON.parse(
      (await arrange({ boardId: 'board-1', zoneId: 'zone-1', columns: 1 })).content[0].text
    );
    expect(rejected).toMatchObject({
      applied: false,
      arranged: 0,
      requestedColumns: 1,
      layoutMode: 'grid',
      updates: [],
    });
    expect(rejected.overflowingObjectIds.length).toBeGreaterThan(0);
    expect(patches).toHaveLength(0);

    const parsed = JSON.parse(
      (
        await arrange({
          boardId: 'board-1',
          zoneId: 'zone-1',
          columns: 1,
          overflowStrategy: 'deck',
        })
      ).content[0].text
    );

    expect(parsed.arranged).toBe(20);
    expect(parsed.applied).toBe(true);
    expect(parsed.requestedColumns).toBe(1);
    expect(parsed.columns).toBe(1);
    expect(parsed.fitsWithoutOverlap).toBe(false);
    expect(parsed.layoutMode).toBe('deck');
    expect(parsed.deckOffsetX).toBe(12);
    expect(parsed.deckOffsetY).toBe(48);
    expect(parsed.overflowingObjectIds).toEqual([]);
    expect(parsed.warning).toContain('48px header reveals');
    expect(patches).toHaveLength(20);

    const secondLayer = parsed.updates.find(
      (update: { deckDepth: number }) => update.deckDepth === 1
    );
    const stackBase = parsed.updates.find(
      (update: { stackIndex: number; deckDepth: number }) =>
        update.stackIndex === secondLayer?.stackIndex && update.deckDepth === 0
    );
    expect(secondLayer).toBeDefined();
    expect(stackBase).toBeDefined();
    expect(secondLayer.position).toEqual({
      x: stackBase.position.x + 12,
      y: stackBase.position.y + 48,
    });
    expect(parsed.requiredHeight).toBeLessThanOrEqual(1800);
  });

  it('prefers a fully separated row-major grid when rows and columns fit', async () => {
    const patches: Array<{ position: { x: number; y: number } }> = [];
    const entities = Array.from({ length: 4 }, (_, index) => ({
      object_id: `card-${index}`,
      board_id: 'board-1',
      card_id: `card-${index}`,
      entity_type: 'card' as const,
      position: { x: index * 10, y: 0 },
      zone_id: 'zone-1',
      created_at: '2026-06-01T00:00:00.000Z',
    }));
    const app = {
      service(name: string) {
        if (name === 'boards')
          return {
            get: vi.fn(async () => ({
              board_id: 'board-1',
              objects: { 'zone-1': { type: 'zone', x: 0, y: 0, width: 1000, height: 500 } },
            })),
          };
        if (name === 'board-objects')
          return {
            find: vi.fn(async () => ({ data: entities })),
            patch: vi.fn(async (_id: string, data: { position: { x: number; y: number } }) => {
              patches.push(data);
              return data;
            }),
          };
        if (name === 'cards')
          return {
            find: vi.fn(async () => ({
              data: entities.map((entity) => ({ card_id: entity.card_id })),
            })),
            get: vi.fn(async () => ({ title: 'Card' })),
          };
        throw new Error(`Unexpected service call: ${name}`);
      },
    };
    const arrange = registerAndCaptureHandler('agor_boards_auto_arrange_zone', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const parsed = JSON.parse(
      (await arrange({ boardId: 'board-1', zoneId: 'zone-1', columns: 2 })).content[0].text
    );

    expect(parsed).toMatchObject({ layoutMode: 'grid', columns: 2, rows: 2 });
    expect(patches.map((update) => update.position)).toEqual([
      { x: 24, y: 24 },
      { x: 428, y: 24 },
      { x: 24, y: 104 },
      { x: 428, y: 104 },
    ]);
  });

  it('uses persisted rendered sizes instead of guessing from card content', async () => {
    const patches: Array<{ position: { x: number; y: number } }> = [];
    const entities = Array.from({ length: 20 }, (_, index) => ({
      object_id: `card-${index}`,
      board_id: 'board-1',
      card_id: `card-${index}`,
      entity_type: 'card' as const,
      position: { x: 0, y: index * 10 },
      size: { width: 380, height: 56 + (index % 3) * 12 },
      zone_id: 'zone-1',
      created_at: '2026-06-01T00:00:00.000Z',
    }));
    const cardsGet = vi.fn(async () => ({ description: 'x'.repeat(10_000) }));
    const app = {
      service(name: string) {
        if (name === 'boards')
          return {
            get: vi.fn(async () => ({
              board_id: 'board-1',
              objects: { 'zone-1': { type: 'zone', x: 0, y: 0, width: 620, height: 1800 } },
            })),
          };
        if (name === 'board-objects')
          return {
            find: vi.fn(async () => ({ data: entities })),
            patch: vi.fn(async (_id: string, data: { position: { x: number; y: number } }) => {
              patches.push(data);
              return data;
            }),
          };
        if (name === 'cards')
          return {
            find: vi.fn(async () => ({
              data: entities.map((entity) => ({ card_id: entity.card_id })),
            })),
            get: cardsGet,
          };
        throw new Error(`Unexpected service call: ${name}`);
      },
    };
    const arrange = registerAndCaptureHandler('agor_boards_auto_arrange_zone', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const parsed = JSON.parse(
      (await arrange({ boardId: 'board-1', zoneId: 'zone-1' })).content[0].text
    );

    expect(parsed).toMatchObject({
      layoutMode: 'grid',
      columns: 1,
      rows: 20,
      fitsWithoutOverlap: true,
      overflowingObjectIds: [],
      warning: null,
    });
    expect(cardsGet).not.toHaveBeenCalled();
    expect(patches).toHaveLength(20);
    for (const [index, patch] of patches.entries()) {
      const entity = entities[index];
      expect(patch.position.x + (entity?.size.width ?? 0)).toBeLessThanOrEqual(620 - 24);
      expect(patch.position.y + (entity?.size.height ?? 0)).toBeLessThanOrEqual(1800 - 24);
    }
  });

  it('does not move anything when exact columns cannot fit inside the zone', async () => {
    const patch = vi.fn();
    const entities = Array.from({ length: 4 }, (_, index) => ({
      object_id: `card-${index}`,
      board_id: 'board-1',
      card_id: `card-${index}`,
      entity_type: 'card' as const,
      position: { x: index * 10, y: 0 },
      size: { width: 380, height: 80 },
      zone_id: 'zone-1',
      created_at: '2026-06-01T00:00:00.000Z',
    }));
    const app = {
      service(name: string) {
        if (name === 'boards')
          return {
            get: vi.fn(async () => ({
              board_id: 'board-1',
              objects: { 'zone-1': { type: 'zone', x: 0, y: 0, width: 620, height: 500 } },
            })),
          };
        if (name === 'board-objects')
          return { find: vi.fn(async () => ({ data: entities })), patch };
        if (name === 'cards')
          return {
            find: vi.fn(async () => ({
              data: entities.map((entity) => ({ card_id: entity.card_id })),
            })),
          };
        throw new Error(`Unexpected service call: ${name}`);
      },
    };
    const arrange = registerAndCaptureHandler('agor_boards_auto_arrange_zone', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const parsed = JSON.parse(
      (await arrange({ boardId: 'board-1', zoneId: 'zone-1', columns: 3, strictColumns: true }))
        .content[0].text
    );

    expect(parsed).toMatchObject({
      applied: false,
      arranged: 0,
      requestedColumns: 3,
      columns: 3,
      updates: [],
    });
    expect(parsed.overflowingObjectIds.length).toBeGreaterThan(0);
    expect(parsed.warning).toContain('No positions were changed');
    expect(patch).not.toHaveBeenCalled();
  });

  it('reports a rendered object that cannot physically fit inside its zone', async () => {
    const app = {
      service(name: string) {
        if (name === 'boards')
          return {
            get: vi.fn(async () => ({
              board_id: 'board-1',
              objects: { 'zone-1': { type: 'zone', x: 0, y: 0, width: 620, height: 400 } },
            })),
          };
        if (name === 'board-objects')
          return {
            find: vi.fn(async () => ({
              data: [
                {
                  object_id: 'branch-too-wide',
                  board_id: 'board-1',
                  branch_id: 'branch-1',
                  entity_type: 'branch',
                  position: { x: 0, y: 0 },
                  size: { width: 700, height: 200 },
                  zone_id: 'zone-1',
                  created_at: '2026-06-01T00:00:00.000Z',
                },
              ],
            })),
            patch: vi.fn(async (_id: string, data: unknown) => data),
          };
        if (name === 'branches')
          return { find: vi.fn(async () => ({ data: [{ branch_id: 'branch-1' }] })) };
        throw new Error(`Unexpected service call: ${name}`);
      },
    };
    const arrange = registerAndCaptureHandler('agor_boards_auto_arrange_zone', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const parsed = JSON.parse(
      (await arrange({ boardId: 'board-1', zoneId: 'zone-1' })).content[0].text
    );

    expect(parsed.overflowingObjectIds).toEqual(['branch-too-wide']);
    expect(parsed.warning).toMatch(/larger than the available zone/i);
  });
});

describe('agor_boards_auto_arrange', () => {
  it('uses measured row heights and column widths for mixed worktrees and cards', async () => {
    const patches: Array<{ position: { x: number; y: number } }> = [];
    const entities = [
      {
        object_id: 'branch-1',
        board_id: 'board-1',
        branch_id: 'branch-1',
        entity_type: 'branch' as const,
        position: { x: 0, y: 0 },
        created_at: '2026-06-01T00:00:00.000Z',
      },
      {
        object_id: 'card-1',
        board_id: 'board-1',
        card_id: 'card-1',
        entity_type: 'card' as const,
        position: { x: 600, y: 0 },
        created_at: '2026-06-01T00:00:00.000Z',
      },
      {
        object_id: 'card-2',
        board_id: 'board-1',
        card_id: 'card-2',
        entity_type: 'card' as const,
        position: { x: 0, y: 300 },
        created_at: '2026-06-01T00:00:00.000Z',
      },
    ];
    const app = {
      service(name: string) {
        if (name === 'board-objects')
          return {
            find: vi.fn(async () => ({ data: entities })),
            patch: vi.fn(async (_id: string, data: { position: { x: number; y: number } }) => {
              patches.push(data);
              return data;
            }),
          };
        if (name === 'cards') return { get: vi.fn(async () => ({ title: 'Card' })) };
        throw new Error(`Unexpected service call: ${name}`);
      },
    };
    const arrange = registerAndCaptureHandler('agor_boards_auto_arrange', {
      app,
      userId: 'user-1',
      baseServiceParams: {},
    });

    const parsed = JSON.parse((await arrange({ boardId: 'board-1', columns: 2 })).content[0].text);

    expect(parsed).toMatchObject({ columns: 2, rows: 2 });
    expect(patches.map((update) => update.position)).toEqual([
      { x: 80, y: 80 },
      { x: 620, y: 80 },
      { x: 80, y: 320 },
    ]);
  });

  it('can include canvas annotations and leaves zones fixed', async () => {
    const boardPatches: Array<Record<string, unknown>> = [];
    const app = {
      service(name: string) {
        if (name === 'board-objects')
          return { find: vi.fn(async () => ({ data: [] })), patch: vi.fn() };
        if (name === 'boards')
          return {
            get: vi.fn(async () => ({
              board_id: 'board-1',
              objects: {
                'zone-1': { type: 'zone', x: 0, y: 0, width: 1000, height: 800 },
                'text-1': { type: 'text', x: 20, y: 20, width: 200, height: 100, content: 'Hi' },
                'note-1': { type: 'markdown', x: 300, y: 20, width: 300, content: '# Note' },
              },
            })),
            patch: vi.fn(async (_id: string, data: Record<string, unknown>) => {
              boardPatches.push(data);
              return data;
            }),
          };
        throw new Error(`Unexpected service call: ${name}`);
      },
    };
    const arrange = registerAndCaptureHandler('agor_boards_auto_arrange', {
      app,
      userId: 'user-1',
      baseServiceParams: {},
    });

    const parsed = JSON.parse(
      (await arrange({ boardId: 'board-1', columns: 2, includeCanvasObjects: true })).content[0]
        .text
    );

    expect(parsed).toMatchObject({ arranged: 2, arrangedEntities: 0, arrangedCanvasObjects: 2 });
    expect(boardPatches).toHaveLength(2);
    expect(boardPatches.map((patch) => patch.objectId)).toEqual(['text-1', 'note-1']);
    expect(boardPatches.map((patch) => patch.objectData)).toEqual([
      expect.objectContaining({ x: 80, y: 80 }),
      expect.objectContaining({ x: 320, y: 80 }),
    ]);
  });
});

describe('agor_boards_update realtime events', () => {
  it('replaces the normalized board access and branch-default package', async () => {
    const permissions = {
      primary_owner_user_id: '00000000-0000-7000-8000-000000000001',
      board_access_revision: 1,
      branch_template_revision: 1,
      board_access: {
        schema_version: 1,
        policy_kind: 'board_access',
        sharing_mode: 'private',
        entries: [],
        others: { preset: 'none', capabilities: [], fs_access: 'none' },
      },
      branch_template: {
        access: {
          schema_version: 1,
          policy_kind: 'branch_access',
          sharing_mode: 'private',
          entries: [],
          others: { preset: 'none', capabilities: [], fs_access: 'none' },
        },
        session_sharing: { owner_rules: [] },
      },
    };
    const patch = vi.fn(async (_id, data) => data);
    const app = {
      service(name: string) {
        if (name === 'boards/:id/permissions') return { patch };
        throw new Error(`Unexpected service call: ${name}`);
      },
    };
    const updateBoard = registerAndCaptureHandler('agor_boards_permissions_update', {
      app,
      userId: 'user-1',
      baseServiceParams: {},
    });

    await updateBoard({ boardId: 'board-1', permissions });
    expect(patch).toHaveBeenCalledWith(null, permissions, {
      route: { id: 'board-1' },
    });
  });

  it('emits custom object mutations with a correctly-shaped HookContext', async () => {
    const params = {
      authenticated: true,
      provider: 'mcp',
      tenant: { tenant_id: 'tenant-a', source: 'auth_claim' },
      user: { user_id: 'user-1', role: 'member' },
    };
    const updatedBoard = { board_id: 'board-1', name: 'Board', objects: {} };
    const emit = vi.fn();
    const batchUpsertBoardObjects = vi.fn(async () => updatedBoard);
    const get = vi.fn(async () => updatedBoard);
    const app = {
      service(name: string) {
        if (name === 'boards') return { batchUpsertBoardObjects, get, emit };
        throw new Error(`Unexpected service call: ${name}`);
      },
    };
    const updateBoard = registerAndCaptureHandler('agor_boards_update', {
      app,
      userId: 'user-1',
      baseServiceParams: params,
    });

    await updateBoard({
      boardId: 'board-1',
      upsertObjects: { 'zone-1': { type: 'zone', x: 0, y: 0, width: 100, height: 100 } },
    });

    expect(batchUpsertBoardObjects).toHaveBeenCalledWith('board-1', expect.any(Object), params);
    expect(emit).toHaveBeenCalledWith(
      'patched',
      updatedBoard,
      expect.objectContaining({
        path: 'boards',
        method: 'patch',
        id: 'board-1',
        params: {},
        result: updatedBoard,
      })
    );
  });
});

describe('board icon shortcode handling at MCP boundary', () => {
  const baseServiceParams = {
    authenticated: true,
    provider: 'mcp',
    user: { user_id: 'user-1', role: 'member' },
  };

  it('agor_boards_create returns the repository-normalized icon', async () => {
    const boardsCreate = vi.fn(async (data: Record<string, unknown>) => ({
      board_id: 'board-1',
      name: data.name,
      icon: '🧭',
      created_by: data.created_by,
      created_at: '2026-06-01T00:00:00.000Z',
      last_updated: '2026-06-01T00:00:00.000Z',
      archived: false,
      url: 'http://localhost:5173/ui/b/board-1/',
    }));
    const app = {
      service(name: string) {
        if (name === 'boards') return { create: boardsCreate };
        throw new Error(`Unexpected service call: ${name}`);
      },
    };
    const createBoard = registerAndCaptureHandler('agor_boards_create', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const result = await createBoard({ name: 'Compass Board', icon: ':compass:' });
    const parsed = JSON.parse(result.content[0].text);

    expect(boardsCreate).toHaveBeenCalledWith(
      {
        name: 'Compass Board',
        created_by: 'user-1',
        icon: ':compass:',
      },
      baseServiceParams
    );
    expect(parsed.icon).toBe('🧭');
  });

  it('agor_boards_update returns the repository-normalized icon', async () => {
    const normalizedBoard = {
      board_id: 'board-1',
      name: 'Compass Board',
      icon: '🧭',
      created_by: 'user-1',
      created_at: '2026-06-01T00:00:00.000Z',
      last_updated: '2026-06-01T00:00:00.000Z',
      archived: false,
      url: 'http://localhost:5173/ui/b/board-1/',
    };
    const boardsPatch = vi.fn(async () => normalizedBoard);
    const boardsGet = vi.fn(async () => normalizedBoard);
    const app = {
      service(name: string) {
        if (name === 'boards') return { patch: boardsPatch, get: boardsGet, emit: vi.fn() };
        throw new Error(`Unexpected service call: ${name}`);
      },
    };
    const updateBoard = registerAndCaptureHandler('agor_boards_update', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const result = await updateBoard({ boardId: 'board-1', icon: ':compass:' });
    const parsed = JSON.parse(result.content[0].text);

    expect(boardsPatch).toHaveBeenCalledWith('board-1', { icon: ':compass:' }, baseServiceParams);
    expect(boardsGet).toHaveBeenCalledWith('board-1', baseServiceParams);
    expect(parsed.board.icon).toBe('🧭');
  });
});
