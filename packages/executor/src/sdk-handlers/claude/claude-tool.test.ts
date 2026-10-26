import { generateId, SAFE_ZERO_TURN_PROVIDER_RESULT_MESSAGE } from '@agor/core';
import type { SDKMessage, SDKResultMessage, SDKSystemMessage } from '@agor/core/sdk';
import type { Message, Session, SessionID, TaskID } from '@agor/core/types';
import { MessageRole, withProviderDetail } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { guardTaskModelSelection } from '../../handlers/sdk/task-model-selection.js';
import type { MessagesService } from '../base/index.js';
import { type ProcessedEvent, SDKMessageProcessor } from './message-processor.js';

const promptState = vi.hoisted(() => ({
  events: [] as unknown[],
  onSelected: undefined as ((model?: string) => void) | undefined,
}));

vi.mock('./prompt-service.js', () => ({
  ClaudePromptService: class {
    constructor(
      _messages: unknown,
      private sessions: { findById(id: SessionID): Promise<Session | null> }
    ) {}
    async *promptSessionStreaming(id: SessionID): AsyncGenerator<ProcessedEvent> {
      if (promptState.onSelected)
        promptState.onSelected((await this.sessions.findById(id))?.model_config?.model);
      for (const event of promptState.events) {
        yield event as ProcessedEvent;
      }
    }
  },
}));

import { ClaudeTool } from './claude-tool.js';

const RAW_PROVIDER_BODY = 'provider-secret-body';

type Harness = {
  tool: ClaudeTool;
  outgoing: Partial<Message>[];
  persisted: Message[];
  sessionsRepo: { update: ReturnType<typeof vi.fn> };
};

function createHarness(classifiedKind?: 'missing_credential'): Harness {
  const sessionId = generateId() as SessionID;
  const outgoing: Partial<Message>[] = [];
  const persisted: Message[] = [];
  const messagesService = {
    create: vi.fn(async (data: Partial<Message>) => {
      outgoing.push(data);
      const daemonMessage = {
        ...data,
        ...(classifiedKind && data.metadata?.is_zero_turn_result
          ? {
              type: 'system' as const,
              role: MessageRole.SYSTEM,
              content: 'This session needs to be connected before it can run.',
              content_preview: 'This session needs to be connected before it can run.',
              metadata: { ...data.metadata, error_kind: classifiedKind },
            }
          : {}),
        ...(classifiedKind && data.metadata?.is_provider_failure_result
          ? {
              content: 'This session needs to be connected before it can run.',
              content_preview: 'This session needs to be connected before it can run.',
              metadata: { ...data.metadata, error_kind: classifiedKind },
            }
          : {}),
      } as Message;
      persisted.push(daemonMessage);
      return daemonMessage;
    }),
  } as unknown as MessagesService;

  const messagesRepo = {
    findBySessionId: vi.fn().mockResolvedValue([]),
    findInitialUserMessagesByTaskId: vi.fn().mockResolvedValue([]),
    getNextIndexBySessionId: vi.fn().mockResolvedValue(0),
  };
  const sessionsRepo = {
    findById: vi.fn().mockResolvedValue({ session_id: sessionId }),
    update: vi.fn().mockResolvedValue({ session_id: sessionId }),
  };
  const tasksService = {
    patch: vi.fn().mockResolvedValue(undefined),
    emit: vi.fn(),
  };

  return {
    tool: new ClaudeTool(
      messagesRepo as never,
      sessionsRepo as never,
      '',
      messagesService,
      undefined,
      undefined,
      undefined,
      tasksService as never
    ),
    outgoing,
    persisted,
    sessionsRepo,
  };
}

// Deliberately partial usage: exercise the same closed accounting projection as older SDKs.
function rawResult(subtype: 'success' | 'error_during_execution'): SDKResultMessage {
  return {
    type: 'result' as const,
    subtype,
    duration_ms: 42,
    duration_api_ms: 31,
    is_error: subtype !== 'success',
    num_turns: 1,
    stop_reason: null,
    total_cost_usd: 0.12,
    usage: {
      input_tokens: 10,
      output_tokens: 4,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 3,
    },
    modelUsage: {
      'claude-sonnet-4-6': {
        inputTokens: 10,
        outputTokens: 4,
        cacheCreationInputTokens: 2,
        cacheReadInputTokens: 3,
        contextWindow: 200_000,
      },
    },
    permission_denials: [],
    uuid: generateId(),
    session_id: generateId(),
    ...(subtype === 'success'
      ? { result: RAW_PROVIDER_BODY }
      : { errors: [RAW_PROVIDER_BODY, 'Credit balance is too low'] }),
  } as unknown as SDKResultMessage;
}

function resultEvent(raw: ReturnType<typeof rawResult>): ProcessedEvent {
  return { type: 'result', raw_sdk_message: raw };
}

function synthesizedAssistantEvent(): ProcessedEvent {
  return {
    type: 'complete',
    role: MessageRole.ASSISTANT,
    content: [{ type: 'text', text: RAW_PROVIDER_BODY }],
    isSynthesizedResult: true,
  };
}

async function execute(tool: ClaudeTool, mode: 'streaming' | 'non-streaming', taskId: TaskID) {
  const sessionId = generateId() as SessionID;
  if (mode === 'streaming') {
    return tool.executePromptWithStreaming(sessionId, 'prompt', taskId);
  }
  return tool.executePrompt(sessionId, 'prompt', taskId);
}

describe('ClaudeTool command discovery persistence', () => {
  it('persists filtered commands and skills through the existing session context fields', async () => {
    const processor = new SDKMessageProcessor({ sessionId: generateId() as SessionID });
    const initMessage = {
      type: 'system',
      subtype: 'init',
      slash_commands: ['compact', 'usage', 'doctor'],
      terminal_slash_commands: ['doctor'],
      skills: ['doctor', 'project-review'],
    } satisfies Pick<
      SDKSystemMessage,
      'type' | 'subtype' | 'slash_commands' | 'terminal_slash_commands' | 'skills'
    >;
    promptState.events = await processor.process(initMessage as SDKSystemMessage);
    const harness = createHarness();
    await execute(harness.tool, 'streaming', generateId() as TaskID);
    expect(harness.sessionsRepo.update).toHaveBeenCalledWith(expect.any(String), {
      custom_context: {
        slash_commands: ['compact', 'usage'],
        skills: ['project-review'],
      },
    });
  });
});

describe('ClaudeTool provider-failure settlement', () => {
  beforeEach(() => {
    promptState.events = [];
  });

  describe.each(['streaming', 'non-streaming'] as const)('%s terminal evidence', (mode) => {
    const assistant: ProcessedEvent = {
      type: 'complete',
      role: MessageRole.ASSISTANT,
      content: [{ type: 'text', text: 'Partial model response' }],
    };

    it.each([
      ['empty success', () => [synthesizedAssistantEvent(), resultEvent(rawResult('success'))]],
      [
        'success with error flag',
        () => [assistant, resultEvent({ ...rawResult('success'), is_error: true })],
      ],
      ['EOF before any result', () => []],
      ['EOF after assistant output', () => [assistant]],
      [
        'error after assistant output',
        () => [assistant, resultEvent(rawResult('error_during_execution'))],
      ],
    ] as const)('fails %s without losing persisted model output', async (_name, events) => {
      const harness = createHarness();
      promptState.events = events();
      const result = await execute(harness.tool, mode, generateId() as TaskID);
      expect(result.hadError).toBe(true);
      expect(result.errorDetails?.length).toBeGreaterThan(0);
      if (promptState.events.includes(assistant)) {
        expect(
          harness.persisted.some((message) =>
            JSON.stringify(message.content).includes('Partial model response')
          )
        ).toBe(true);
      }
    });

    it('propagates recorded SDK success/is_error through the real processor without exposing its body', async () => {
      const harness = createHarness();
      const processor = new SDKMessageProcessor({ sessionId: generateId() as SessionID });
      // Synthetic shape from the pinned SDK contract, not a production trace.
      const raw = { ...rawResult('success'), is_error: true, num_turns: 0 };
      promptState.events = await processor.process(raw as never);
      const result = await execute(harness.tool, mode, generateId() as TaskID);
      expect(result.hadError).toBe(true);
      expect(result.rawSdkResponse).toMatchObject({
        subtype: 'success',
        is_error: true,
        num_turns: 0,
      });
      expect(
        harness.persisted.filter((message) => message.metadata?.is_provider_failure_result)
      ).toHaveLength(1);
      expect(JSON.stringify({ outgoing: harness.outgoing, result })).not.toContain(
        RAW_PROVIDER_BODY
      );
    });

    it('accepts a tool-only assistant turn with an explicit successful result', async () => {
      const harness = createHarness();
      promptState.events = [
        { ...assistant, content: [{ type: 'tool_use', id: 'tool-1', name: 'example', input: {} }] },
        resultEvent(rawResult('success')),
      ];
      const result = await execute(harness.tool, mode, generateId() as TaskID);
      expect(result.hadError).toBe(false);
      expect(result.assistantMessageIds).toHaveLength(1);
    });

    it('does not reinterpret an interrupted turn as missing-result failure', async () => {
      const harness = createHarness();
      promptState.events = [assistant, { type: 'stopped' }];
      const result = await execute(harness.tool, mode, generateId() as TaskID);
      expect(result.wasStopped).toBe(true);
      expect(result.hadError).toBe(false);
    });
  });

  it.each(['streaming', 'non-streaming'] as const)(
    'uses the daemon-confirmed assistant message for classified zero-turn %s turns',
    async (mode) => {
      const harness = createHarness('missing_credential');
      const raw = rawResult('success');
      const contextUsage = {
        totalTokens: 123,
        maxTokens: 200_000,
        percentage: 0.0615,
        memoryFiles: [{ path: 'SENTINEL_CLAUDE_MEMORY_PATH' }],
        providerExtension: 'SENTINEL_CLAUDE_CONTEXT_EXTENSION',
      } as unknown as import('@agor/core/sdk').SDKControlGetContextUsageResponse;
      promptState.events = [
        synthesizedAssistantEvent(),
        { type: 'context_usage', contextUsage },
        resultEvent(raw),
      ];

      const result = await execute(harness.tool, mode, generateId() as TaskID);

      expect(harness.persisted.at(-1)).toMatchObject({
        type: 'system',
        role: MessageRole.SYSTEM,
        content: 'This session needs to be connected before it can run.',
        metadata: { error_kind: 'missing_credential' },
      });
      expect(result.rawSdkResponse).not.toHaveProperty('result');
      expect(result.rawSdkResponse).toMatchObject({
        subtype: 'success',
        usage: raw.usage,
        duration_ms: raw.duration_ms,
        total_cost_usd: raw.total_cost_usd,
      });
      expect(result.rawSdkResponse).not.toHaveProperty('modelUsage');
      expect(result.hadError).toBe(true);
      expect(result.errorDetails).toEqual([SAFE_ZERO_TURN_PROVIDER_RESULT_MESSAGE]);
      expect(result.rawContextUsage).toEqual({
        totalTokens: 123,
        maxTokens: 200_000,
        percentage: 0.0615,
      });
      expect(JSON.stringify(result)).not.toContain('SENTINEL_CLAUDE');
      expect(
        JSON.stringify({ outgoing: harness.outgoing, persisted: harness.persisted, result })
      ).not.toContain(RAW_PROVIDER_BODY);
    }
  );

  it.each(['streaming', 'non-streaming'] as const)(
    'keeps daemon-classified non-success %s results safe while preserving accounting',
    async (mode) => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const harness = createHarness('missing_credential');
        const raw = rawResult('error_during_execution');
        promptState.events = [resultEvent(raw)];

        const result = await execute(harness.tool, mode, generateId() as TaskID);

        const persistedFailure = harness.persisted.at(-1);
        expect(persistedFailure).toMatchObject({
          content: 'This session needs to be connected before it can run.',
          metadata: { error_kind: 'missing_credential' },
        });
        expect(harness.outgoing.at(-1)?.content).toEqual([
          {
            type: 'text',
            text: SAFE_ZERO_TURN_PROVIDER_RESULT_MESSAGE,
          },
        ]);
        expect(result.rawSdkResponse).not.toHaveProperty('errors');
        expect(result.rawSdkResponse).toMatchObject({
          subtype: 'error_during_execution',
          usage: raw.usage,
          duration_ms: raw.duration_ms,
          num_turns: raw.num_turns,
          total_cost_usd: raw.total_cost_usd,
        });
        expect(result.rawSdkResponse).not.toHaveProperty('modelUsage');
        expect(result.errorDetails).toEqual([
          withProviderDetail(SAFE_ZERO_TURN_PROVIDER_RESULT_MESSAGE, 'error_during_execution'),
        ]);
        expect(
          JSON.stringify({ outgoing: harness.outgoing, persisted: harness.persisted, result })
        ).not.toContain(RAW_PROVIDER_BODY);
        expect(errorSpy.mock.calls.flat().join(' ')).not.toContain(RAW_PROVIDER_BODY);
        expect(errorSpy.mock.calls.flat().join(' ')).toContain('missing_credential');
      } finally {
        errorSpy.mockRestore();
      }
    }
  );

  it.each(['streaming', 'non-streaming'] as const)(
    'withholds raw diagnostics when the daemon does not classify an executor marker in %s turns',
    async (mode) => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const harness = createHarness();
        const raw = rawResult('error_during_execution');
        promptState.events = [resultEvent(raw)];

        const result = await execute(harness.tool, mode, generateId() as TaskID);

        expect(result.rawSdkResponse).not.toHaveProperty('errors');
        expect(result.rawSdkResponse).toMatchObject({
          subtype: 'error_during_execution',
          usage: raw.usage,
          duration_ms: raw.duration_ms,
          num_turns: raw.num_turns,
          total_cost_usd: raw.total_cost_usd,
        });
        expect(result.rawSdkResponse).not.toHaveProperty('modelUsage');
        expect(result.errorDetails).toEqual([
          withProviderDetail(SAFE_ZERO_TURN_PROVIDER_RESULT_MESSAGE, 'error_during_execution'),
        ]);
        expect(
          JSON.stringify({ outgoing: harness.outgoing, persisted: harness.persisted, result })
        ).not.toContain(RAW_PROVIDER_BODY);
        expect(errorSpy.mock.calls.flat().join(' ')).not.toContain(RAW_PROVIDER_BODY);
      } finally {
        errorSpy.mockRestore();
      }
    }
  );
});

describe('Claude diagnosis propagation', () => {
  it.each(['streaming', 'non-streaming'] as const)(
    'retains one result diagnosis and accounting without granting credential recovery in %s',
    async (mode) => {
      const harness = createHarness();
      const processor = new SDKMessageProcessor({ sessionId: generateId() as SessionID });
      const raw = {
        ...rawResult('error_during_execution'),
        errors: ['Not logged in. Please run /login SECRET'],
      };
      promptState.events = await processor.process(raw as SDKMessage);
      const diagnosed = promptState.events.find(
        (event) => (event as ProcessedEvent).type === 'result'
      ) as Extract<ProcessedEvent, { type: 'result' }>;
      const result = await execute(harness.tool, mode, generateId() as TaskID);
      expect(result.hadError).toBe(true);
      expect(result.errorDetails).toEqual([
        withProviderDetail(diagnosed.failure!.message, 'error_during_execution'),
      ]);
      expect(result.rawSdkResponse).toMatchObject({
        usage: raw.usage,
        total_cost_usd: raw.total_cost_usd,
      });
      expect(harness.outgoing.at(-1)?.metadata?.is_provider_failure_result).toBe(true);
      expect(
        harness.outgoing.some((message) => message.metadata?.is_missing_credential_failure)
      ).toBe(false);
      expect(JSON.stringify({ result, outgoing: harness.outgoing })).not.toContain('SECRET');
    }
  );
});

describe('ClaudeTool task-bound model selection', () => {
  it.each(['streaming', 'non-streaming'] as const)(
    'preserves active %s output and SDK metadata after a next-prompt edit',
    async (mode) => {
      const id = generateId() as SessionID;
      const current = {
        session_id: id,
        model_config: { mode: 'exact', model: 'claude-opus-5-5', updated_at: '' },
      } as Session;
      const outgoing: Partial<Message>[] = [];
      const messages = {
        create: vi.fn(async (data: Partial<Message>) => {
          outgoing.push(data);
          return data as Message;
        }),
      };
      const messagesRepo = {
        findInitialUserMessagesByTaskId: vi.fn(async () => []),
        getNextIndexBySessionId: vi.fn(async () => 0),
      };
      const makeTask = () => {
        const repo = {
          findById: async (_id: SessionID) => current,
          update: vi.fn(async (_id: SessionID, data: Partial<Session>) => {
            Object.assign(current, data);
            return current;
          }),
        };
        guardTaskModelSelection(repo, id, 'claude-code', {
          apiKey: 'synthetic-key',
          source: 'user',
          useNativeAuth: false,
          connection: {},
        });
        return {
          repo,
          tool: new ClaudeTool(
            messagesRepo as never,
            repo as never,
            'synthetic-key',
            messages as never
          ),
        };
      };
      const invoke = (tool: ClaudeTool) =>
        mode === 'streaming'
          ? tool.executePromptWithStreaming(id, 'hello', generateId() as TaskID)
          : tool.executePrompt(id, 'hello', generateId() as TaskID);
      const selected = vi.fn((model?: string) => {
        expect(model).toBe('claude-opus-5-5');
        current.model_config!.model = 'gpt-6-astra';
      });
      promptState.onSelected = selected;
      promptState.events = [
        {
          type: 'complete',
          role: MessageRole.ASSISTANT,
          agentSessionId: 'sdk-existing-turn',
          resolvedModel: 'claude-opus-5-5',
          content: [{ type: 'text', text: 'valid existing turn output' }],
        },
        resultEvent(rawResult('success')),
      ];
      try {
        const task = makeTask();
        await expect(invoke(task.tool)).resolves.toMatchObject({ hadError: false });
        expect(selected).toHaveBeenCalledOnce();
        expect(outgoing.some((m) => m.role === MessageRole.ASSISTANT)).toBe(true);
        expect(task.repo.update).toHaveBeenCalledWith(id, { sdk_session_id: 'sdk-existing-turn' });
        expect((await task.repo.findById(id)).sdk_session_id).toBe('sdk-existing-turn');
        const previous = [...outgoing];
        const assistantCount = outgoing.filter((m) => m.role === MessageRole.ASSISTANT).length;
        // A subsequent Task gets a new repository/guard and must reject the edited
        // selection before its provider starts, without deleting the prior output.
        await expect(invoke(makeTask().tool)).rejects.toThrow('cannot run on a claude-code');
        expect(selected).toHaveBeenCalledOnce();
        expect(outgoing.slice(0, previous.length)).toEqual(previous);
        expect(outgoing.filter((m) => m.role === MessageRole.ASSISTANT)).toHaveLength(
          assistantCount
        );
      } finally {
        promptState.onSelected = undefined;
        promptState.events = [];
      }
    }
  );
});
