/**
 * Branch file browser/editor. Tenant filesystem access is delegated to the executor.
 */
import {
  type BranchRepository,
  requireCurrentTenantId,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import { type Application, Forbidden, NotAuthenticated } from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  FileDetail,
  FileListItem,
  FilePatchData,
  Id,
  QueryParams,
  RBACParams,
  ServiceMethods,
  UUID,
} from '@agor/core/types';
import { ROLES } from '@agor/core/types';
import { ensureMinimumRole } from '../utils/authorization';
import { isSuperAdmin } from '../utils/branch-authorization.js';
import { resolveDelegatedExecutionHomeKey } from '../utils/executor-delegated-home.js';
import { getDaemonUrl, requestExecutor } from '../utils/spawn-executor.js';
import { issueExecutorCommandToken } from './session-token-service.js';

export type FileParams = QueryParams<{ branch_id?: string }> & Partial<AuthenticatedParams>;

function extractFiles(data: unknown): FileListItem[] {
  if (!data || typeof data !== 'object') return [];
  const files = (data as { files?: unknown }).files;
  return Array.isArray(files) ? (files as FileListItem[]) : [];
}

function extractFile(data: unknown): FileDetail | null {
  if (!data || typeof data !== 'object') return null;
  const file = (data as { file?: unknown }).file;
  return file && typeof file === 'object' ? (file as FileDetail) : null;
}

export class FileService
  implements
    Pick<ServiceMethods<FileListItem | FileDetail>, 'find' | 'get' | 'patch' | 'setup' | 'teardown'>
{
  constructor(
    private branchRepo: BranchRepository,
    private db: TenantScopeAwareDatabase,
    private app: Application
  ) {}

  async find(params?: FileParams): Promise<FileListItem[]> {
    ensureMinimumRole(params, ROLES.MEMBER, 'list files');
    const branchId = params?.query?.branch_id;
    if (!branchId) throw new Error('branch_id query parameter is required');
    const resolved = await this.resolveBranchRead(branchId, params);

    const result = await this.runCommand(
      'branch.files.browse',
      resolved.branchId,
      resolved.userId,
      resolved.delegatedHomeKey
    );
    if (!result.success) {
      throw new Error(
        `Failed to browse files: ${result.error?.message ?? 'unknown executor error'}`
      );
    }
    return extractFiles(result.data);
  }

  async get(id: Id, params?: FileParams): Promise<FileDetail> {
    ensureMinimumRole(params, ROLES.MEMBER, 'read file');
    const branchId = params?.query?.branch_id;
    if (!branchId) throw new Error('branch_id query parameter is required');
    const resolved = await this.resolveBranchRead(branchId, params);

    const result = await this.runCommand(
      'branch.files.read',
      resolved.branchId,
      resolved.userId,
      resolved.delegatedHomeKey,
      {
        filePath: id.toString(),
      }
    );
    if (!result.success) {
      throw new Error(`Failed to read file: ${result.error?.message ?? 'unknown executor error'}`);
    }
    const file = extractFile(result.data);
    if (!file) throw new Error('Failed to read file: executor returned an invalid response');
    return file;
  }

  async patch(id: Id, data: FilePatchData, params?: FileParams): Promise<FileDetail> {
    ensureMinimumRole(params, ROLES.MEMBER, 'edit file');
    const branchId = params?.query?.branch_id;
    if (!branchId) throw new Error('branch_id query parameter is required');
    if (typeof data?.content !== 'string' || typeof data?.expectedLastModified !== 'string') {
      throw new Error('content and expectedLastModified are required');
    }
    const resolved = await this.resolveBranchWrite(branchId, params);
    const result = await this.runCommand(
      'branch.files.write',
      resolved.branchId,
      resolved.userId,
      resolved.delegatedHomeKey,
      {
        filePath: id.toString(),
        content: data.content,
        expectedLastModified: data.expectedLastModified,
      }
    );
    if (!result.success) {
      throw new Error(`Failed to save file: ${result.error?.message ?? 'unknown executor error'}`);
    }
    const file = extractFile(result.data);
    if (!file) throw new Error('Failed to save file: executor returned an invalid response');
    return file;
  }

  private async runCommand(
    command: 'branch.files.browse' | 'branch.files.read' | 'branch.files.write',
    branchId: string,
    userId: string,
    delegatedHomeKey?: string,
    extraParams: Record<string, unknown> = {}
  ) {
    const sessionToken = await issueExecutorCommandToken(this.app, command, userId, branchId);
    return requestExecutor(
      {
        command,
        sessionToken,
        daemonUrl: getDaemonUrl(),
        params: { branchId, ...extraParams },
      },
      {
        logPrefix: `[FileService ${branchId}]`,
        delegatedHomeKey: delegatedHomeKey,
      }
    );
  }

  private async resolveBranchRead(branchId: string, params?: FileParams) {
    const tenantId = requireCurrentTenantId(
      'Missing active tenant context for file database access'
    );
    return runWithTenantDatabaseScope(this.db, tenantId, async () => {
      const cachedBranch = (params as Partial<RBACParams> | undefined)?.branch;
      const branch =
        cachedBranch?.branch_id === branchId
          ? cachedBranch
          : await this.branchRepo.findById(branchId);
      if (!branch) throw new Error(`Branch not found: ${branchId}`);
      const userId = params?.user?.user_id;
      if (!userId) throw new NotAuthenticated('Authentication required');
      const delegatedHomeKey = await resolveDelegatedExecutionHomeKey(
        this.db,
        userId,
        this.app.get('config')
      );
      return { branchId: branch.branch_id, delegatedHomeKey, userId };
    });
  }

  private async resolveBranchWrite(branchId: string, params?: FileParams) {
    const tenantId = requireCurrentTenantId(
      'Missing active tenant context for file database access'
    );
    return runWithTenantDatabaseScope(this.db, tenantId, async () => {
      const cachedBranch = (params as Partial<RBACParams> | undefined)?.branch;
      const branch =
        cachedBranch?.branch_id === branchId
          ? cachedBranch
          : await this.branchRepo.findById(branchId);
      if (!branch) throw new Error(`Branch not found: ${branchId}`);
      const userId = params?.user?.user_id;
      if (!userId) throw new NotAuthenticated('Authentication required');

      const config = this.app.get('config');
      if (
        params?.provider &&
        !params.user?._isServiceAccount &&
        config.execution?.branch_rbac === true &&
        !isSuperAdmin(params.user?.role, config.execution?.allow_superadmin === true)
      ) {
        const access = await this.branchRepo.resolveUserAccess(branch, userId as UUID);
        if (access.fs_access !== 'write') {
          throw new Forbidden('You need write filesystem access to edit this branch');
        }
      }

      const delegatedHomeKey = await resolveDelegatedExecutionHomeKey(this.db, userId, config);
      return { branchId: branch.branch_id, delegatedHomeKey, userId };
    });
  }

  async setup(): Promise<void> {}
  async teardown(): Promise<void> {}
}

export function createFileService(
  branchRepo: BranchRepository,
  db: TenantScopeAwareDatabase,
  app: Application
): FileService {
  return new FileService(branchRepo, db, app);
}
