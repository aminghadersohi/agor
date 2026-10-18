import {
  BranchRepository,
  generateId,
  RepoRepository,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import type { BranchID, UUID } from '@agor/core/types';

export async function channelData(db: TenantScopeAwareDatabase, withOpenCodeDefault = false) {
  const owner = await new UsersRepository(db).create({
    email: `gateway-owner-${generateId()}@example.com`,
    name: 'Gateway owner',
    ...(withOpenCodeDefault
      ? {
          default_agentic_config: {
            opencode: {
              modelConfig: {
                mode: 'exact' as const,
                provider: 'openai',
                model: 'gpt-test',
              },
            },
          },
        }
      : {}),
  });
  const repo = await new RepoRepository(db).create({
    repo_id: generateId(),
    slug: `gateway-channel-${generateId()}`,
    name: 'Gateway channel test repo',
    repo_type: 'remote',
    remote_url: 'https://github.com/test/repo.git',
    local_path: `/tmp/${generateId()}`,
    default_branch: 'main',
  });
  const branch = await new BranchRepository(db).create({
    branch_id: generateId() as BranchID,
    repo_id: repo.repo_id as UUID,
    name: 'gateway-channel-test',
    ref: 'gateway-channel-test',
    branch_unique_id: Math.floor(Math.random() * 1_000_000),
    path: `/tmp/${generateId()}`,
    base_ref: 'main',
    new_branch: false,
    created_by: owner.user_id,
  });
  const data = {
    name: 'OpenCode channel',
    channel_type: 'slack' as const,
    target_branch_id: branch.branch_id,
    agor_user_id: owner.user_id,
    config: {},
    agentic_config: { agent: 'opencode' as const },
    enabled: false,
  };
  return { data, owner };
}
