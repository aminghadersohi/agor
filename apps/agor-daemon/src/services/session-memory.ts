import {
  BranchRepository,
  EntityNotFoundError,
  RepositoryError,
  SessionMemoryRepository,
  SessionReminderRepository,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import { type Application, BadRequest, Conflict, Forbidden, NotFound } from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  Paginated,
  Session,
  SessionMemory,
  SessionMemoryCreateData,
  SessionMemoryPatchData,
  SessionReminder,
  SessionReminderCreateData,
  SessionReminderPatchData,
  SessionReminderStatus,
  UserID,
  UUID,
} from '@agor/core/types';
import {
  hasMinimumRole,
  ROLES,
  SESSION_MEMORY_DEFAULT_LIMIT,
  SESSION_MEMORY_MAX_LIMIT,
  SESSION_MEMORY_MAX_TAG_CHARS,
  SESSION_MEMORY_MAX_TAGS,
  SESSION_MEMORY_MAX_TEXT_BYTES,
  SESSION_MEMORY_MAX_TITLE_CHARS,
  SESSION_REMINDER_DEFAULT_LIMIT,
  SESSION_REMINDER_MAX_HORIZON_MS,
  SESSION_REMINDER_MAX_LIMIT,
  SESSION_REMINDER_MAX_TEXT_BYTES,
  SESSION_REMINDER_MIN_LEAD_MS,
  SESSION_REMINDER_STATUSES,
  SessionMemoryRevisionConflictError,
  SessionReminderRevisionConflictError,
} from '@agor/core/types';

export const SESSION_MEMORIES_SERVICE_TRANSPORT_METHODS = ['find', 'create', 'patch'] as const;
export const SESSION_REMINDERS_SERVICE_TRANSPORT_METHODS = ['find', 'create', 'patch'] as const;

type SessionResourceParams = AuthenticatedParams & {
  query?: Record<string, unknown>;
};

function asInt(value: unknown, fallback: number, max: number, name: string): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(result) || result < 0 || result > max) {
    throw new BadRequest(`${name} must be an integer between 0 and ${max}`);
  }
  return result;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function normalizeText(value: unknown, maxBytes: number, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadRequest(`${name} must contain text`);
  }
  const text = value.trim();
  if (utf8Bytes(text) > maxBytes) {
    throw new BadRequest(`${name} must be at most ${maxBytes} UTF-8 bytes`);
  }
  return text;
}

function normalizeTitle(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new BadRequest('title must be a string');
  const title = value.trim();
  if (title.length > SESSION_MEMORY_MAX_TITLE_CHARS) {
    throw new BadRequest(`title must be at most ${SESSION_MEMORY_MAX_TITLE_CHARS} characters`);
  }
  return title || undefined;
}

function normalizeTags(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((tag) => typeof tag !== 'string')) {
    throw new BadRequest('tags must be an array of strings');
  }
  if (value.length > SESSION_MEMORY_MAX_TAGS) {
    throw new BadRequest(`A memory may have at most ${SESSION_MEMORY_MAX_TAGS} tags`);
  }
  const tags = value.map((tag) => tag.trim().toLowerCase());
  if (tags.some((tag) => !tag || tag.length > SESSION_MEMORY_MAX_TAG_CHARS)) {
    throw new BadRequest(`Each tag must contain 1-${SESSION_MEMORY_MAX_TAG_CHARS} characters`);
  }
  return [...new Set(tags)];
}

function normalizeExpectedRevision(value: unknown): number {
  const revision = Number(value);
  if (!Number.isInteger(revision) || revision < 1) {
    throw new BadRequest('expected_revision must be a positive integer');
  }
  return revision;
}

export function normalizeReminderInstant(
  value: unknown,
  now = Date.now(),
  enforceWindow = true
): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?Z$/.test(value)
  ) {
    throw new BadRequest('due_at must be an unambiguous ISO 8601 UTC instant ending in Z');
  }
  const due = Date.parse(value);
  if (!Number.isFinite(due)) throw new BadRequest('due_at is not a valid UTC instant');
  if (enforceWindow && due < now + SESSION_REMINDER_MIN_LEAD_MS) {
    throw new BadRequest(
      `due_at must be at least ${SESSION_REMINDER_MIN_LEAD_MS / 1000} seconds in the future`
    );
  }
  if (enforceWindow && due > now + SESSION_REMINDER_MAX_HORIZON_MS) {
    throw new BadRequest('due_at must be no more than one year in the future');
  }
  return new Date(due).toISOString();
}

export function normalizeDisplayTimezone(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new BadRequest('display_timezone must be an IANA timezone');
  }
  const timezone = value.trim();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0);
  } catch {
    throw new BadRequest('display_timezone must be a recognized IANA timezone');
  }
  return timezone;
}

class SessionResourceAuthorizer {
  private readonly branches: BranchRepository;

  constructor(
    db: TenantScopeAwareDatabase,
    private readonly app: Application
  ) {
    this.branches = new BranchRepository(db);
  }

  async view(sessionId: string, params?: SessionResourceParams): Promise<Session> {
    if (!sessionId) throw new BadRequest('session_id is required');
    try {
      return await this.app.service('sessions').get(sessionId, params);
    } catch {
      // Do not distinguish foreign, inaccessible, and nonexistent parents.
      throw new NotFound('Session-scoped resource not found');
    }
  }

  async mutate(
    sessionId: string,
    params?: SessionResourceParams,
    options: { denyArchivedForMcp?: boolean; denyArchived?: boolean } = {}
  ): Promise<Session> {
    const session = await this.view(sessionId, params);
    if (
      (options.denyArchived || (options.denyArchivedForMcp && params?.provider === 'mcp')) &&
      session.archived
    ) {
      throw new Conflict('Archived Sessions cannot mutate this resource until restored');
    }
    const user = params?.user;
    if (!user?.user_id) throw new Forbidden('Authenticated user identity is required');
    if (user._isServiceAccount || hasMinimumRole(user.role, ROLES.ADMIN)) return session;
    const authority = await this.branches.resolveSessionPromptAuthority(
      session.branch_id,
      user.user_id as UUID,
      session.created_by as UUID,
      session.sdk_home_scope
    );
    if (!authority.allowed) throw new Forbidden('Prompt authority on this Session is required');
    return session;
  }
}

export class SessionMemoriesService {
  private readonly repository: SessionMemoryRepository;
  private readonly authorize: SessionResourceAuthorizer;

  constructor(db: TenantScopeAwareDatabase, app: Application) {
    this.repository = new SessionMemoryRepository(db);
    this.authorize = new SessionResourceAuthorizer(db, app);
  }

  async find(params?: SessionResourceParams): Promise<Paginated<SessionMemory>> {
    const query = params?.query ?? {};
    const session = await this.authorize.view(String(query.session_id ?? ''), params);
    const limit = asInt(
      query.$limit,
      SESSION_MEMORY_DEFAULT_LIMIT,
      SESSION_MEMORY_MAX_LIMIT,
      '$limit'
    );
    if (limit < 1) throw new BadRequest('$limit must be at least 1');
    const skip = asInt(query.$skip, 0, 5_000, '$skip');
    const search = query.search;
    if (search !== undefined && typeof search !== 'string') {
      throw new BadRequest('search must be a string');
    }
    const archived = query.archived;
    if (archived !== undefined && typeof archived !== 'boolean') {
      throw new BadRequest('archived must be a boolean');
    }
    const page = await this.repository.findPage({
      session_id: session.session_id,
      archived,
      search: search as string | undefined,
      limit,
      skip,
    });
    return { ...page, limit, skip };
  }

  async create(
    data: SessionMemoryCreateData,
    params?: SessionResourceParams
  ): Promise<SessionMemory> {
    const session = await this.authorize.mutate(String(data.session_id ?? ''), params, {
      denyArchivedForMcp: true,
    });
    const createdBy = params?.user?.user_id as UserID | undefined;
    if (!createdBy) throw new Forbidden('Authenticated user identity is required');
    try {
      return await this.repository.create({
        session_id: session.session_id,
        title: normalizeTitle(data.title),
        text: normalizeText(data.text, SESSION_MEMORY_MAX_TEXT_BYTES, 'text'),
        tags: normalizeTags(data.tags),
        created_by: createdBy,
      });
    } catch (error) {
      if (error instanceof EntityNotFoundError)
        throw new NotFound('Session-scoped resource not found');
      if (error instanceof RepositoryError) throw new Conflict(error.message);
      throw error;
    }
  }

  async patch(
    id: string,
    data: SessionMemoryPatchData,
    params?: SessionResourceParams
  ): Promise<SessionMemory> {
    const session = await this.authorize.mutate(String(data.session_id ?? ''), params, {
      denyArchivedForMcp: true,
    });
    if (!id) throw new BadRequest('memory id is required');
    const patch: Parameters<SessionMemoryRepository['updateInSession']>[3] = {};
    if (data.title !== undefined) patch.title = normalizeTitle(data.title) ?? null;
    if (data.text !== undefined) {
      patch.text = normalizeText(data.text, SESSION_MEMORY_MAX_TEXT_BYTES, 'text');
    }
    if (data.tags !== undefined) patch.tags = normalizeTags(data.tags);
    if (data.archived !== undefined) patch.archived = Boolean(data.archived);
    if (Object.keys(patch).length === 0) throw new BadRequest('No memory changes were supplied');
    try {
      return await this.repository.updateInSession(
        session.session_id,
        id,
        normalizeExpectedRevision(data.expected_revision),
        patch
      );
    } catch (error) {
      if (error instanceof SessionMemoryRevisionConflictError) throw new Conflict(error.message);
      if (error instanceof EntityNotFoundError)
        throw new NotFound('Session-scoped resource not found');
      throw error;
    }
  }
}

export class SessionRemindersService {
  private readonly repository: SessionReminderRepository;
  private readonly authorize: SessionResourceAuthorizer;

  constructor(db: TenantScopeAwareDatabase, app: Application) {
    this.repository = new SessionReminderRepository(db);
    this.authorize = new SessionResourceAuthorizer(db, app);
  }

  async find(params?: SessionResourceParams): Promise<Paginated<SessionReminder>> {
    const query = params?.query ?? {};
    const session = await this.authorize.view(String(query.session_id ?? ''), params);
    const limit = asInt(
      query.$limit,
      SESSION_REMINDER_DEFAULT_LIMIT,
      SESSION_REMINDER_MAX_LIMIT,
      '$limit'
    );
    if (limit < 1) throw new BadRequest('$limit must be at least 1');
    const skip = asInt(query.$skip, 0, 5_000, '$skip');
    const rawStatus = query.status;
    const statuses =
      rawStatus === undefined ? undefined : Array.isArray(rawStatus) ? rawStatus : [rawStatus];
    if (
      statuses?.some(
        (status) => !SESSION_REMINDER_STATUSES.includes(status as SessionReminderStatus)
      )
    ) {
      throw new BadRequest('status is not a supported reminder state');
    }
    const page = await this.repository.findPage({
      session_id: session.session_id,
      statuses: statuses as SessionReminderStatus[] | undefined,
      limit,
      skip,
    });
    return { ...page, limit, skip };
  }

  async create(
    data: SessionReminderCreateData,
    params?: SessionResourceParams
  ): Promise<SessionReminder> {
    const session = await this.authorize.mutate(String(data.session_id ?? ''), params, {
      denyArchived: true,
    });
    const createdBy = params?.user?.user_id as UserID | undefined;
    if (!createdBy) throw new Forbidden('Authenticated user identity is required');
    try {
      return await this.repository.create({
        session_id: session.session_id,
        text: normalizeText(data.text, SESSION_REMINDER_MAX_TEXT_BYTES, 'text'),
        due_at: normalizeReminderInstant(data.due_at),
        display_timezone: normalizeDisplayTimezone(data.display_timezone),
        created_by: createdBy,
      });
    } catch (error) {
      if (error instanceof EntityNotFoundError)
        throw new NotFound('Session-scoped resource not found');
      if (error instanceof RepositoryError) throw new Conflict(error.message);
      throw error;
    }
  }

  async patch(
    id: string,
    data: SessionReminderPatchData,
    params?: SessionResourceParams
  ): Promise<SessionReminder> {
    const session = await this.authorize.mutate(String(data.session_id ?? ''), params, {
      denyArchivedForMcp: true,
    });
    if (!id) throw new BadRequest('reminder id is required');
    const patch: Parameters<SessionReminderRepository['updateScheduledInSession']>[3] = {};
    if (data.cancel === true) patch.cancel = true;
    if (data.text !== undefined) {
      patch.text = normalizeText(data.text, SESSION_REMINDER_MAX_TEXT_BYTES, 'text');
    }
    if (data.due_at !== undefined) patch.due_at = normalizeReminderInstant(data.due_at);
    if (data.display_timezone !== undefined) {
      patch.display_timezone = normalizeDisplayTimezone(data.display_timezone);
    }
    if (Object.keys(patch).length === 0) throw new BadRequest('No reminder changes were supplied');
    if (patch.cancel && Object.keys(patch).length > 1) {
      throw new BadRequest('Cancellation cannot be combined with reminder edits');
    }
    try {
      const result = await this.repository.updateScheduledInSession(
        session.session_id,
        id,
        normalizeExpectedRevision(data.expected_revision),
        patch
      );
      return result;
    } catch (error) {
      if (error instanceof SessionReminderRevisionConflictError) throw new Conflict(error.message);
      if (error instanceof EntityNotFoundError)
        throw new NotFound('Session-scoped resource not found');
      throw error;
    }
  }
}

export function createSessionMemoriesService(db: TenantScopeAwareDatabase, app: Application) {
  return new SessionMemoriesService(db, app);
}

export function createSessionRemindersService(db: TenantScopeAwareDatabase, app: Application) {
  return new SessionRemindersService(db, app);
}
