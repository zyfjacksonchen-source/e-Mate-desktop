import assert from 'node:assert/strict';
import test from 'node:test';
import type { TenantUser } from '@e-mate/admin-contract';
import { AdminApiError } from '../src/api.ts';
import { policyTargets, reconcilePolicyResults, runPolicyBatch } from '../src/user-policy.ts';

function user(id: string, overrides: Partial<TenantUser> = {}): TenantUser {
  return { schemaVersion: 1, userId: id, displayName: id, roles: ['MEMBER'], status: 'PENDING_APPROVAL',
    tokenLimit: null, allowedModelIds: [], createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z', ...overrides };
}
const draft = { approvePending: true, tokenLimit: 1000, allowedModelIds: ['gpt-5.6-sol'] };

test('approval freezes pending targets and requires explicit available models and quota', () => {
  const input = user('a');
  const targets = policyTargets([input], draft, ['gpt-5.6-sol']);
  input.updatedAt = '2026-09-06T00:00:00.000Z';
  assert.equal(targets[0]?.input.expectedUpdatedAt, '2026-09-05T00:00:00.000Z');
  assert.throws(() => policyTargets([user('a')], { approvePending: true }, []));
  assert.throws(() => policyTargets([user('a')], draft, []));
  assert.throws(() => policyTargets([user('a', { status: 'ACTIVE' })], draft, ['gpt-5.6-sol']));
  assert.throws(() => policyTargets([user('a'), user('a')], draft, ['gpt-5.6-sol']));
  assert.equal(policyTargets([user('a')], { ...draft, tokenLimit: null }, ['gpt-5.6-sol'])[0]?.input.tokenLimit, null);
});

test('ordinary edits independently retain each quota or model policy, including disabled existing grants', () => {
  const users = [user('a', { status: 'ACTIVE', tokenLimit: 2, allowedModelIds: ['disabled-model'] }),
    user('b', { status: 'ACTIVE', tokenLimit: null, allowedModelIds: ['gpt-5.6-sol'] })];
  assert.deepEqual(policyTargets(users, { approvePending: false, tokenLimit: 5 }, []).map(({ input }) => input.allowedModelIds),
    [['disabled-model'], ['gpt-5.6-sol']]);
  assert.deepEqual(policyTargets(users, { approvePending: false, allowedModelIds: ['gpt-5.6-sol'] }, ['gpt-5.6-sol'])
    .map(({ input }) => input.tokenLimit), [2, null]);
});

test('partial saves have at most four in flight and unknown outcomes are read back without overwriting conflicts', async () => {
  const targets = policyTargets(Array.from({ length: 9 }, (_, index) => user(String(index))), draft, ['gpt-5.6-sol']);
  let active = 0;
  let maximum = 0;
  const saved: TenantUser[] = [];
  const calls: string[] = [];
  const results = await runPolicyBatch(targets, async (target) => {
    calls.push(target.user.userId);
    maximum = Math.max(maximum, ++active);
    await new Promise((resolve) => setImmediate(resolve));
    active--;
    if (target.user.userId === '0') throw new AdminApiError(409);
    if (target.user.userId === '1') throw new AdminApiError(400);
    const { expectedUpdatedAt: _expected, ...update } = target.input;
    const next = { ...target.user, ...update, updatedAt: '2026-09-05T00:00:00.001Z' };
    saved.push(next);
    if (target.user.userId === '2') throw new Error('response lost after commit');
    return next;
  }, async () => saved);
  assert.equal(maximum, 4);
  assert.equal(calls.length, 9);
  assert.deepEqual(results.map(({ status }) => status), ['conflict', 'failed', ...Array(7).fill('success')]);
  const retry = results.filter(({ status }) => status === 'failed').map(({ target }) => target);
  assert.deepEqual(retry.map(({ user }) => user.userId), ['1']);
  assert.equal(retry[0]?.input.expectedUpdatedAt, '2026-09-05T00:00:00.000Z');
  const unknown = [{ target: targets[0]!, status: 'unknown' as const }];
  assert.equal((await reconcilePolicyResults(unknown, async () => { throw new Error('offline'); }))[0]?.status, 'unknown');
  assert.equal((await reconcilePolicyResults(unknown, async () => [user('0')]))[0]?.status, 'failed');
  assert.equal((await reconcilePolicyResults(unknown, async () => [user('0', { updatedAt: '2026-09-05T00:00:00.003Z' })]))[0]?.status, 'conflict');
});
