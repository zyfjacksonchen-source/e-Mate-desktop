import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { TASK_SCENARIOS } from '@e-mate/monitoring-contract';
import { openPostgresAdminManagementStore } from '../../analytics-api/src/admin-management.ts';
import type { RuntimeRegistryPrincipal } from '../../analytics-api/src/runtime-registry.ts';
import {
  InvocationAdmissionError,
  PostgresTenantModelRoutePolicy,
  PostgresUsageStore,
  type AuditUsageRecord,
  type InvocationFact,
  type ModelGatewayPrincipal,
  type UsageFact,
} from '../src/index.ts';

const databaseUrl = process.env.E_MATE_TEST_POSTGRES_URL;
const limits = {
  tenantRequestsPerMinute: 10_000,
  tenantBurst: 10_000,
  tenantMaxConcurrent: 100,
  invocationLeaseMs: 180_000,
};

function pool(): Pool {
  return new Pool({
    connectionString: databaseUrl,
    max: 10,
    connectionTimeoutMillis: 5_000,
  });
}

async function createActiveTestUsers(
  database: Pool,
  users: Array<{ tenantId: string; userId: string; tokenLimit?: number | null }>
): Promise<void> {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('e-mate-test-tenant-user-schema'))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS e_mate_tenant_user (
        tenant_id text NOT NULL,
        user_id text NOT NULL,
        display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 120),
        roles text[] NOT NULL,
        status text NOT NULL CHECK (status IN ('ACTIVE', 'SUSPENDED', 'DELETED')),
        token_limit bigint CHECK (token_limit BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, user_id),
        CHECK (roles <@ ARRAY['TENANT_ADMIN', 'AUDIT_ADMIN', 'MEMBER']::text[]),
        CHECK (cardinality(roles) BETWEEN 1 AND 3)
      );
      ALTER TABLE e_mate_tenant_user
        ADD COLUMN IF NOT EXISTS token_limit bigint;
      ALTER TABLE e_mate_tenant_user
        ADD COLUMN IF NOT EXISTS allowed_model_ids text[] NOT NULL DEFAULT ARRAY[]::text[];
      ALTER TABLE e_mate_tenant_user
        DROP CONSTRAINT IF EXISTS e_mate_tenant_user_status_check;
      ALTER TABLE e_mate_tenant_user
        ADD CONSTRAINT e_mate_tenant_user_status_check
        CHECK (status IN ('ACTIVE', 'SUSPENDED', 'DELETED'));
      ALTER TABLE e_mate_tenant_user
        DROP CONSTRAINT IF EXISTS e_mate_tenant_user_token_limit_check;
      ALTER TABLE e_mate_tenant_user
        ADD CONSTRAINT e_mate_tenant_user_token_limit_check
        CHECK (token_limit BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER});
    `);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  await Promise.all(
    users.map(({ tenantId, userId, tokenLimit = null }) =>
      database.query(
        `
        INSERT INTO e_mate_tenant_user (
          tenant_id, user_id, display_name, roles, status, token_limit
        )
        VALUES ($1,$2,$2,ARRAY['MEMBER']::text[],'ACTIVE',$3)
        ON CONFLICT (tenant_id, user_id) DO UPDATE
          SET status = 'ACTIVE', token_limit = EXCLUDED.token_limit, updated_at = now()
      `,
        [tenantId, userId, tokenLimit]
      )
    )
  );
}

test('activeModelIds preserves signed order, returns empty for no active row, and rejects invalid/failing DB reads', async () => {
  let response: { rows: Array<{ model_ids: unknown }> } | Error = { rows: [{ model_ids: ['gpt-5.6-sol'] }] };
  const calls: unknown[][] = [];
  const store = new PostgresUsageStore({
    query: async (_statement: string, parameters: unknown[]) => {
      calls.push(parameters);
      if (response instanceof Error) throw response;
      return response;
    },
  } as never, limits);
  const principal = { tenantId: 'tenant-a', userId: 'user-a', modelIds: ['gpt-5.6-luna', 'gpt-5.6-sol'] };

  assert.deepEqual(await store.activeModelIds(principal, ['gpt-5.6-luna', 'gpt-5.6-sol']), ['gpt-5.6-sol']);
  assert.deepEqual(calls, [['tenant-a', 'user-a', ['gpt-5.6-luna', 'gpt-5.6-sol']]]);
  response = { rows: [] };
  assert.deepEqual(await store.activeModelIds(principal, ['gpt-5.6-luna']), []);
  response = { rows: [{ model_ids: ['outside-signed-scope'] }] };
  await assert.rejects(store.activeModelIds(principal, ['gpt-5.6-luna']), /User model policy was unavailable/);
  response = { rows: [{ model_ids: ['gpt-5.6-luna', 'gpt-5.6-luna'] }] };
  await assert.rejects(store.activeModelIds(principal, ['gpt-5.6-luna']), /User model policy was unavailable/);
  response = new Error('database unavailable');
  await assert.rejects(store.activeModelIds(principal, ['gpt-5.6-luna']), /database unavailable/);
});

test(
  'real PostgreSQL applies active model-list changes to fresh reads without expanding caller scope',
  { skip: databaseUrl ? false : 'E_MATE_TEST_POSTGRES_URL is not set' },
  async () => {
    const suffix = randomUUID();
    const tenantId = `model-scope-${suffix}`;
    const userId = `user-${suffix}`;
    const database = pool();
    const principal: ModelGatewayPrincipal = {
      tenantId, userId, modelIds: ['gpt-5.6-luna', 'gpt-5.6-sol'],
    };
    try {
      await createActiveTestUsers(database, [{ tenantId, userId }]);
      await database.query(
        'UPDATE e_mate_tenant_user SET allowed_model_ids = $3 WHERE tenant_id = $1 AND user_id = $2',
        [tenantId, userId, ['gpt-5.6-luna', 'gpt-5.6-sol']]
      );
      const store = new PostgresUsageStore(database, limits);
      assert.deepEqual(
        await store.activeModelIds(principal, ['gpt-5.6-sol', 'gpt-5.6-luna']),
        ['gpt-5.6-sol', 'gpt-5.6-luna']
      );

      await database.query(
        'UPDATE e_mate_tenant_user SET allowed_model_ids = $3 WHERE tenant_id = $1 AND user_id = $2',
        [tenantId, userId, ['gpt-5.6-sol']]
      );
      assert.deepEqual(await store.activeModelIds(principal, ['gpt-5.6-luna', 'gpt-5.6-sol']), ['gpt-5.6-sol']);
      await database.query(
        "UPDATE e_mate_tenant_user SET status = 'SUSPENDED' WHERE tenant_id = $1 AND user_id = $2",
        [tenantId, userId]
      );
      assert.deepEqual(await store.activeModelIds(principal, ['gpt-5.6-sol']), []);
      await database.query('DELETE FROM e_mate_tenant_user WHERE tenant_id = $1 AND user_id = $2', [tenantId, userId]);
      assert.deepEqual(await store.activeModelIds(principal, ['gpt-5.6-sol']), []);

      await createActiveTestUsers(database, [{ tenantId, userId }]);
      await database.query(
        'UPDATE e_mate_tenant_user SET allowed_model_ids = $3 WHERE tenant_id = $1 AND user_id = $2',
        [tenantId, userId, ['gpt-5.6-luna']]
      );
      const freshStore = new PostgresUsageStore(database, limits);
      assert.deepEqual(await freshStore.activeModelIds(
        principal, ['gpt-5.6-sol', 'gpt-5.6-luna']
      ), ['gpt-5.6-luna']);
    } finally {
      await database.query('DELETE FROM e_mate_tenant_user WHERE tenant_id = $1 AND user_id = $2', [tenantId, userId]).catch(() => undefined);
      await database.end().catch(() => undefined);
    }
  }
);

test(
  'real PostgreSQL accepts the task scenario contract while freezing each task classification',
  { skip: databaseUrl ? false : 'E_MATE_TEST_POSTGRES_URL is not set' },
  async () => {
    const suffix = randomUUID();
    const tenantId = `task-audit-${suffix}`;
    const userId = `user-${suffix}`;
    const database = pool();
    const store = new PostgresUsageStore(database, limits);
    const startedAt = Date.now() - 60_000;
    type RecordInput = Parameters<PostgresUsageStore['ingestAuditTasks']>[0][number];
    const record = (
      task: number,
      sequence: number,
      type: RecordInput['event']['type'],
      scenario: string
    ): RecordInput => {
      const taskId = `task_${createHash('sha256').update(`${suffix}:${task}`).digest('hex')}`;
      const eventId = `taskevent_${createHash('sha256')
        .update(`${suffix}:${task}:${sequence}:${type}`)
        .digest('hex')}`;
      return {
        tenantId,
        userId,
        payloadSha256: createHash('sha256').update(`${eventId}:${scenario}`).digest('hex'),
        event: {
          schemaVersion: 1,
          eventId,
          taskId,
          type,
          scenario,
          occurredAt: new Date(startedAt + task * 100 + sequence).toISOString(),
        },
      } as RecordInput;
    };
    try {
      await store.initialize();
      const mixed = TASK_SCENARIOS.flatMap((scenario, index) => [
        record(index + 1, 0, 'RECEIVED', scenario),
        record(index + 1, 1, 'TOOL_EXECUTION', scenario),
      ]);
      const receipts = await store.ingestAuditTasks(mixed);
      assert.equal(receipts.length, mixed.length);
      assert.deepEqual(await store.ingestAuditTasks(mixed), receipts);

      const rows = await database.query<{ scenario: string; task_count: string }>(
        `SELECT scenario, count(*)::text AS task_count
           FROM e_mate_task_fact
          WHERE tenant_id = $1
          GROUP BY scenario
          ORDER BY scenario`,
        [tenantId]
      );
      assert.deepEqual(
        rows.rows,
        [...TASK_SCENARIOS].sort().map((scenario) => ({ scenario, task_count: '1' }))
      );

      const drifted = record(1, 2, 'ARTIFACT_UPDATED', 'DOCUMENT_EDITING');
      await assert.rejects(store.ingestAuditTasks([drifted]), /compatible received task/i);
      const stable = record(1, 2, 'ARTIFACT_UPDATED', 'GENERAL');
      assert.equal((await store.ingestAuditTasks([stable])).length, 1);

      const validAfterPoison = record(20, 0, 'RECEIVED', 'SEARCH_QUERY');
      const unknownScenario = record(21, 0, 'RECEIVED', 'UNKNOWN');
      await assert.rejects(store.ingestAuditTasks([validAfterPoison, unknownScenario]), /invalid task audit record/i);
      assert.equal((await store.ingestAuditTasks([validAfterPoison])).length, 1);
    } finally {
      await database.query('DELETE FROM e_mate_task_event WHERE tenant_id = $1', [tenantId]).catch(() => undefined);
      await database.query('DELETE FROM e_mate_task_fact WHERE tenant_id = $1', [tenantId]).catch(() => undefined);
      await database.end().catch(() => undefined);
    }
  }
);

test(
  'real PostgreSQL atomically ingests direct-runtime audit usage into the authoritative ledger',
  { skip: databaseUrl ? false : 'E_MATE_TEST_POSTGRES_URL is not set' },
  async () => {
    const suffix = randomUUID();
    const tenantId = `audit-${suffix}`;
    const userId = `user-${suffix}`;
    const sourceId = `harness:${createHash('sha256').update(`session-${suffix}`).digest('hex')}:1`;
    const factId = `auditfact_${createHash('sha256').update(`e-Mate audit v1\0${sourceId}`).digest('hex')}`;
    const database = pool();
    const store = new PostgresUsageStore(database, limits);
    const record: AuditUsageRecord = {
      factId,
      payloadSha256: 'a'.repeat(64),
      occurredAt: new Date().toISOString(),
      fact: {
        tenantId,
        userId,
        taskId: sourceId,
        traceId: createHash('sha256').update(`session-${suffix}`).digest('hex'),
        modelId: 'gpt-5.6-sol',
        providerId: 'e-mate-enterprise',
        providerResponseId: factId,
        inputTokens: 3,
        outputTokens: 4,
        cacheReadTokens: 2,
        cacheWriteTokens: 2,
        costUsd: 0,
      },
    };
    try {
      await store.initialize();
      await createActiveTestUsers(database, [{ tenantId, userId, tokenLimit: 1 }]);
      const batches = await Promise.all(Array.from({ length: 10 }, () => store.ingestAuditUsage([record])));
      const receipts = batches.map(([receipt]) => receipt);
      assert(receipts[0]);
      assert.equal(new Set(receipts.map((receipt) => JSON.stringify(receipt))).size, 1);
      assert.equal((await store.currentAccountUsage({ tenantId, userId, modelIds: ['gpt-5.6-sol'] })).totalTokens, 11);
      const rows = await database.query<{
        attempts: string;
        invocations: string;
        invocation_status: string;
        task_status: string;
        usage_id: string;
        finalized_at_matches: boolean;
      }>(
        `
        SELECT
          (SELECT count(*) FROM e_mate_model_usage_attempt
            WHERE tenant_id = $1 AND user_id = $2 AND task_id = $3)::text AS attempts,
          (SELECT count(*) FROM e_mate_model_invocation
            WHERE tenant_id = $1 AND user_id = $2 AND task_id = $3)::text AS invocations,
          (SELECT status FROM e_mate_model_invocation
            WHERE tenant_id = $1 AND user_id = $2 AND task_id = $3 LIMIT 1) AS invocation_status,
          (SELECT status FROM e_mate_model_usage_task
            WHERE tenant_id = $1 AND user_id = $2 AND task_id = $3 LIMIT 1) AS task_status,
          (SELECT usage_id FROM e_mate_model_usage_task
            WHERE tenant_id = $1 AND user_id = $2 AND task_id = $3 LIMIT 1) AS usage_id,
          (SELECT finalized_at = $4::timestamptz FROM e_mate_model_usage_task
            WHERE tenant_id = $1 AND user_id = $2 AND task_id = $3 LIMIT 1) AS finalized_at_matches
      `,
        [tenantId, userId, sourceId, record.occurredAt]
      );
      const usageId = `auditusage_${createHash('sha256').update(factId).digest('hex')}`;
      assert.deepEqual(rows.rows[0], {
        attempts: '1',
        invocations: '1',
        invocation_status: 'COMPLETED',
        task_status: 'FINALIZED',
        usage_id: usageId,
        finalized_at_matches: true,
      });
      assert.equal((await store.finalize({ tenantId, userId, modelIds: ['gpt-5.6-sol'] }, sourceId))?.usageId, usageId);
      await assert.rejects(
        store.ingestAuditUsage([
          {
            ...record,
            payloadSha256: 'b'.repeat(64),
            fact: { ...record.fact, outputTokens: 5 },
          },
        ]),
        /conflict/i
      );
      assert.equal((await store.currentAccountUsage({ tenantId, userId, modelIds: ['gpt-5.6-sol'] })).totalTokens, 11);
      const multiTask = Array.from({ length: 3 }, (_, index) => {
        const batchFactId = `auditfact_${createHash('sha256').update(`${factId}:batch:${index}`).digest('hex')}`;
        return {
          ...record,
          factId: batchFactId,
          fact: { ...record.fact, taskId: `${sourceId}:batch:${index}`, providerResponseId: batchFactId },
        };
      });
      const orders = Array.from({ length: 10 }, (_, index) => index % 2 ? [...multiTask].reverse() : multiTask);
      const concurrentBatches = await Promise.all(orders.map(batch => store.ingestAuditUsage(batch)));
      for (const [index, batch] of concurrentBatches.entries()) {
        assert.deepEqual(batch.map(receipt => receipt.factId), orders[index]!.map(item => item.factId));
      }
      assert.equal((await store.currentAccountUsage({ tenantId, userId, modelIds: ['gpt-5.6-sol'] })).totalTokens, 44);
      const freshFactId = `auditfact_${createHash('sha256').update(`${factId}:rollback`).digest('hex')}`;
      const fresh = {
        ...record, factId: freshFactId,
        fact: { ...record.fact, taskId: `${sourceId}:rollback`, providerResponseId: freshFactId },
      };
      const conflictingScope = { ...record, fact: { ...record.fact, taskId: `${sourceId}:wrong-scope` } };
      await Promise.all([[fresh, conflictingScope], [conflictingScope, fresh]].map(batch =>
        assert.rejects(store.ingestAuditUsage(batch), /conflict/i)
      ));
      const rolledBackTasks = await database.query(
        'SELECT task_id FROM e_mate_model_usage_task WHERE tenant_id = $1 AND user_id = $2 AND task_id = ANY($3::text[])',
        [tenantId, userId, [fresh.fact.taskId, conflictingScope.fact.taskId]]
      );
      assert.equal(rolledBackTasks.rowCount, 0);
      assert.equal((await store.currentAccountUsage({ tenantId, userId, modelIds: ['gpt-5.6-sol'] })).totalTokens, 44);
    } finally {
      await database.query('DELETE FROM e_mate_model_usage_task WHERE tenant_id = $1', [tenantId]).catch(() => undefined);
      await database
        .query('DELETE FROM e_mate_tenant_user WHERE tenant_id = $1 AND user_id = $2', [tenantId, userId])
        .catch(() => undefined);
      await database.end().catch(() => undefined);
    }
  }
);

test(
  'real PostgreSQL rolls back a conflicting pending invocation without another row or quota charge',
  { skip: databaseUrl ? false : 'E_MATE_TEST_POSTGRES_URL is not set' },
  async () => {
    const suffix = randomUUID();
    const tenantId = `invocation-conflict-${suffix}`;
    const userId = `user-${suffix}`;
    const taskId = `task-${suffix}`;
    const database = pool();
    const store = new PostgresUsageStore(database, limits);
    const invocation: InvocationFact = {
      tenantId,
      userId,
      taskId,
      traceId: `trace-${suffix}`,
      modelId: 'gpt-image2.5-flare',
      providerId: 'custom-gpt',
      requestDigest: 'A'.repeat(43),
      routeFingerprint: 'R'.repeat(43),
    };
    const snapshot = async () => {
      const [invocations, quota] = await Promise.all([
        database.query<{
          invocation_id: string;
          request_digest: string;
          status: string;
        }>(
          `SELECT invocation_id, request_digest, status
             FROM e_mate_model_invocation
            WHERE tenant_id = $1 AND user_id = $2 AND task_id = $3
            ORDER BY invocation_id`,
          [tenantId, userId, taskId]
        ),
        database.query<{ tokens: string }>(
          'SELECT tokens::text AS tokens FROM e_mate_model_quota_state WHERE tenant_id = $1',
          [tenantId]
        ),
      ]);
      return { invocations: invocations.rows, quota: quota.rows };
    };

    try {
      await store.initialize();
      await createActiveTestUsers(database, [{ tenantId, userId }]);
      const prepared = await store.prepare(invocation);
      assert.equal(prepared.status, 'STARTED');
      const beforeConflict = await snapshot();
      assert.deepEqual(beforeConflict.invocations, [{
        invocation_id: prepared.invocationId,
        request_digest: invocation.requestDigest,
        status: 'PREPARED',
      }]);
      assert.equal(beforeConflict.quota.length, 1);

      await assert.rejects(
        store.prepare({ ...invocation, requestDigest: 'B'.repeat(43) }),
        /request digest changed/
      );
      assert.deepEqual(await snapshot(), beforeConflict);

      const exactReplay = await store.prepare(invocation);
      assert.equal(exactReplay.status, 'PENDING');
      assert.equal(exactReplay.invocationId, prepared.invocationId);
      assert.deepEqual(await snapshot(), beforeConflict);
      assert.equal((await database.query<{ usable: number }>('SELECT 1 AS usable')).rows[0]?.usable, 1);
    } finally {
      await database
        .query('DELETE FROM e_mate_model_usage_task WHERE tenant_id = $1', [tenantId])
        .catch(() => undefined);
      await database
        .query('DELETE FROM e_mate_model_quota_state WHERE tenant_id = $1', [tenantId])
        .catch(() => undefined);
      await database
        .query('DELETE FROM e_mate_tenant_user WHERE tenant_id = $1 AND user_id = $2', [tenantId, userId])
        .catch(() => undefined);
      await database.end().catch(() => undefined);
    }
  }
);

test(
  'real PostgreSQL atomically aggregates and freezes gateway usage attempts',
  { skip: databaseUrl ? false : 'E_MATE_TEST_POSTGRES_URL is not set' },
  async () => {
    const suffix = randomUUID();
    const tenantId = `tenant-${suffix}`;
    const userId = `user-${suffix}`;
    const taskId = `task-${suffix}`;
    const principal: ModelGatewayPrincipal = {
      tenantId,
      userId,
      modelIds: ['gpt-5.6-sol'],
    };
    let database = pool();
    let store = new PostgresUsageStore(database, limits);
    await Promise.all(Array.from({ length: 10 }, () => new PostgresUsageStore(database, limits).initialize()));
    await createActiveTestUsers(database, [{ tenantId, userId }]);
    const fact = (index: number): UsageFact => ({
      tenantId,
      userId,
      taskId,
      traceId: `trace-${suffix}`,
      modelId: 'gpt-5.6-sol',
      providerId: 'custom-gpt',
      providerResponseId: `response-${index}`,
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
      costUsd: 0.01,
    });
    try {
      await Promise.all(Array.from({ length: 50 }, (_, index) => store.add(fact(index))));
      await Promise.all(Array.from({ length: 20 }, () => store.add(fact(0))));
      await Promise.all(Array.from({ length: 20 }, () => store.add(fact(50))));
      await assert.rejects(store.add({ ...fact(0), outputTokens: 99 }), /idempotency conflict/);
      await assert.rejects(store.add({ ...fact(60), modelId: 'gpt-5.5' }), /scope changed/);

      const finalized = await Promise.all(Array.from({ length: 20 }, () => store.finalize(principal, taskId)));
      const first = finalized[0];
      assert(first);
      assert(finalized.every((usage) => usage?.usageId === first.usageId));
      assert.deepEqual(
        {
          inputTokens: first.inputTokens,
          outputTokens: first.outputTokens,
          cacheReadTokens: first.cacheReadTokens,
          cacheWriteTokens: first.cacheWriteTokens,
          costUsd: first.costUsd,
        },
        {
          inputTokens: 51,
          outputTokens: 102,
          cacheReadTokens: 153,
          cacheWriteTokens: 204,
          costUsd: 0.51,
        }
      );
      await store.add(fact(0));
      await assert.rejects(store.add(fact(51)), /already finalized/);
      assert.equal(await store.finalize({ ...principal, tenantId: `other-${suffix}` }, taskId), null);
      assert.equal(await store.finalize({ ...principal, userId: `other-${suffix}` }, taskId), null);

      const raceTaskId = `race-${suffix}`;
      const racePrincipal = principal;
      const raceBase = { ...fact(70), taskId: raceTaskId };
      const raceNext = {
        ...fact(71),
        taskId: raceTaskId,
      };
      await store.add(raceBase);
      const [raceAdd, raceFinalize] = await Promise.allSettled([
        store.add(raceNext),
        store.finalize(racePrincipal, raceTaskId),
      ]);
      assert.equal(raceFinalize.status, 'fulfilled');
      if (raceAdd.status === 'rejected') {
        assert.match(String(raceAdd.reason), /already finalized/);
      }
      const raceReceipt = await store.finalize(racePrincipal, raceTaskId);
      assert(raceReceipt);
      assert.equal(raceReceipt.inputTokens, raceAdd.status === 'fulfilled' ? 2 : 1);
      assert.equal((await store.finalize(racePrincipal, raceTaskId))?.usageId, raceReceipt.usageId);

      const limitTaskId = `limit-${suffix}`;
      const limitFact: UsageFact = {
        ...fact(80),
        taskId: limitTaskId,
        inputTokens: Number.MAX_SAFE_INTEGER,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
      };
      await store.add(limitFact);
      await assert.rejects(
        store.add({
          ...limitFact,
          providerResponseId: 'limit-overflow',
          inputTokens: 0,
          outputTokens: 1,
        })
      );
      await store.add({
        ...limitFact,
        providerResponseId: 'limit-overflow',
        inputTokens: 0,
      });
      assert.equal((await store.finalize(principal, limitTaskId))?.inputTokens, Number.MAX_SAFE_INTEGER);

      const invocationTaskId = `invocation-${suffix}`;
      const invocation: InvocationFact = {
        tenantId,
        userId,
        taskId: invocationTaskId,
        traceId: `trace-${suffix}`,
        modelId: 'gpt-5.6-sol',
        providerId: 'custom-gpt',
        requestDigest: 'A'.repeat(43),
        routeFingerprint: 'R'.repeat(43),
      };
      const prepared = await Promise.all(Array.from({ length: 20 }, () => store.prepare(invocation)));
      assert.equal(prepared.filter(({ status }) => status === 'STARTED').length, 1);
      assert.equal(new Set(prepared.map(({ invocationId }) => invocationId)).size, 1);
      await assert.rejects(store.finalize(principal, invocationTaskId), /requires reconciliation/);
      const completedFact: UsageFact = {
        tenantId: invocation.tenantId,
        userId: invocation.userId,
        taskId: invocation.taskId,
        traceId: invocation.traceId,
        modelId: invocation.modelId,
        providerId: invocation.providerId,
        providerResponseId: `response-invocation-${suffix}`,
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.01,
      };
      await store.complete(prepared[0]!.invocationId, completedFact);
      await store.complete(prepared[0]!.invocationId, completedFact);
      assert.equal((await store.prepare(invocation)).status, 'RECORDED');
      const unknownInvocation = {
        ...invocation,
        requestDigest: 'B'.repeat(43),
      };
      const unknown = await store.prepare(unknownInvocation);
      assert.equal(unknown.status, 'STARTED');

      await database.end();
      database = pool();
      store = new PostgresUsageStore(database, limits);
      const restoredPending = await store.prepare(unknownInvocation);
      assert.equal(restoredPending.status, 'PENDING');
      assert.equal(restoredPending.invocationId, unknown.invocationId);
      const claims = await Promise.all(
        Array.from({ length: 20 }, () =>
          store.claimReconciliation(
            principal,
            invocationTaskId,
            unknown.invocationId,
            unknownInvocation.routeFingerprint
          )
        )
      );
      assert.equal(claims.filter(Boolean).length, 1);
      const claim = claims.find((value) => value !== null);
      assert(claim);
      assert.equal(
        await store.claimReconciliation(
          { ...principal, tenantId: `other-${suffix}` },
          invocationTaskId,
          unknown.invocationId,
          unknownInvocation.routeFingerprint
        ),
        null
      );
      await assert.rejects(
        store.reject({ ...principal, tenantId: `other-${suffix}` }, invocationTaskId, unknown.invocationId),
        /not found/
      );
      await assert.rejects(
        store.rejectReconciliation(principal, invocationTaskId, unknown.invocationId, 'stale-lease'),
        /lease changed/
      );
      assert.equal(
        await store.renewReconciliation(principal, invocationTaskId, unknown.invocationId, claim.leaseToken),
        true
      );
      assert.equal(
        await store.renewReconciliation(principal, invocationTaskId, unknown.invocationId, 'stale-lease'),
        false
      );
      await store.rejectReconciliation(principal, invocationTaskId, unknown.invocationId, claim.leaseToken);

      const legacyTaskId = `legacy-invocation-${suffix}`;
      const legacyInvocation = {
        ...invocation,
        taskId: legacyTaskId,
        requestDigest: 'L'.repeat(43),
      };
      const legacy = await store.prepare(legacyInvocation);
      await database.query(
        `
        UPDATE e_mate_model_invocation
           SET route_fingerprint = NULL
         WHERE invocation_id = $1
      `,
        [legacy.invocationId]
      );
      assert.equal(
        await store.claimReconciliation(
          principal,
          legacyTaskId,
          legacy.invocationId,
          legacyInvocation.routeFingerprint
        ),
        null
      );
      await store.reject(principal, legacyTaskId, legacy.invocationId);
      assert.equal((await store.finalize(principal, invocationTaskId))?.outputTokens, 2);
      const restored = await store.finalize(principal, taskId);
      assert.equal(restored?.usageId, first.usageId);
      assert.equal(restored?.occurredAt, first.occurredAt);
    } finally {
      await database
        .query('DELETE FROM e_mate_model_usage_task WHERE tenant_id = $1', [tenantId])
        .catch(() => undefined);
      await database
        .query('DELETE FROM e_mate_model_quota_state WHERE tenant_id = $1', [tenantId])
        .catch(() => undefined);
      await database
        .query('DELETE FROM e_mate_tenant_user WHERE tenant_id = $1 AND user_id = $2', [tenantId, userId])
        .catch(() => undefined);
      await database.end().catch(() => undefined);
    }
  }
);

test(
  'real PostgreSQL applies committed administrator user, quota, and route-key changes to the next gateway request',
  { skip: databaseUrl ? false : 'E_MATE_TEST_POSTGRES_URL is not set' },
  async () => {
    const suffix = randomUUID();
    const tenantId = `admin-live-${suffix}`;
    const userId = `user-${suffix}`;
    const routeId = 'gpt-5.6-sol';
    const routeKeyEncryptionKey = Buffer.alloc(32, 19);
    const oldProviderKey = 'tenant-provider-key-before-admin-rotation';
    const newProviderKey = 'tenant-provider-key-after-admin-rotation';
    const admin: RuntimeRegistryPrincipal = {
      tenantId,
      userId: `admin-${suffix}`,
      roles: ['TENANT_ADMIN'],
    };
    const adminStore = await openPostgresAdminManagementStore(
      databaseUrl as string,
      [{ routeId, label: 'Sol', provider: 'Enterprise gateway' }],
      routeKeyEncryptionKey
    );
    const gatewayDatabase = pool();
    const gatewayPolicy = new PostgresTenantModelRoutePolicy(gatewayDatabase, routeKeyEncryptionKey);
    const usageStore = new PostgresUsageStore(gatewayDatabase, limits);
    const principal: ModelGatewayPrincipal = { tenantId, userId, modelIds: [routeId] };
    const completedTaskId = `completed-${suffix}`;
    const invocation = (taskId: string): InvocationFact => ({
      tenantId,
      userId,
      taskId,
      traceId: `trace-${taskId}`,
      modelId: routeId,
      providerId: 'custom-gpt',
      requestDigest: 'D'.repeat(43),
      routeFingerprint: 'R'.repeat(43),
    });
    try {
      await usageStore.initialize();
      const created = await adminStore.store.createUser(admin, {
        schemaVersion: 1,
        userId,
        displayName: 'User',
        roles: ['MEMBER'],
        tokenLimit: 10,
        allowedModelIds: [routeId],
        initialPassword: 'InitialPass-2026!',
      });
      await adminStore.store.updateModelRouteKey(admin, routeId, {
        schemaVersion: 1,
        apiKey: oldProviderKey,
      });

      assert.equal(await gatewayPolicy.isUserActive(tenantId, userId), true);
      assert.equal(await gatewayPolicy.upstreamApiKey(tenantId, routeId), oldProviderKey);

      await usageStore.add({
        tenantId,
        userId,
        taskId: completedTaskId,
        traceId: `trace-${completedTaskId}`,
        modelId: routeId,
        providerId: 'custom-gpt',
        providerResponseId: `response-${suffix}`,
        inputTokens: 4,
        outputTokens: 6,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
      });
      await usageStore.finalize(principal, completedTaskId);
      await assert.rejects(usageStore.prepare(invocation(`blocked-${suffix}`)), (error: unknown) => {
        assert(error instanceof InvocationAdmissionError);
        assert.equal(error.code, 'USER_TOKEN_LIMIT_REACHED');
        return true;
      });

      const raised = await adminStore.store.updateUser(admin, userId, {
        schemaVersion: 1,
        displayName: 'User',
        roles: ['MEMBER'],
        status: 'ACTIVE',
        tokenLimit: 11,
        allowedModelIds: [routeId],
        expectedUpdatedAt: created.updatedAt,
      });
      assert(raised);
      const admitted = await usageStore.prepare(invocation(`allowed-${suffix}`));
      assert.equal(admitted.status, 'STARTED');
      await usageStore.reject(principal, `allowed-${suffix}`, admitted.invocationId);

      await adminStore.store.updateModelRouteKey(admin, routeId, {
        schemaVersion: 1,
        apiKey: newProviderKey,
      });
      assert.equal(await gatewayPolicy.upstreamApiKey(tenantId, routeId), newProviderKey);

      await adminStore.store.updateUser(admin, userId, {
        schemaVersion: 1,
        displayName: 'User',
        roles: ['MEMBER'],
        status: 'SUSPENDED',
        tokenLimit: 11,
        allowedModelIds: [routeId],
        expectedUpdatedAt: raised.updatedAt,
      });
      assert.equal(await gatewayPolicy.isUserActive(tenantId, userId), false);
    } finally {
      await adminStore.close();
      await gatewayDatabase
        .query('DELETE FROM e_mate_admin_audit WHERE tenant_id = $1', [tenantId])
        .catch(() => undefined);
      await gatewayDatabase
        .query('DELETE FROM e_mate_model_invocation WHERE tenant_id = $1', [tenantId])
        .catch(() => undefined);
      await gatewayDatabase
        .query('DELETE FROM e_mate_model_usage_task WHERE tenant_id = $1', [tenantId])
        .catch(() => undefined);
      await gatewayDatabase
        .query('DELETE FROM e_mate_model_quota_state WHERE tenant_id = $1', [tenantId])
        .catch(() => undefined);
      await gatewayDatabase
        .query('DELETE FROM e_mate_tenant_model_route WHERE tenant_id = $1', [tenantId])
        .catch(() => undefined);
      await gatewayDatabase
        .query('DELETE FROM e_mate_auth_session WHERE tenant_id = $1 AND user_id = $2', [tenantId, userId])
        .catch(() => undefined);
      await gatewayDatabase
        .query('DELETE FROM e_mate_admin_api_key WHERE tenant_id = $1 AND user_id = $2', [tenantId, userId])
        .catch(() => undefined);
      await gatewayDatabase
        .query('DELETE FROM e_mate_auth_password_credential WHERE tenant_id = $1 AND user_id = $2', [tenantId, userId])
        .catch(() => undefined);
      await gatewayDatabase
        .query('DELETE FROM e_mate_tenant_user WHERE tenant_id = $1 AND user_id = $2', [tenantId, userId])
        .catch(() => undefined);
      await gatewayDatabase.end().catch(() => undefined);
    }
  }
);

test(
  'real PostgreSQL atomically enforces tenant invocation concurrency',
  { skip: databaseUrl ? false : 'E_MATE_TEST_POSTGRES_URL is not set' },
  async () => {
    const suffix = randomUUID();
    const tenantId = `quota-${suffix}`;
    const otherTenantId = `quota-other-${suffix}`;
    const database = pool();
    const store = new PostgresUsageStore(database, {
      tenantRequestsPerMinute: 100,
      tenantBurst: 100,
      tenantMaxConcurrent: 2,
      invocationLeaseMs: 180_000,
    });
    await store.initialize();
    await createActiveTestUsers(database, [
      { tenantId, userId: `user-${suffix}` },
      { tenantId: otherTenantId, userId: `user-${suffix}` },
    ]);
    const invocation = (tenant: string, index: number): InvocationFact => ({
      tenantId: tenant,
      userId: `user-${suffix}`,
      taskId: `quota-task-${index}-${suffix}`,
      traceId: `quota-trace-${index}-${suffix}`,
      modelId: 'gpt-5.6-sol',
      providerId: 'custom-gpt',
      requestDigest: Buffer.from(`quota-${index}`).toString('base64url').padEnd(43, 'Q'),
      routeFingerprint: 'R'.repeat(43),
    });
    try {
      const admitted = await Promise.allSettled(
        Array.from({ length: 10 }, (_, index) => store.prepare(invocation(tenantId, index)))
      );
      const started = admitted.flatMap((result) =>
        result.status === 'fulfilled' && result.value.status === 'STARTED' ? [result.value] : []
      );
      assert.equal(started.length, 2);
      assert.equal(
        admitted.filter(
          (result) => result.status === 'rejected' && String(result.reason).includes('Too many model requests')
        ).length,
        8
      );
      assert.equal((await store.prepare(invocation(otherTenantId, 99))).status, 'STARTED');
    } finally {
      await database
        .query('DELETE FROM e_mate_model_usage_task WHERE tenant_id = ANY($1)', [[tenantId, otherTenantId]])
        .catch(() => undefined);
      await database
        .query('DELETE FROM e_mate_model_quota_state WHERE tenant_id = ANY($1)', [[tenantId, otherTenantId]])
        .catch(() => undefined);
      await database
        .query('DELETE FROM e_mate_tenant_user WHERE tenant_id = ANY($1) AND user_id = $2', [
          [tenantId, otherTenantId],
          `user-${suffix}`,
        ])
        .catch(() => undefined);
      await database.end().catch(() => undefined);
    }
  }
);

test(
  'real PostgreSQL applies a raised user token limit to the next invocation',
  { skip: databaseUrl ? false : 'E_MATE_TEST_POSTGRES_URL is not set' },
  async () => {
    const suffix = randomUUID();
    const tenantId = `token-limit-${suffix}`;
    const userId = `user-${suffix}`;
    const database = pool();
    const store = new PostgresUsageStore(database, limits);
    await store.initialize();
    await createActiveTestUsers(database, [{ tenantId, userId }]);
    const principal: ModelGatewayPrincipal = {
      tenantId,
      userId,
      modelIds: ['gpt-5.6-sol'],
    };
    const completedTaskId = `completed-${suffix}`;
    const invocation = (taskId: string): InvocationFact => ({
      tenantId,
      userId,
      taskId,
      traceId: `trace-${taskId}`,
      modelId: 'gpt-5.6-sol',
      providerId: 'custom-gpt',
      requestDigest: 'D'.repeat(43),
      routeFingerprint: 'R'.repeat(43),
    });
    try {
      await store.add({
        tenantId,
        userId,
        taskId: completedTaskId,
        traceId: `trace-${completedTaskId}`,
        modelId: 'gpt-5.6-sol',
        providerId: 'custom-gpt',
        providerResponseId: `response-${suffix}`,
        inputTokens: 4,
        outputTokens: 6,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
      });
      await store.finalize(principal, completedTaskId);
      await database.query(
        'UPDATE e_mate_tenant_user SET token_limit = 10, updated_at = now() WHERE tenant_id = $1 AND user_id = $2',
        [tenantId, userId]
      );
      await assert.rejects(store.prepare(invocation(`blocked-${suffix}`)), (error: unknown) => {
        assert(error instanceof InvocationAdmissionError);
        assert.equal(error.code, 'USER_TOKEN_LIMIT_REACHED');
        return true;
      });

      await database.query(
        'UPDATE e_mate_tenant_user SET token_limit = 11, updated_at = now() WHERE tenant_id = $1 AND user_id = $2',
        [tenantId, userId]
      );
      assert.equal((await store.prepare(invocation(`allowed-${suffix}`))).status, 'STARTED');
    } finally {
      await database
        .query('DELETE FROM e_mate_model_usage_task WHERE tenant_id = $1', [tenantId])
        .catch(() => undefined);
      await database
        .query('DELETE FROM e_mate_model_quota_state WHERE tenant_id = $1', [tenantId])
        .catch(() => undefined);
      await database
        .query('DELETE FROM e_mate_tenant_user WHERE tenant_id = $1 AND user_id = $2', [tenantId, userId])
        .catch(() => undefined);
      await database.end().catch(() => undefined);
    }
  }
);

test(
  'real PostgreSQL rolls back injected prepare, complete, and finalize transaction failures',
  { skip: databaseUrl ? false : 'E_MATE_TEST_POSTGRES_URL is not set' },
  async () => {
    const suffix = randomUUID();
    const tenantId = `usage-fault-${suffix}`;
    const userId = `user-${suffix}`;
    const taskId = `image-task-${suffix}`;
    const database = pool();
    const principal: ModelGatewayPrincipal = { tenantId, userId, modelIds: ['gpt-image2.5-flare'] };
    const invocation: InvocationFact = {
      tenantId,
      userId,
      taskId,
      traceId: `image-trace-${suffix}`,
      modelId: 'gpt-image2.5-flare',
      providerId: 'custom-gpt',
      requestDigest: 'I'.repeat(43),
      routeFingerprint: 'F'.repeat(43),
    };
    const usage: UsageFact = {
      tenantId,
      userId,
      taskId,
      traceId: invocation.traceId,
      modelId: invocation.modelId,
      providerId: invocation.providerId,
      providerResponseId: `image-response-${suffix}`,
      inputTokens: 3,
      outputTokens: 7,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
    };

    const faultingStore = (needle: RegExp) => new PostgresUsageStore({
      connect: async () => {
        const client = await database.connect();
        let injected = false;
        return {
          query: async (...args: Parameters<typeof client.query>) => {
            const result = await client.query(...args);
            const statement = typeof args[0] === 'string' ? args[0].replace(/\s+/g, ' ').trim() : '';
            if (!injected && needle.test(statement)) {
              injected = true;
              throw new Error('injected transaction failure');
            }
            return result;
          },
          release: () => client.release(),
        };
      },
    } as never, limits);

    const state = async () => (await database.query<{
      tasks: string;
      attempts: string;
      invocations: string;
      prepared: string;
      completed: string;
      finalized: string;
    }>(`
      SELECT
        (SELECT count(*) FROM e_mate_model_usage_task WHERE tenant_id = $1 AND task_id = $2)::text AS tasks,
        (SELECT count(*) FROM e_mate_model_usage_attempt WHERE tenant_id = $1 AND task_id = $2)::text AS attempts,
        (SELECT count(*) FROM e_mate_model_invocation WHERE tenant_id = $1 AND task_id = $2)::text AS invocations,
        (SELECT count(*) FROM e_mate_model_invocation WHERE tenant_id = $1 AND task_id = $2 AND status = 'PREPARED')::text AS prepared,
        (SELECT count(*) FROM e_mate_model_invocation WHERE tenant_id = $1 AND task_id = $2 AND status = 'COMPLETED')::text AS completed,
        (SELECT count(*) FROM e_mate_model_usage_task WHERE tenant_id = $1 AND task_id = $2 AND status = 'FINALIZED')::text AS finalized
    `, [tenantId, taskId])).rows[0];

    try {
      const store = new PostgresUsageStore(database, limits);
      await store.initialize();
      await createActiveTestUsers(database, [{ tenantId, userId }]);

      await assert.rejects(
        faultingStore(/^INSERT INTO e_mate_model_invocation /).prepare(invocation),
        /injected transaction failure/
      );
      assert.deepEqual(await state(), {
        tasks: '0', attempts: '0', invocations: '0', prepared: '0', completed: '0', finalized: '0',
      });

      const prepared = await store.prepare(invocation);
      await assert.rejects(
        faultingStore(/^UPDATE e_mate_model_invocation SET status = 'COMPLETED'/).complete(prepared.invocationId, usage),
        /injected transaction failure/
      );
      assert.deepEqual(await state(), {
        tasks: '1', attempts: '0', invocations: '1', prepared: '1', completed: '0', finalized: '0',
      });

      await new PostgresUsageStore(database, limits).complete(prepared.invocationId, usage);
      await assert.rejects(
        faultingStore(/^UPDATE e_mate_model_usage_task SET status = 'FINALIZED'/).finalize(principal, taskId),
        /injected transaction failure/
      );
      assert.deepEqual(await state(), {
        tasks: '1', attempts: '1', invocations: '1', prepared: '0', completed: '1', finalized: '0',
      });

      const restarted = new PostgresUsageStore(database, limits);
      assert.equal((await restarted.prepare(invocation)).status, 'RECORDED');
      const [first, second] = await Promise.all([
        restarted.finalize(principal, taskId),
        restarted.finalize(principal, taskId),
      ]);
      assert(first && second);
      assert.equal(second.usageId, first.usageId);
      assert.equal(second.inputTokens + second.outputTokens, 10);
      assert.deepEqual(await state(), {
        tasks: '1', attempts: '1', invocations: '1', prepared: '0', completed: '1', finalized: '1',
      });
    } finally {
      await database.query('DELETE FROM e_mate_model_usage_task WHERE tenant_id = $1', [tenantId]).catch(() => undefined);
      await database.query('DELETE FROM e_mate_model_quota_state WHERE tenant_id = $1', [tenantId]).catch(() => undefined);
      await database.query('DELETE FROM e_mate_tenant_user WHERE tenant_id = $1 AND user_id = $2', [tenantId, userId]).catch(() => undefined);
      await database.end().catch(() => undefined);
    }
  }
);
