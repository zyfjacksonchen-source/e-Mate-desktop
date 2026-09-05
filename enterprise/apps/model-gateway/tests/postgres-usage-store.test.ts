import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { Pool } from 'pg';
import {
  InMemoryUsageStore, InvocationAdmissionError,
  type InvocationFact, type UsageStore,
} from '../src/server.ts';
import {
  parseUsageActivityQuery,
  PostgresUsageStore,
} from '../src/index.ts';

test('aggregates activity from the existing usage-attempt ledger with timezone-aware boundaries', async () => {
  const queries: Array<{ statement: string; parameters: unknown[] }> = [];
  const pool = {
    query: async (statement: string, parameters: unknown[]) => {
      queries.push({ statement, parameters });
      return {
        rows: [{
          date: '2024-02-29',
          input_tokens: '9007199254740993',
          output_tokens: '7',
          cache_read_tokens: '3',
          cache_write_tokens: '2',
          calculated_at: new Date('2024-03-02T00:00:00.000Z'),
        }],
      };
    },
  };
  const store = new PostgresUsageStore(pool as never, {
    tenantRequestsPerMinute: 1_000,
    tenantBurst: 1_000,
    tenantMaxConcurrent: 1,
    invocationLeaseMs: 180_000,
  });
  const activity = await store.accountUsageActivity(
    { tenantId: 'tenant-a', userId: 'user-a', modelIds: ['gpt-5.6-luna'] },
    parseUsageActivityQuery({
      timezone: 'America/Los_Angeles',
      startDate: '2024-02-28',
      endDate: '2024-03-01',
    }),
  );

  assert.equal(queries.length, 1);
  assert.match(queries[0]!.statement, /e_mate_model_usage_attempt/);
  assert.match(queries[0]!.statement, /recorded_at AT TIME ZONE \$3/);
  assert.deepEqual(queries[0]!.parameters, [
    'tenant-a',
    'user-a',
    'America/Los_Angeles',
    '2024-02-28',
    '2024-03-01',
  ]);
  assert.equal(activity.days[1]?.date, '2024-02-29');
  assert.equal(activity.periodTotal, '9007199254741005');
  assert.deepEqual(Object.keys(activity).sort(), [
    'calculatedAt',
    'days',
    'endDate',
    'periodTotal',
    'schemaVersion',
    'startDate',
    'timezone',
  ]);
});

test('reconciles an overlapping UTC activity range with the compatible weekly projection', async () => {
  const statements: string[] = [];
  const pool = {
    query: async (statement: string) => {
      statements.push(statement);
      if (statement.includes("date_trunc('week'")) {
        return { rows: [{
          total_tokens: '18',
          week_started_at: new Date('2024-02-26T00:00:00.000Z'),
          calculated_at: new Date('2024-02-29T12:00:00.000Z'),
        }] };
      }
      return { rows: [{
        date: '2024-02-29',
        input_tokens: '10',
        output_tokens: '5',
        cache_read_tokens: '2',
        cache_write_tokens: '1',
        calculated_at: new Date('2024-02-29T12:00:00.000Z'),
      }] };
    },
  };
  const store = new PostgresUsageStore(pool as never, {
    tenantRequestsPerMinute: 1_000,
    tenantBurst: 1_000,
    tenantMaxConcurrent: 1,
    invocationLeaseMs: 180_000,
  });
  const principal = { tenantId: 'tenant-a', userId: 'user-a', modelIds: ['gpt-5.6-luna'] };
  const [activity, weekly] = await Promise.all([
    store.accountUsageActivity(principal, parseUsageActivityQuery({
      timezone: 'UTC',
      startDate: '2024-02-26',
      endDate: '2024-02-29',
    })),
    store.currentAccountUsage(principal),
  ]);

  assert.equal(BigInt(activity.periodTotal), BigInt(weekly.totalTokens));
  assert.equal(statements.length, 2);
  assert.equal(statements.every(statement => statement.includes('e_mate_model_usage_attempt')), true);
});

const imageLimits = {
  tenantRequestsPerMinute: 1_000, tenantBurst: 1_000,
  tenantMaxConcurrent: 4, invocationLeaseMs: 600_000,
};
const imageFact = (taskId: string, imageTraffic: InvocationFact['imageTraffic'] = 'batch', tenantId = 'tenant-a'): InvocationFact => ({
  tenantId, userId: 'user-a', taskId, traceId: taskId,
  modelId: 'gpt-image-2-pro', providerId: 'image-provider',
  requestDigest: 'd'.repeat(43), routeFingerprint: 'f'.repeat(43),
  ...(imageTraffic === undefined ? {} : { imageTraffic }),
});
const imageUsage = (fact: InvocationFact) => ({
  ...fact, providerResponseId: `result-${fact.taskId}`,
  inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0,
});
const imagePrincipal = (tenantId = 'tenant-a') => ({ tenantId, userId: 'user-a', modelIds: ['gpt-image-2-pro'] });
const concurrencyDenied = (operation: Promise<unknown>) => assert.rejects(operation, (error: unknown) => {
  assert(error instanceof InvocationAdmissionError);
  assert.equal(error.code, 'TENANT_CONCURRENCY_LIMITED');
  assert.equal(error.retryAfterMs, 1_000);
  return true;
});

async function mixedImageAdmission(store: UsageStore, releaseAfterTenSeconds: () => Promise<void>) {
  // All four slots remain usable until a direct single actually waits.
  const batch = await Promise.all(Array.from({ length: 4 }, (_, index) => store.prepare(imageFact(`full-${index}`))));
  assert(batch.every(value => value.status === 'STARTED'));
  // Accepted replays must not enter admission or consume more tokens.
  assert.equal((await store.prepare(imageFact('full-1'))).status, 'PENDING');
  const otherTenant = await Promise.all(Array.from({ length: 3 }, (_, index) => store.prepare(imageFact(`isolated-${index}`, 'batch', 'tenant-b'))));
  assert(otherTenant.every(value => value.status === 'STARTED'));
  await concurrencyDenied(store.prepare(imageFact('waiting-single', 'single')));
  await Promise.all([
    releaseAfterTenSeconds(),
    store.prepare(imageFact('isolated-last', 'batch', 'tenant-b')).then(value => {
      assert.equal(value.status, 'STARTED', 'another tenant keeps its last slot while the single waits');
    }),
  ]);
  await store.complete(batch[0]!.invocationId, imageUsage(imageFact('full-0')));
  await concurrencyDenied(store.prepare(imageFact('batch-refill')));
  const single = await store.prepare(imageFact('waiting-single', 'single'));
  assert.equal(single.status, 'STARTED');
  assert.equal((await store.prepare(imageFact('waiting-single', 'single'))).status, 'PENDING');
  await store.complete(single.invocationId, imageUsage(imageFact('waiting-single', 'single')));
  await store.complete(single.invocationId, imageUsage(imageFact('waiting-single', 'single')));
  assert.equal((await store.prepare(imageFact('waiting-single', 'single'))).status, 'RECORDED');
  assert.equal((await store.currentAccountUsage(imagePrincipal())).totalTokens, 4);
  assert.equal((await store.prepare(imageFact('batch-refill'))).status, 'STARTED', 'admitted single clears the hint');
}

test('in-memory image admission reserves only the last slot and expires cancelled waits without billing', async () => {
  let now = 0;
  const store = new InMemoryUsageStore(imageLimits, () => now);
  await mixedImageAdmission(store, async () => { now = 10_000; });
  await concurrencyDenied(store.prepare(imageFact('cancelled-single', 'single')));
  assert.equal(await store.finalize(imagePrincipal(), 'cancelled-single'), null);
  const full = await store.prepare(imageFact('full-1'));
  await store.complete(full.invocationId, imageUsage(imageFact('full-1')));
  now = 39_999;
  await concurrencyDenied(store.prepare(imageFact('after-cancel')));
  now = 40_000;
  assert.equal((await store.prepare(imageFact('after-cancel'))).status, 'STARTED');
  assert.equal((await store.currentAccountUsage(imagePrincipal())).totalTokens, 6);

  await concurrencyDenied(store.prepare(imageFact('another-single', 'single')));
  const another = await store.prepare(imageFact('full-2'));
  await store.complete(another.invocationId, imageUsage(imageFact('full-2')));
  const ordinary = { ...imageFact('ordinary'), modelId: 'gpt-5.6-sol' };
  delete ordinary.imageTraffic;
  assert.equal((await store.prepare(ordinary)).status, 'STARTED', 'ordinary model admission is unchanged');
  await assert.rejects(store.prepare({ ...ordinary, taskId: 'ordinary-full', traceId: 'ordinary-full' }), (error: unknown) => {
    assert(error instanceof InvocationAdmissionError);
    assert.equal(error.retryAfterMs, 560_000);
    return true;
  });
});

test('image concurrency waiting does not bypass the in-memory request token bucket', async () => {
  const store = new InMemoryUsageStore({ ...imageLimits, tenantBurst: 4, tenantRequestsPerMinute: 1 }, () => 0);
  const full = await Promise.all(Array.from({ length: 4 }, (_, index) => store.prepare(imageFact(`rate-${index}`))));
  await concurrencyDenied(store.prepare(imageFact('rate-single', 'single')));
  await store.complete(full[0]!.invocationId, imageUsage(imageFact('rate-0')));
  await assert.rejects(store.prepare(imageFact('rate-single', 'single')), (error: unknown) => {
    assert(error instanceof InvocationAdmissionError);
    assert.equal(error.code, 'TENANT_REQUEST_RATE_LIMITED');
    assert.equal(error.retryAfterMs, 60_000);
    return true;
  });
});

test('a pending single still permits batch refill when more than one tenant slot is free', async () => {
  const store = new InMemoryUsageStore(imageLimits, () => 0);
  const facts = Array.from({ length: 4 }, (_, index) => imageFact(`slots-${index}`));
  const full = await Promise.all(facts.map(fact => store.prepare(fact)));
  await concurrencyDenied(store.prepare(imageFact('slots-single', 'single')));
  for (const index of [0, 1]) await store.reject(imagePrincipal(), facts[index]!.taskId, full[index]!.invocationId);
  assert.equal((await store.prepare(imageFact('slots-refill'))).status, 'STARTED');
  await concurrencyDenied(store.prepare(imageFact('slots-last')));
  assert.equal((await store.prepare(imageFact('slots-single', 'single'))).status, 'STARTED');
});

const imageDatabaseUrl = process.env.IMAGE_ADMISSION_TEST_DATABASE_URL;
test('real Postgres image admission preserves rollback, fairness, TTL, isolation and exactly-once accounting', {
  skip: imageDatabaseUrl === undefined ? 'requires the isolated image-admission PostgreSQL database' : false,
}, async t => {
  assert.equal(imageDatabaseUrl, 'postgresql://postgres@127.0.0.1:65432/emate218');
  const schema = `ia_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: imageDatabaseUrl });
  const pool = new Pool({ connectionString: imageDatabaseUrl, options: `-c search_path=${schema}`, max: 8 });
  let schemaCreated = false;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    schemaCreated = true;
    await pool.query(`CREATE TABLE e_mate_tenant_user (tenant_id text, user_id text, token_limit bigint)`);
    await pool.query(`INSERT INTO e_mate_tenant_user VALUES ('tenant-a','user-a',NULL), ('tenant-b','user-a',NULL), ('tenant-rate','user-a',NULL)`);
    const store = new PostgresUsageStore(pool, imageLimits);
    await store.initialize();
    await store.initialize(); // Existing installations and repeat initialization keep the quota row.
    // Observe the production UPDATE inside its own database statement. A later client
    // round trip measures the remaining TTL, not the duration that was actually granted.
    await pool.query(`
      CREATE TABLE image_hint_observation (
        tenant_id text, hint_until timestamptz, started_at timestamptz, observed_at timestamptz
      );
      CREATE FUNCTION observe_image_hint() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO image_hint_observation
          VALUES (NEW.tenant_id, NEW.single_image_wait_until, statement_timestamp(), clock_timestamp());
        RETURN NEW;
      END $$;
      CREATE TRIGGER observe_image_hint AFTER UPDATE OF single_image_wait_until ON e_mate_model_quota_state
        FOR EACH ROW WHEN (NEW.single_image_wait_until > COALESCE(OLD.single_image_wait_until, '-infinity'::timestamptz))
        EXECUTE FUNCTION observe_image_hint();
    `);
    let ttlBounds: { minimum_ms: string; maximum_ms: string } | undefined;
    await mixedImageAdmission(store, async () => {
      const observed = await pool.query(`
        SELECT hint_until BETWEEN started_at + interval '30 seconds' AND observed_at + interval '30 seconds' AS ttl_is_30_seconds,
               (extract(epoch FROM (hint_until - observed_at)) * 1000)::text AS minimum_ms,
               (extract(epoch FROM (hint_until - started_at)) * 1000)::text AS maximum_ms,
               (SELECT count(*) FROM e_mate_model_usage_task WHERE task_id = 'waiting-single') AS rejected_task_rows
          FROM image_hint_observation WHERE tenant_id = 'tenant-a'
      `);
      assert.equal(observed.rows.length, 1);
      assert.equal(observed.rows[0].rejected_task_rows, '0', 'denied prepare rolls back its task journal');
      assert.equal(observed.rows[0].ttl_is_30_seconds, true, 'the hint must grant exactly 30 seconds within its database UPDATE');
      ttlBounds = { minimum_ms: observed.rows[0].minimum_ms, maximum_ms: observed.rows[0].maximum_ms };
      await wait(10_000);
    });
    assert.equal((await pool.query(`SELECT single_image_wait_until FROM e_mate_model_quota_state WHERE tenant_id = 'tenant-a'`)).rows[0].single_image_wait_until, null);
    await concurrencyDenied(store.prepare(imageFact('cancelled-single', 'single')));
    const beforePoll = await pool.query(`SELECT tokens, single_image_wait_until,
      (SELECT count(*) FROM e_mate_model_usage_task WHERE task_id = 'cancelled-single') AS rejected_task_rows
      FROM e_mate_model_quota_state WHERE tenant_id = 'tenant-a'`);
    assert.equal(beforePoll.rows[0].rejected_task_rows, '0');
    await concurrencyDenied(store.prepare(imageFact('cancelled-single', 'single')));
    const afterPoll = await pool.query(`SELECT tokens, single_image_wait_until FROM e_mate_model_quota_state WHERE tenant_id = 'tenant-a'`);
    assert.equal(afterPoll.rows[0].tokens, beforePoll.rows[0].tokens);
    assert.equal(afterPoll.rows[0].single_image_wait_until.getTime(), beforePoll.rows[0].single_image_wait_until.getTime(), 'polling does not extend an active TTL');
    const full = await store.prepare(imageFact('full-1'));
    await store.complete(full.invocationId, imageUsage(imageFact('full-1')));
    await concurrencyDenied(store.prepare(imageFact('after-cancel')));
    // Advance only this isolated row's hint across expiry; the production clock stays database-owned.
    await pool.query(`UPDATE e_mate_model_quota_state SET single_image_wait_until = clock_timestamp() - interval '1 millisecond' WHERE tenant_id = 'tenant-a'`);
    assert.equal((await store.prepare(imageFact('after-cancel'))).status, 'STARTED');
    assert.equal((await pool.query(`SELECT single_image_wait_until FROM e_mate_model_quota_state WHERE tenant_id = 'tenant-a'`)).rows[0].single_image_wait_until, null);
    assert.equal((await store.currentAccountUsage(imagePrincipal())).totalTokens, 6);

    const rateStore = new PostgresUsageStore(pool, { ...imageLimits, tenantBurst: 4, tenantRequestsPerMinute: 1 });
    const rateFacts = Array.from({ length: 4 }, (_, index) => imageFact(`rate-${index}`, 'batch', 'tenant-rate'));
    const fullRate = await Promise.all(rateFacts.map(fact => rateStore.prepare(fact)));
    const singleRate = imageFact('rate-single', 'single', 'tenant-rate');
    await concurrencyDenied(rateStore.prepare(singleRate));
    await rateStore.complete(fullRate[0]!.invocationId, imageUsage(rateFacts[0]!));
    const rateHintAtDatabaseNow = async () => {
      const result = await pool.query(`
        SELECT ceil(greatest(1000, (1 - tokens) * 60000 -
          greatest(0, extract(epoch FROM (clock_timestamp() - last_refill_at)) * 1000))) AS retry_after_ms
          FROM e_mate_model_quota_state WHERE tenant_id = 'tenant-rate'
      `);
      return Number(result.rows[0].retry_after_ms);
    };
    const rateHintBefore = await rateHintAtDatabaseNow();
    let rateHint: number | undefined;
    await assert.rejects(rateStore.prepare(singleRate), (error: unknown) => {
      assert(error instanceof InvocationAdmissionError);
      assert.equal(error.code, 'TENANT_REQUEST_RATE_LIMITED');
      rateHint = error.retryAfterMs;
      return true;
    });
    const rateHintAfter = await rateHintAtDatabaseNow();
    assert(rateHint !== undefined && rateHintAfter <= rateHint && rateHint <= rateHintBefore,
      'rate hint must match the unchanged token bucket between the database clock reads');
    await pool.query(`UPDATE e_mate_tenant_user SET token_limit = 0 WHERE tenant_id = 'tenant-rate'`);
    await assert.rejects(rateStore.prepare(singleRate), (error: unknown) => {
      assert(error instanceof InvocationAdmissionError);
      assert.equal(error.code, 'USER_TOKEN_LIMIT_REACHED');
      return true;
    });
    t.diagnostic(JSON.stringify({ schema, ttl_bounds_ms: ttlBounds, rate_hint_ms: rateHint,
      rate_hint_bounds_ms: { minimum: rateHintAfter, maximum: rateHintBefore },
      release_after_ms: 10_000, batch_refill: 'TENANT_CONCURRENCY_LIMITED', single: 'STARTED', rejected_task_rows: 0, billed_tokens_after_cancel: 6, provider_calls: 0 }));
  } finally {
    await pool.end();
    if (schemaCreated) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
