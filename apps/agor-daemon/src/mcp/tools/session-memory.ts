import {
  SESSION_MEMORY_MAX_TAG_CHARS,
  SESSION_MEMORY_MAX_TAGS,
  SESSION_MEMORY_MAX_TEXT_BYTES,
  SESSION_MEMORY_MAX_TITLE_CHARS,
  SESSION_REMINDER_MAX_TEXT_BYTES,
} from '@agor/core/types';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { McpContext } from '../server.js';
import { sessionContextRequiredResult, textResult } from '../server.js';

function currentSessionId(ctx: McpContext) {
  return ctx.sessionId ?? ctx.authenticatedSession?.session_id;
}

function requireCurrentSession(ctx: McpContext) {
  const sessionId = currentSessionId(ctx);
  if (!sessionId) return null;
  return sessionId;
}

const memoryId = z.string().uuid().describe('Memory ID returned by a Session memory tool.');
const reminderId = z.string().uuid().describe('Reminder ID returned by a Session reminder tool.');
const expectedRevision = z.number().int().positive();
const memoryText = z
  .string()
  .min(1)
  .max(SESSION_MEMORY_MAX_TEXT_BYTES)
  .describe('Durable working note. Do not store credentials, tokens, or other secrets.');
const reminderText = z
  .string()
  .min(1)
  .max(SESSION_REMINDER_MAX_TEXT_BYTES)
  .describe('What this same Session should be prompted to do when the reminder becomes due.');
const title = z.string().max(SESSION_MEMORY_MAX_TITLE_CHARS).optional();
const tags = z
  .array(z.string().min(1).max(SESSION_MEMORY_MAX_TAG_CHARS))
  .max(SESSION_MEMORY_MAX_TAGS)
  .optional();

export function registerSessionMemoryTools(server: McpServer, ctx: McpContext): void {
  server.registerTool(
    'agor_session_memory_create',
    {
      description:
        'Remember a fact or decision privately for this exact Agor Session. It is durable across restart and compaction but is not shared Knowledge. Never store secrets; promotion to Knowledge is a separate explicit action.',
      inputSchema: z.strictObject({ title, text: memoryText, tags }),
    },
    async (args) => {
      const sessionId = requireCurrentSession(ctx);
      if (!sessionId) return sessionContextRequiredResult();
      return textResult(
        await ctx.app
          .service('session-memories')
          .create(
            { session_id: sessionId, title: args.title, text: args.text, tags: args.tags },
            ctx.baseServiceParams
          )
      );
    }
  );

  const registerMemoryList = (name: string, searchOnly: boolean) =>
    server.registerTool(
      name,
      {
        description: searchOnly
          ? 'Search bounded durable working memory for this exact Session. Results never include other Sessions, even on the same branch.'
          : 'List recent durable working memories for this exact Session. Use search rather than loading all memory into context.',
        annotations: { readOnlyHint: true },
        inputSchema: z.strictObject({
          ...(searchOnly ? { query: z.string().min(1).max(256) } : {}),
          includeArchived: z.boolean().optional().default(false),
          limit: z.number().int().min(1).max(100).optional().default(25),
          offset: z.number().int().min(0).max(5000).optional().default(0),
        }),
      },
      async (args: Record<string, unknown>) => {
        const sessionId = requireCurrentSession(ctx);
        if (!sessionId) return sessionContextRequiredResult();
        const result = await ctx.app.service('session-memories').find({
          query: {
            session_id: sessionId,
            archived: args.includeArchived ? undefined : false,
            search: args.query,
            $limit: args.limit,
            $skip: args.offset,
          },
          ...ctx.baseServiceParams,
        });
        return textResult(result);
      }
    );
  registerMemoryList('agor_session_memory_list', false);
  registerMemoryList('agor_session_memory_search', true);

  server.registerTool(
    'agor_session_memory_update',
    {
      description:
        'Update one memory in this exact Session using its revision. A conflict means it changed in another tab; list again before retrying.',
      inputSchema: z.strictObject({
        memoryId,
        expectedRevision,
        title: z.string().max(SESSION_MEMORY_MAX_TITLE_CHARS).nullable().optional(),
        text: memoryText.optional(),
        tags,
      }),
    },
    async (args) => {
      const sessionId = requireCurrentSession(ctx);
      if (!sessionId) return sessionContextRequiredResult();
      return textResult(
        await ctx.app.service('session-memories').patch(
          args.memoryId,
          {
            session_id: sessionId,
            expected_revision: args.expectedRevision,
            title: args.title,
            text: args.text,
            tags: args.tags,
          },
          ctx.baseServiceParams
        )
      );
    }
  );

  server.registerTool(
    'agor_session_memory_archive',
    {
      description: 'Soft-archive one memory in this exact Session using revision/CAS.',
      inputSchema: z.strictObject({ memoryId, expectedRevision }),
    },
    async (args) => {
      const sessionId = requireCurrentSession(ctx);
      if (!sessionId) return sessionContextRequiredResult();
      return textResult(
        await ctx.app
          .service('session-memories')
          .patch(
            args.memoryId,
            { session_id: sessionId, expected_revision: args.expectedRevision, archived: true },
            ctx.baseServiceParams
          )
      );
    }
  );

  server.registerTool(
    'agor_session_reminders_create',
    {
      description:
        'Create a one-shot reminder that queues a structured prompt onto this same Session. Use an exact UTC instant ending in Z and an IANA display timezone. The Session branch/worktree must remain executable.',
      inputSchema: z.strictObject({
        text: reminderText,
        dueAtUtc: z.string().min(1).describe('Unambiguous ISO 8601 UTC instant ending in Z.'),
        displayTimezone: z.string().min(1).max(128).describe('IANA timezone, for display only.'),
      }),
    },
    async (args) => {
      const sessionId = requireCurrentSession(ctx);
      if (!sessionId) return sessionContextRequiredResult();
      return textResult(
        await ctx.app.service('session-reminders').create(
          {
            session_id: sessionId,
            text: args.text,
            due_at: args.dueAtUtc,
            display_timezone: args.displayTimezone,
          },
          ctx.baseServiceParams
        )
      );
    }
  );

  server.registerTool(
    'agor_session_reminders_list',
    {
      description: 'List bounded upcoming and past one-shot reminders for this exact Session.',
      annotations: { readOnlyHint: true },
      inputSchema: z.strictObject({
        limit: z.number().int().min(1).max(100).optional().default(50),
        offset: z.number().int().min(0).max(5000).optional().default(0),
      }),
    },
    async (args) => {
      const sessionId = requireCurrentSession(ctx);
      if (!sessionId) return sessionContextRequiredResult();
      return textResult(
        await ctx.app.service('session-reminders').find({
          query: { session_id: sessionId, $limit: args.limit, $skip: args.offset },
          ...ctx.baseServiceParams,
        })
      );
    }
  );

  server.registerTool(
    'agor_session_reminders_update',
    {
      description:
        'Edit a scheduled reminder for this exact Session. It becomes immutable once a worker claims it.',
      inputSchema: z.strictObject({
        reminderId,
        expectedRevision,
        text: reminderText.optional(),
        dueAtUtc: z.string().min(1).optional(),
        displayTimezone: z.string().min(1).max(128).optional(),
      }),
    },
    async (args) => {
      const sessionId = requireCurrentSession(ctx);
      if (!sessionId) return sessionContextRequiredResult();
      return textResult(
        await ctx.app.service('session-reminders').patch(
          args.reminderId,
          {
            session_id: sessionId,
            expected_revision: args.expectedRevision,
            text: args.text,
            due_at: args.dueAtUtc,
            display_timezone: args.displayTimezone,
          },
          ctx.baseServiceParams
        )
      );
    }
  );

  server.registerTool(
    'agor_session_reminders_cancel',
    {
      description:
        'Cancel a scheduled reminder for this exact Session. Claimed or queued reminders are immutable.',
      inputSchema: z.strictObject({ reminderId, expectedRevision }),
    },
    async (args) => {
      const sessionId = requireCurrentSession(ctx);
      if (!sessionId) return sessionContextRequiredResult();
      return textResult(
        await ctx.app
          .service('session-reminders')
          .patch(
            args.reminderId,
            { session_id: sessionId, expected_revision: args.expectedRevision, cancel: true },
            ctx.baseServiceParams
          )
      );
    }
  );
}
