import { parseTenantUserUpdate, type TenantUser, type TenantUserUpdate } from '@e-mate/admin-contract';
import { AdminApiError } from './api.ts';

export type PolicyDraft = { approvePending: boolean; tokenLimit?: number | null; allowedModelIds?: string[] };
export type PolicyTarget = { user: TenantUser; input: TenantUserUpdate };
export type PolicyResult = {
  target: PolicyTarget;
  status: 'success' | 'failed' | 'conflict' | 'unknown';
  user?: TenantUser;
  httpStatus?: number;
};

const sameSet = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((item) => right.includes(item));

export function policyTargets(users: TenantUser[], draft: PolicyDraft, availableModels: string[]): PolicyTarget[] {
  if (!users.length || new Set(users.map((user) => user.userId)).size !== users.length ||
      (draft.approvePending && (draft.tokenLimit === undefined || !draft.allowedModelIds?.length)) ||
      (!draft.approvePending && draft.tokenLimit === undefined && draft.allowedModelIds === undefined)) {
    throw new Error('Invalid user policy selection');
  }
  return users.map((user) => {
    if (user.status === 'DELETED' || (draft.approvePending && user.status !== 'PENDING_APPROVAL')) {
      throw new Error('Invalid user policy status');
    }
    const allowedModelIds = draft.allowedModelIds ?? user.allowedModelIds;
    if (allowedModelIds.some((id) => !availableModels.includes(id) &&
          (draft.approvePending || !user.allowedModelIds.includes(id)))) {
      throw new Error('Invalid user policy model');
    }
    return structuredClone({
      user,
      input: parseTenantUserUpdate({
        schemaVersion: 1, displayName: user.displayName, roles: user.roles,
        status: draft.approvePending ? 'ACTIVE' : user.status,
        tokenLimit: draft.tokenLimit === undefined ? user.tokenLimit : draft.tokenLimit,
        allowedModelIds, expectedUpdatedAt: user.updatedAt,
      }),
    });
  });
}

function matches(user: TenantUser, input: TenantUserUpdate): boolean {
  return user.displayName === input.displayName && sameSet(user.roles, input.roles) &&
    user.status === input.status && user.tokenLimit === input.tokenLimit && sameSet(user.allowedModelIds, input.allowedModelIds);
}

export async function reconcilePolicyResults(results: PolicyResult[], readUsers: () => Promise<TenantUser[]>): Promise<PolicyResult[]> {
  if (!results.some((result) => result.status === 'unknown')) return results;
  let users: TenantUser[];
  try { users = await readUsers(); } catch { return results; }
  return results.map((result) => {
    if (result.status !== 'unknown') return result;
    const user = users.find((value) => value.userId === result.target.user.userId);
    if (user && matches(user, result.target.input)) return { ...result, status: 'success', user };
    if (user?.updatedAt === result.target.input.expectedUpdatedAt) return { ...result, status: 'failed' };
    return { ...result, status: 'conflict' };
  });
}

/** One transaction per user. Targets and versions never change during a retry. */
export async function runPolicyBatch(
  targets: PolicyTarget[],
  writeUser: (target: PolicyTarget) => Promise<TenantUser>,
  readUsers: () => Promise<TenantUser[]>
): Promise<PolicyResult[]> {
  const results: PolicyResult[] = new Array(targets.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, targets.length) }, async () => {
    while (next < targets.length) {
      const index = next++;
      const target = targets[index]!;
      try {
        results[index] = { target, status: 'success', user: await writeUser(target) };
      } catch (error) {
        const httpStatus = error instanceof AdminApiError ? error.status : undefined;
        results[index] = { target, httpStatus,
          status: httpStatus === 409 ? 'conflict' : httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500 ? 'failed' : 'unknown' };
      }
    }
  }));
  return reconcilePolicyResults(results, readUsers);
}
