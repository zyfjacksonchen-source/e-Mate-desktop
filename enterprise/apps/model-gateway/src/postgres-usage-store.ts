import { createHash, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import {
  projectUsageActivity,
  type UsageActivity,
  type UsageActivityLedgerDay,
  type UsageActivityQuery,
} from './activity-contract.ts';
import { TASK_SCENARIOS } from '@e-mate/monitoring-contract';
import {
  InvocationAdmissionError,
  IMAGE_ADMISSION_RETRY_MS,
  IMAGE_SINGLE_WAIT_TTL_MS,
  InvocationRequestConflictError,
  AuditTaskConflictError,
  AuditUsageConflictError,
  validateInvocationLimits,
  type AuditTaskRecord,
  type AuditTaskReceipt,
  type AuditUsageRecord,
  type AuditUsageReceipt,
  type InvocationLimits,
  type FinalizedUsage,
  type InvocationFact,
  type ModelGatewayPrincipal,
  type PreparedInvocation,
  type ReconciliationClaim,
  type UsageFact,
  type UsageStore,
} from './server.ts';

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const maxCount = Number.MAX_SAFE_INTEGER;
const taskScenarios = new Set<string>(TASK_SCENARIOS);
const taskScenarioSql = TASK_SCENARIOS.map((scenario) => `'${scenario}'`).join(', ');

type TaskRow = {
  tenant_id: string;
  user_id: string;
  task_id: string;
  trace_id: string;
  model_id: string;
  provider_id: string;
  status: 'ACCUMULATING' | 'FINALIZED';
  input_tokens: string;
  output_tokens: string;
  cache_read_tokens: string;
  cache_write_tokens: string;
  cost_usd: string;
  usage_id: string | null;
  finalized_at: Date | null;
};

type AttemptRow = {
  trace_id: string;
  model_id: string;
  provider_id: string;
  input_tokens: string;
  output_tokens: string;
  cache_read_tokens: string;
  cache_write_tokens: string;
  cost_usd: string;
};

type InvocationRow = {
  invocation_id: string;
  trace_id: string;
  model_id: string;
  provider_id: string;
  request_digest: string;
  route_fingerprint: string | null;
  status: 'PREPARED' | 'COMPLETED' | 'REJECTED';
  provider_response_id: string | null;
  reconcile_after: Date | null;
  reconcile_lease_token: string | null;
  quota_admitted_at: Date;
  quota_expires_at: Date;
  quota_released_at: Date | null;
};

type AuditInvocationRow = {
  invocation_id: string;
  tenant_id: string;
  user_id: string;
  task_id: string;
  trace_id: string;
  model_id: string;
  provider_id: string;
  request_digest: string;
  route_fingerprint: string | null;
  status: 'PREPARED' | 'COMPLETED' | 'REJECTED';
  provider_response_id: string | null;
  quota_admitted_at: Date;
};

type TaskAuditEventRow = {
  user_id: string;
  task_id: string;
  type: string;
  scenario: string;
  occurred_at: Date;
  recorded_at: Date;
};

type TaskAuditFactRow = {
  user_id: string;
  scenario: string;
  status: 'RECEIVED' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  received_at: Date;
  terminal_at: Date | null;
};

type QuotaRow = {
  tokens: string;
  last_refill_at: Date;
  single_image_wait_until: Date | null;
};

type LockedQuota = QuotaRow & { database_now: Date };

function identifier(value: string, label: string): string {
  if (!identifierPattern.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}

function count(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function cost(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1_000_000) {
    throw new Error('Invalid usage cost');
  }
  return Number(value.toFixed(12));
}

function validateFact(value: UsageFact): UsageFact {
  return {
    tenantId: identifier(value.tenantId, 'tenant id'),
    userId: identifier(value.userId, 'user id'),
    taskId: identifier(value.taskId, 'task id'),
    traceId: identifier(value.traceId, 'trace id'),
    modelId: identifier(value.modelId, 'model id'),
    providerId: identifier(value.providerId, 'provider id'),
    providerResponseId: identifier(value.providerResponseId, 'provider response id'),
    inputTokens: count(value.inputTokens, 'input tokens'),
    outputTokens: count(value.outputTokens, 'output tokens'),
    cacheReadTokens: count(value.cacheReadTokens, 'cache read tokens'),
    cacheWriteTokens: count(value.cacheWriteTokens, 'cache write tokens'),
    costUsd: cost(value.costUsd),
  };
}

function validateInvocation(value: InvocationFact): InvocationFact {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value.requestDigest) || !/^[A-Za-z0-9_-]{43}$/.test(value.routeFingerprint)) {
    throw new Error('Invalid request digest');
  }
  if (value.imageTraffic !== undefined && value.imageTraffic !== 'single' && value.imageTraffic !== 'batch') {
    throw new Error('Invalid image traffic');
  }
  return {
    tenantId: identifier(value.tenantId, 'tenant id'),
    userId: identifier(value.userId, 'user id'),
    taskId: identifier(value.taskId, 'task id'),
    traceId: identifier(value.traceId, 'trace id'),
    modelId: identifier(value.modelId, 'model id'),
    providerId: identifier(value.providerId, 'provider id'),
    requestDigest: value.requestDigest,
    routeFingerprint: value.routeFingerprint,
    ...(value.imageTraffic === undefined ? {} : { imageTraffic: value.imageTraffic }),
  };
}

function countFromDatabase(value: string, label: string): number {
  return count(Number(value), label);
}

function bigintFromDatabase(value: unknown, label: string): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return BigInt(value);
}

function mapFinalized(row: TaskRow): FinalizedUsage {
  if (row.status !== 'FINALIZED' || !row.usage_id || !row.finalized_at) {
    throw new Error('Usage was not finalized');
  }
  return {
    tenantId: identifier(row.tenant_id, 'tenant id'),
    userId: identifier(row.user_id, 'user id'),
    taskId: identifier(row.task_id, 'task id'),
    traceId: identifier(row.trace_id, 'trace id'),
    modelId: identifier(row.model_id, 'model id'),
    providerId: identifier(row.provider_id, 'provider id'),
    inputTokens: countFromDatabase(row.input_tokens, 'input tokens'),
    outputTokens: countFromDatabase(row.output_tokens, 'output tokens'),
    cacheReadTokens: countFromDatabase(row.cache_read_tokens, 'cache read tokens'),
    cacheWriteTokens: countFromDatabase(row.cache_write_tokens, 'cache write tokens'),
    costUsd: cost(Number(row.cost_usd)),
    usageId: identifier(row.usage_id, 'usage id'),
    occurredAt: row.finalized_at.toISOString(),
  };
}

function sameAttempt(row: AttemptRow, fact: UsageFact): boolean {
  return (
    row.trace_id === fact.traceId &&
    row.model_id === fact.modelId &&
    row.provider_id === fact.providerId &&
    countFromDatabase(row.input_tokens, 'input tokens') === fact.inputTokens &&
    countFromDatabase(row.output_tokens, 'output tokens') === fact.outputTokens &&
    countFromDatabase(row.cache_read_tokens, 'cache read tokens') === fact.cacheReadTokens &&
    countFromDatabase(row.cache_write_tokens, 'cache write tokens') === fact.cacheWriteTokens &&
    cost(Number(row.cost_usd)) === fact.costUsd
  );
}

async function rollback(client: PoolClient): Promise<void> {
  await client.query('ROLLBACK').catch(() => undefined);
}

export class PostgresUsageStore implements UsageStore {
  readonly #pool: Pool;
  readonly #limits: InvocationLimits;

  constructor(pool: Pool, limits: InvocationLimits) {
    this.#pool = pool;
    this.#limits = validateInvocationLimits(limits);
  }

  async #databaseNow(client: PoolClient): Promise<Date> {
    const clock = await client.query<{ database_now: Date }>('SELECT clock_timestamp() AS database_now');
    const databaseNow = clock.rows[0]?.database_now;
    if (!databaseNow) throw new Error('Database clock was unavailable');
    return databaseNow;
  }

  async activeModelIds(principal: ModelGatewayPrincipal, routeIdsInput: readonly string[]): Promise<string[]> {
    const tenantId = identifier(principal.tenantId, 'tenant id');
    const userId = identifier(principal.userId, 'user id');
    if (
      routeIdsInput.length < 1 ||
      routeIdsInput.length > 20 ||
      routeIdsInput.some((routeId) => !identifierPattern.test(routeId)) ||
      new Set(routeIdsInput).size !== routeIdsInput.length
    ) {
      throw new Error('Invalid model route catalog');
    }
    const routeIds = [...routeIdsInput];
    const result = await this.#pool.query<{ model_ids: string[] }>(
      `SELECT ARRAY(
         SELECT candidate.route_id
           FROM unnest($3::text[]) WITH ORDINALITY AS candidate(route_id, position)
          WHERE candidate.route_id = ANY(app_user.allowed_model_ids)
          ORDER BY candidate.position
       ) AS model_ids
         FROM e_mate_tenant_user AS app_user
        WHERE app_user.tenant_id = $1
          AND app_user.user_id = $2
          AND app_user.status = 'ACTIVE'`,
      [tenantId, userId, routeIds]
    );
    const row = result.rows[0];
    if (!row) return [];
    const modelIds = row.model_ids;
    if (
      !Array.isArray(modelIds) ||
      modelIds.length > routeIds.length ||
      modelIds.some((routeId) => !routeIds.includes(routeId)) ||
      new Set(modelIds).size !== modelIds.length
    ) {
      throw new Error('User model policy was unavailable');
    }
    return modelIds;
  }

  async currentAccountUsage(principal: ModelGatewayPrincipal) {
    const tenantId = identifier(principal.tenantId, 'tenant id');
    const userId = identifier(principal.userId, 'user id');
    const result = await this.#pool.query<{
      total_tokens: string;
      week_started_at: Date;
      calculated_at: Date;
    }>(
      `
      SELECT COALESCE(sum(
               input_tokens + output_tokens + cache_read_tokens + cache_write_tokens
             ), 0)::text AS total_tokens,
             date_trunc('week', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS week_started_at,
             clock_timestamp() AS calculated_at
        FROM e_mate_model_usage_attempt
       WHERE tenant_id = $1 AND user_id = $2
         AND recorded_at >= date_trunc('week', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
      `,
      [tenantId, userId]
    );
    const row = result.rows[0];
    if (!row || !(row.week_started_at instanceof Date) || !(row.calculated_at instanceof Date)) {
      throw new Error('Account usage projection is unavailable');
    }
    return {
      totalTokens: countFromDatabase(row.total_tokens, 'account total tokens'),
      weekStartedAt: row.week_started_at.toISOString(),
      calculatedAt: row.calculated_at.toISOString(),
    };
  }

  async accountUsageActivity(
    principal: ModelGatewayPrincipal,
    query: UsageActivityQuery
  ): Promise<UsageActivity> {
    const tenantId = identifier(principal.tenantId, 'tenant id');
    const userId = identifier(principal.userId, 'user id');
    const result = await this.#pool.query<{
      date: string | null;
      input_tokens: string | null;
      output_tokens: string | null;
      cache_read_tokens: string | null;
      cache_write_tokens: string | null;
      calculated_at: Date;
    }>(
      `
      WITH activity AS (
        SELECT (recorded_at AT TIME ZONE $3)::date::text AS date,
               sum(input_tokens)::text AS input_tokens,
               sum(output_tokens)::text AS output_tokens,
               sum(cache_read_tokens)::text AS cache_read_tokens,
               sum(cache_write_tokens)::text AS cache_write_tokens
          FROM e_mate_model_usage_attempt
         WHERE tenant_id = $1 AND user_id = $2
           AND recorded_at >= ($4::date::timestamp AT TIME ZONE $3)
           AND recorded_at < (($5::date + 1)::timestamp AT TIME ZONE $3)
         GROUP BY (recorded_at AT TIME ZONE $3)::date
      ), calculated AS (
        SELECT clock_timestamp() AS calculated_at
      )
      SELECT activity.*, calculated.calculated_at
        FROM calculated
        LEFT JOIN activity ON true
       ORDER BY activity.date
      `,
      [tenantId, userId, query.timezone, query.startDate, query.endDate]
    );
    const calculatedAt = result.rows[0]?.calculated_at;
    if (!(calculatedAt instanceof Date)) throw new Error('Usage activity projection is unavailable');
    const rows: UsageActivityLedgerDay[] = result.rows.flatMap(row => row.date === null ? [] : [{
      date: row.date,
      inputTokens: row.input_tokens as string,
      outputTokens: row.output_tokens as string,
      cacheReadTokens: row.cache_read_tokens as string,
      cacheWriteTokens: row.cache_write_tokens as string,
    }]);
    return projectUsageActivity(query, rows, calculatedAt);
  }

  async #lockQuota(client: PoolClient, tenantId: string): Promise<LockedQuota> {
    await client.query(
      `
      INSERT INTO e_mate_model_quota_state (
        tenant_id, tokens, last_refill_at
      )
      VALUES ($1, $2, clock_timestamp())
      ON CONFLICT DO NOTHING
    `,
      [tenantId, this.#limits.tenantBurst]
    );
    const result = await client.query<QuotaRow>(
      `
      SELECT tokens, last_refill_at, single_image_wait_until
        FROM e_mate_model_quota_state
       WHERE tenant_id = $1
       FOR UPDATE
    `,
      [tenantId]
    );
    const row = result.rows[0];
    if (!row) throw new Error('Tenant quota state was unavailable');
    const databaseNow = await this.#databaseNow(client);
    return { ...row, database_now: databaseNow };
  }

  async initialize(): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(731947112463)');
      await client.query(`
      CREATE TABLE IF NOT EXISTS e_mate_model_usage_task (
        tenant_id text NOT NULL CHECK (char_length(tenant_id) BETWEEN 1 AND 128),
        user_id text NOT NULL CHECK (char_length(user_id) BETWEEN 1 AND 128),
        task_id text NOT NULL CHECK (char_length(task_id) BETWEEN 1 AND 128),
        trace_id text NOT NULL CHECK (char_length(trace_id) BETWEEN 1 AND 128),
        model_id text NOT NULL CHECK (char_length(model_id) BETWEEN 1 AND 128),
        provider_id text NOT NULL CHECK (char_length(provider_id) BETWEEN 1 AND 128),
        status text NOT NULL CHECK (status IN ('ACCUMULATING', 'FINALIZED')),
        input_tokens bigint NOT NULL DEFAULT 0
          CHECK (input_tokens BETWEEN 0 AND ${maxCount}),
        output_tokens bigint NOT NULL DEFAULT 0
          CHECK (output_tokens BETWEEN 0 AND ${maxCount}),
        cache_read_tokens bigint NOT NULL DEFAULT 0
          CHECK (cache_read_tokens BETWEEN 0 AND ${maxCount}),
        cache_write_tokens bigint NOT NULL DEFAULT 0
          CHECK (cache_write_tokens BETWEEN 0 AND ${maxCount}),
        cost_usd numeric(30, 12) NOT NULL DEFAULT 0
          CHECK (cost_usd BETWEEN 0 AND 1000000),
        usage_id text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        finalized_at timestamptz,
        PRIMARY KEY (tenant_id, user_id, task_id),
        CHECK (
          (status = 'ACCUMULATING' AND usage_id IS NULL AND finalized_at IS NULL)
          OR
          (status = 'FINALIZED' AND usage_id IS NOT NULL AND finalized_at IS NOT NULL)
        ),
        CHECK (
          input_tokens + output_tokens +
          cache_read_tokens + cache_write_tokens <= ${maxCount}
        )
      );
      CREATE UNIQUE INDEX IF NOT EXISTS e_mate_model_usage_receipt
        ON e_mate_model_usage_task (usage_id)
        WHERE usage_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS e_mate_model_usage_period
        ON e_mate_model_usage_task (tenant_id, finalized_at DESC)
        WHERE status = 'FINALIZED';

      CREATE TABLE IF NOT EXISTS e_mate_model_invocation (
        invocation_id text PRIMARY KEY
          CHECK (char_length(invocation_id) BETWEEN 1 AND 128),
        tenant_id text NOT NULL,
        user_id text NOT NULL,
        task_id text NOT NULL,
        trace_id text NOT NULL CHECK (char_length(trace_id) BETWEEN 1 AND 128),
        model_id text NOT NULL CHECK (char_length(model_id) BETWEEN 1 AND 128),
        provider_id text NOT NULL CHECK (char_length(provider_id) BETWEEN 1 AND 128),
        request_digest text NOT NULL
          CHECK (request_digest ~ '^[A-Za-z0-9_-]{43}$'),
        route_fingerprint text,
        status text NOT NULL
          CHECK (status IN ('PREPARED', 'COMPLETED', 'REJECTED')),
        provider_response_id text,
        prepared_at timestamptz NOT NULL DEFAULT now(),
        reconcile_after timestamptz,
        reconcile_lease_token text,
        quota_admitted_at timestamptz NOT NULL DEFAULT now(),
        quota_expires_at timestamptz NOT NULL,
        quota_released_at timestamptz,
        finished_at timestamptz,
        FOREIGN KEY (tenant_id, user_id, task_id)
          REFERENCES e_mate_model_usage_task (tenant_id, user_id, task_id)
          ON DELETE CASCADE,
        CHECK (
          (status = 'PREPARED' AND provider_response_id IS NULL AND finished_at IS NULL)
          OR
          (status = 'COMPLETED' AND provider_response_id IS NOT NULL AND finished_at IS NOT NULL)
          OR
          (status = 'REJECTED' AND provider_response_id IS NULL AND finished_at IS NOT NULL)
        )
      );
      CREATE UNIQUE INDEX IF NOT EXISTS e_mate_model_invocation_prepared
        ON e_mate_model_invocation (tenant_id, user_id, task_id)
        WHERE status = 'PREPARED';
      CREATE INDEX IF NOT EXISTS e_mate_model_invocation_task_digest
        ON e_mate_model_invocation (
          tenant_id, user_id, task_id, request_digest, prepared_at DESC
        );
      ALTER TABLE e_mate_model_invocation
        ADD COLUMN IF NOT EXISTS route_fingerprint text;
      ALTER TABLE e_mate_model_invocation
        ADD COLUMN IF NOT EXISTS reconcile_after timestamptz;
      ALTER TABLE e_mate_model_invocation
        ADD COLUMN IF NOT EXISTS reconcile_lease_token text;
      ALTER TABLE e_mate_model_invocation
        ADD COLUMN IF NOT EXISTS quota_admitted_at timestamptz;
      ALTER TABLE e_mate_model_invocation
        ADD COLUMN IF NOT EXISTS quota_expires_at timestamptz;
      ALTER TABLE e_mate_model_invocation
        ADD COLUMN IF NOT EXISTS quota_released_at timestamptz;
      UPDATE e_mate_model_invocation
         SET quota_admitted_at = COALESCE(quota_admitted_at, prepared_at),
             quota_expires_at = COALESCE(
               quota_expires_at,
               CASE
                 WHEN status = 'PREPARED'
                   THEN clock_timestamp() + (${this.#limits.invocationLeaseMs} * interval '1 millisecond')
                 ELSE COALESCE(finished_at, prepared_at)
               END
             ),
             quota_released_at = CASE
               WHEN status = 'PREPARED' THEN quota_released_at
               ELSE COALESCE(quota_released_at, finished_at, prepared_at)
             END
       WHERE quota_admitted_at IS NULL OR quota_expires_at IS NULL
          OR (status <> 'PREPARED' AND quota_released_at IS NULL);
      ALTER TABLE e_mate_model_invocation
        ALTER COLUMN quota_admitted_at SET NOT NULL;
      ALTER TABLE e_mate_model_invocation
        ALTER COLUMN quota_expires_at SET NOT NULL;
      CREATE INDEX IF NOT EXISTS e_mate_model_invocation_active_quota
        ON e_mate_model_invocation (tenant_id, quota_expires_at)
        WHERE quota_released_at IS NULL;

      CREATE TABLE IF NOT EXISTS e_mate_model_quota_state (
        tenant_id text PRIMARY KEY
          CHECK (char_length(tenant_id) BETWEEN 1 AND 128),
        tokens numeric(30, 12) NOT NULL CHECK (tokens >= 0),
        last_refill_at timestamptz NOT NULL
      );
      ALTER TABLE e_mate_model_quota_state
        ADD COLUMN IF NOT EXISTS single_image_wait_until timestamptz;
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
            FROM pg_constraint
           WHERE conname = 'e_mate_model_invocation_quota_lease'
             AND conrelid = 'e_mate_model_invocation'::regclass
        ) THEN
          ALTER TABLE e_mate_model_invocation
            ADD CONSTRAINT e_mate_model_invocation_quota_lease
            CHECK (
              quota_expires_at >= quota_admitted_at AND
              (
                quota_released_at IS NULL OR
                quota_released_at >= quota_admitted_at
              )
            );
        END IF;
        IF NOT EXISTS (
          SELECT 1
            FROM pg_constraint
           WHERE conname = 'e_mate_model_invocation_route_fingerprint'
             AND conrelid = 'e_mate_model_invocation'::regclass
        ) THEN
          ALTER TABLE e_mate_model_invocation
            ADD CONSTRAINT e_mate_model_invocation_route_fingerprint
            CHECK (
              route_fingerprint IS NULL OR
              route_fingerprint ~ '^[A-Za-z0-9_-]{43}$'
            );
        END IF;
        IF NOT EXISTS (
          SELECT 1
            FROM pg_constraint
           WHERE conname = 'e_mate_model_invocation_reconcile_lease'
             AND conrelid = 'e_mate_model_invocation'::regclass
        ) THEN
          ALTER TABLE e_mate_model_invocation
            ADD CONSTRAINT e_mate_model_invocation_reconcile_lease
            CHECK (
              (
                reconcile_lease_token IS NULL OR
                reconcile_lease_token ~
                  '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
              )
              AND (status = 'PREPARED' OR reconcile_lease_token IS NULL)
            );
        END IF;
      END
      $$;

      CREATE TABLE IF NOT EXISTS e_mate_model_usage_attempt (
        tenant_id text NOT NULL,
        user_id text NOT NULL,
        task_id text NOT NULL,
        provider_response_id text NOT NULL
          CHECK (char_length(provider_response_id) BETWEEN 1 AND 128),
        trace_id text NOT NULL CHECK (char_length(trace_id) BETWEEN 1 AND 128),
        model_id text NOT NULL CHECK (char_length(model_id) BETWEEN 1 AND 128),
        provider_id text NOT NULL CHECK (char_length(provider_id) BETWEEN 1 AND 128),
        input_tokens bigint NOT NULL
          CHECK (input_tokens BETWEEN 0 AND ${maxCount}),
        output_tokens bigint NOT NULL
          CHECK (output_tokens BETWEEN 0 AND ${maxCount}),
        cache_read_tokens bigint NOT NULL
          CHECK (cache_read_tokens BETWEEN 0 AND ${maxCount}),
        cache_write_tokens bigint NOT NULL
          CHECK (cache_write_tokens BETWEEN 0 AND ${maxCount}),
        cost_usd numeric(30, 12) NOT NULL
          CHECK (cost_usd BETWEEN 0 AND 1000000),
        recorded_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (
          tenant_id, user_id, task_id, provider_response_id
        ),
        FOREIGN KEY (tenant_id, user_id, task_id)
          REFERENCES e_mate_model_usage_task (tenant_id, user_id, task_id)
          ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS e_mate_task_fact (
        tenant_id text NOT NULL,
        task_id text NOT NULL,
        user_id text NOT NULL,
        scenario text NOT NULL CHECK (
          scenario IN (${taskScenarioSql})
        ),
        received_event_id text NOT NULL,
        received_at timestamptz NOT NULL,
        status text NOT NULL CHECK (status IN ('RECEIVED', 'COMPLETED', 'FAILED', 'CANCELLED')),
        terminal_event_id text,
        terminal_at timestamptz,
        PRIMARY KEY (tenant_id, task_id),
        UNIQUE (tenant_id, received_event_id),
        CHECK (
          (status = 'RECEIVED' AND terminal_event_id IS NULL AND terminal_at IS NULL) OR
          (status <> 'RECEIVED' AND terminal_event_id IS NOT NULL AND terminal_at IS NOT NULL)
        )
      );
      CREATE TABLE IF NOT EXISTS e_mate_task_event (
        tenant_id text NOT NULL,
        event_id text NOT NULL,
        task_id text NOT NULL,
        user_id text NOT NULL,
        type text NOT NULL CHECK (
          type IN (
            'RECEIVED', 'FIRST_RESPONSE', 'COMPLETED', 'FAILED',
            'CANCELLED', 'SKILL_SELECTED', 'TOOL_SELECTED',
            'TOOL_EXECUTION', 'PERMISSION_REQUESTED', 'WAITING_INPUT',
            'ARTIFACT_UPDATED'
          )
        ),
        scenario text NOT NULL CHECK (
          scenario IN (${taskScenarioSql})
        ),
        occurred_at timestamptz NOT NULL,
        recorded_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, event_id),
        FOREIGN KEY (tenant_id, task_id) REFERENCES e_mate_task_fact (tenant_id, task_id)
      );
      CREATE INDEX IF NOT EXISTS e_mate_task_fact_received
        ON e_mate_task_fact (tenant_id, received_at, task_id);
      CREATE INDEX IF NOT EXISTS e_mate_task_event_occurred
        ON e_mate_task_event (tenant_id, occurred_at, event_id);
      ALTER TABLE e_mate_task_fact
        DROP CONSTRAINT IF EXISTS e_mate_task_fact_scenario_check;
      ALTER TABLE e_mate_task_fact
        ADD CONSTRAINT e_mate_task_fact_scenario_check CHECK (
          scenario IN (${taskScenarioSql})
        );
      ALTER TABLE e_mate_task_event
        DROP CONSTRAINT IF EXISTS e_mate_task_event_scenario_check;
      ALTER TABLE e_mate_task_event
        ADD CONSTRAINT e_mate_task_event_scenario_check CHECK (
          scenario IN (${taskScenarioSql})
        );
      `);
      await client.query('COMMIT');
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async prepare(value: InvocationFact): Promise<PreparedInvocation> {
    const fact = validateInvocation(value);
    const client = await this.#pool.connect();
    let singleImageWaiting = false;
    try {
      await client.query('BEGIN');
      const quota = await this.#lockQuota(client, fact.tenantId);
      await client.query(
        `
        INSERT INTO e_mate_model_usage_task (
          tenant_id, user_id, task_id, trace_id, model_id, provider_id, status
        )
        VALUES ($1,$2,$3,$4,$5,$6,'ACCUMULATING')
        ON CONFLICT DO NOTHING
      `,
        [fact.tenantId, fact.userId, fact.taskId, fact.traceId, fact.modelId, fact.providerId]
      );
      const task = await client.query<TaskRow>(
        `
        SELECT tenant_id, user_id, task_id, trace_id, model_id, provider_id,
               status, input_tokens, output_tokens, cache_read_tokens,
               cache_write_tokens, cost_usd, usage_id, finalized_at
          FROM e_mate_model_usage_task
         WHERE tenant_id = $1 AND user_id = $2 AND task_id = $3
         FOR UPDATE
      `,
        [fact.tenantId, fact.userId, fact.taskId]
      );
      const taskRow = task.rows[0];
      if (
        !taskRow ||
        taskRow.trace_id !== fact.traceId ||
        taskRow.model_id !== fact.modelId ||
        taskRow.provider_id !== fact.providerId
      ) {
        throw new Error('Task usage scope changed');
      }
      const pending = await client.query<InvocationRow>(
        `
        SELECT invocation_id, trace_id, model_id, provider_id,
               request_digest, route_fingerprint, status,
               provider_response_id, reconcile_after,
               reconcile_lease_token
          FROM e_mate_model_invocation
         WHERE tenant_id = $1 AND user_id = $2 AND task_id = $3
           AND status = 'PREPARED'
         LIMIT 1
         FOR UPDATE
      `,
        [fact.tenantId, fact.userId, fact.taskId]
      );
      if (pending.rows[0]) {
        if (pending.rows[0].request_digest !== fact.requestDigest) {
          throw new InvocationRequestConflictError('Invocation request digest changed');
        }
        await client.query('COMMIT');
        return {
          status: 'PENDING',
          invocationId: identifier(pending.rows[0].invocation_id, 'invocation id'),
        };
      }
      const completed = await client.query<InvocationRow>(
        `
        SELECT invocation_id, trace_id, model_id, provider_id,
               request_digest, route_fingerprint, status,
               provider_response_id, reconcile_after,
               reconcile_lease_token
          FROM e_mate_model_invocation
         WHERE tenant_id = $1 AND user_id = $2 AND task_id = $3
           AND status = 'COMPLETED' AND request_digest = $4
         ORDER BY prepared_at DESC
         LIMIT 1
      `,
        [fact.tenantId, fact.userId, fact.taskId, fact.requestDigest]
      );
      if (completed.rows[0]) {
        await client.query('COMMIT');
        return {
          status: 'RECORDED',
          invocationId: identifier(completed.rows[0].invocation_id, 'invocation id'),
        };
      }
      if (taskRow.status !== 'ACCUMULATING') {
        throw new Error('Task usage was already finalized');
      }
      // ISO week is Monday 00:00 UTC; attempt rows are immutable and idempotent, so a task crossing a week is apportioned correctly.
      const userUsage = await client.query<{
        token_limit: string | null;
        used_tokens: string;
        database_now: Date;
        week_ends_at: Date;
      }>(
        `
        SELECT app_user.token_limit::text AS token_limit,
               COALESCE((
                 SELECT sum(
                   attempt.input_tokens + attempt.output_tokens +
                   attempt.cache_read_tokens + attempt.cache_write_tokens
                 )::text
                   FROM e_mate_model_usage_attempt AS attempt
                  WHERE attempt.tenant_id = app_user.tenant_id
                    AND attempt.user_id = app_user.user_id
                    AND attempt.recorded_at >=
                      date_trunc('week', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
               ), '0') AS used_tokens,
               clock_timestamp() AS database_now,
               (
                 date_trunc('week', clock_timestamp() AT TIME ZONE 'UTC') + interval '1 week'
               ) AT TIME ZONE 'UTC' AS week_ends_at
          FROM e_mate_tenant_user AS app_user
         WHERE app_user.tenant_id = $1 AND app_user.user_id = $2
         LIMIT 1
      `,
        [fact.tenantId, fact.userId]
      );
      const userUsageRow = userUsage.rows[0];
      if (!userUsageRow) throw new Error('User token limit was unavailable');
      const usedTokens = bigintFromDatabase(userUsageRow.used_tokens, 'used user tokens');
      if (
        userUsageRow.token_limit !== null &&
        usedTokens >= bigintFromDatabase(userUsageRow.token_limit, 'user token limit')
      ) {
        if (!(userUsageRow.database_now instanceof Date) || !(userUsageRow.week_ends_at instanceof Date)) {
          throw new Error('User weekly token period was unavailable');
        }
        throw new InvocationAdmissionError(
          'USER_TOKEN_LIMIT_REACHED',
          Math.max(1_000, userUsageRow.week_ends_at.getTime() - userUsageRow.database_now.getTime())
        );
      }
      const rejected = await client.query<InvocationRow>(
        `
        SELECT invocation_id, trace_id, model_id, provider_id,
               request_digest, route_fingerprint, status,
               provider_response_id, reconcile_after,
               reconcile_lease_token
          FROM e_mate_model_invocation
         WHERE tenant_id = $1 AND user_id = $2 AND task_id = $3
           AND status = 'REJECTED' AND request_digest = $4
         ORDER BY prepared_at DESC
         LIMIT 1
         FOR UPDATE
      `,
        [fact.tenantId, fact.userId, fact.taskId, fact.requestDigest]
      );
      const invocationId = rejected.rows[0]?.invocation_id ?? randomUUID();
      const freshDatabaseNow = await this.#databaseNow(client);
      const admissionNow = new Date(Math.max(freshDatabaseNow.getTime(), quota.last_refill_at.getTime()));
      const active = await client.query<{
        active: string;
        earliest_expiry: Date | null;
      }>(
        `
        SELECT count(*) AS active, min(quota_expires_at) AS earliest_expiry
          FROM e_mate_model_invocation
         WHERE tenant_id = $1
           AND status = 'PREPARED'
           AND quota_released_at IS NULL
           AND quota_expires_at > $2
      `,
        [fact.tenantId, admissionNow]
      );
      const activeCount = Number(active.rows[0]?.active ?? Number.NaN);
      if (!Number.isSafeInteger(activeCount) || activeCount < 0) {
        throw new Error('Invalid active invocation count');
      }
      if (activeCount >= this.#limits.tenantMaxConcurrent) {
        singleImageWaiting = fact.imageTraffic === 'single';
        const earliest = active.rows[0]?.earliest_expiry?.getTime();
        throw new InvocationAdmissionError(
          'TENANT_CONCURRENCY_LIMITED',
          fact.imageTraffic !== undefined ? IMAGE_ADMISSION_RETRY_MS
            : typeof earliest === 'number' ? earliest - admissionNow.getTime() : this.#limits.invocationLeaseMs
        );
      }
      if (fact.imageTraffic === 'batch'
        && (quota.single_image_wait_until?.getTime() ?? 0) > admissionNow.getTime()
        && activeCount === this.#limits.tenantMaxConcurrent - 1) {
        throw new InvocationAdmissionError('TENANT_CONCURRENCY_LIMITED', IMAGE_ADMISSION_RETRY_MS);
      }
      const elapsed = admissionNow.getTime() - quota.last_refill_at.getTime();
      const tokens = Math.min(
        this.#limits.tenantBurst,
        Number(quota.tokens) + (elapsed * this.#limits.tenantRequestsPerMinute) / 60_000
      );
      if (!Number.isFinite(tokens) || tokens < 0) {
        throw new Error('Invalid tenant quota state');
      }
      if (tokens < 1) {
        throw new InvocationAdmissionError(
          'TENANT_REQUEST_RATE_LIMITED',
          ((1 - tokens) * 60_000) / this.#limits.tenantRequestsPerMinute
        );
      }
      await client.query(
        `
        UPDATE e_mate_model_quota_state
           SET tokens = $2, last_refill_at = $3,
               single_image_wait_until = CASE
                 WHEN $4 OR single_image_wait_until <= $3 THEN NULL
                 ELSE single_image_wait_until
               END
         WHERE tenant_id = $1
      `,
        [fact.tenantId, tokens - 1, admissionNow, fact.imageTraffic === 'single']
      );
      if (rejected.rows[0]) {
        await client.query(
          `
          UPDATE e_mate_model_invocation
             SET status = 'PREPARED',
                 prepared_at = $4::timestamptz,
                 route_fingerprint = $2,
                 reconcile_after = NULL,
                 reconcile_lease_token = NULL,
                 quota_admitted_at = $4::timestamptz,
                 quota_expires_at =
                   $4::timestamptz + ($3::double precision * interval '1 millisecond'),
                 quota_released_at = NULL,
                 finished_at = NULL
           WHERE invocation_id = $1
        `,
          [invocationId, fact.routeFingerprint, this.#limits.invocationLeaseMs, admissionNow]
        );
      } else {
        await client.query(
          `
          INSERT INTO e_mate_model_invocation (
            invocation_id, tenant_id, user_id, task_id, trace_id, model_id,
            provider_id, request_digest, route_fingerprint, status,
            prepared_at, quota_admitted_at, quota_expires_at
          )
          VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,'PREPARED',
            $11::timestamptz,$11::timestamptz,
            $11::timestamptz + ($10::double precision * interval '1 millisecond')
          )
        `,
          [
            invocationId,
            fact.tenantId,
            fact.userId,
            fact.taskId,
            fact.traceId,
            fact.modelId,
            fact.providerId,
            fact.requestDigest,
            fact.routeFingerprint,
            this.#limits.invocationLeaseMs,
            admissionNow,
          ]
        );
      }
      await client.query('COMMIT');
      return { status: 'STARTED', invocationId };
    } catch (error) {
      await rollback(client);
      if (singleImageWaiting) {
        // The rejected prepare must leave no task journal or token debit. Publish only the
        // bounded hint on the existing tenant quota row before returning the admission 429.
        await client.query(
          `UPDATE e_mate_model_quota_state
              SET single_image_wait_until = CASE
                WHEN single_image_wait_until > clock_timestamp() THEN single_image_wait_until
                ELSE clock_timestamp() + ($2::double precision * interval '1 millisecond')
              END
            WHERE tenant_id = $1`,
          [fact.tenantId, IMAGE_SINGLE_WAIT_TTL_MS]
        );
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async claimReconciliation(
    principal: ModelGatewayPrincipal,
    taskIdInput: string,
    invocationIdInput: string,
    routeFingerprintInput: string
  ): Promise<ReconciliationClaim | null> {
    const tenantId = identifier(principal.tenantId, 'tenant id');
    const userId = identifier(principal.userId, 'user id');
    const taskId = identifier(taskIdInput, 'task id');
    const invocationId = identifier(invocationIdInput, 'invocation id');
    if (!/^[A-Za-z0-9_-]{43}$/.test(routeFingerprintInput)) {
      throw new Error('Invalid route fingerprint');
    }
    const leaseToken = randomUUID();
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const task = await client.query(
        `
        SELECT 1
          FROM e_mate_model_usage_task
         WHERE tenant_id = $1 AND user_id = $2 AND task_id = $3
         FOR UPDATE
      `,
        [tenantId, userId, taskId]
      );
      if (!task.rowCount) {
        await client.query('COMMIT');
        return null;
      }
      const claimed = await client.query<InvocationRow>(
        `
        UPDATE e_mate_model_invocation
           SET reconcile_after =
                 clock_timestamp() + interval '30 seconds',
               reconcile_lease_token = $5
         WHERE invocation_id = $1
           AND tenant_id = $2 AND user_id = $3 AND task_id = $4
           AND status = 'PREPARED'
           AND route_fingerprint = $6
           AND (
             reconcile_after IS NULL OR
             reconcile_after <= clock_timestamp()
           )
        RETURNING invocation_id, trace_id, model_id, provider_id,
                  request_digest, route_fingerprint, status,
                  provider_response_id, reconcile_after,
                  reconcile_lease_token
      `,
        [invocationId, tenantId, userId, taskId, leaseToken, routeFingerprintInput]
      );
      const invocation = claimed.rows[0];
      if (!invocation) {
        await client.query('COMMIT');
        return null;
      }
      await client.query('COMMIT');
      return {
        fact: {
          tenantId,
          userId,
          taskId,
          traceId: identifier(invocation.trace_id, 'trace id'),
          modelId: identifier(invocation.model_id, 'model id'),
          providerId: identifier(invocation.provider_id, 'provider id'),
          requestDigest: invocation.request_digest,
          routeFingerprint: routeFingerprintInput,
        },
        leaseToken,
      };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async renewReconciliation(
    principal: ModelGatewayPrincipal,
    taskIdInput: string,
    invocationIdInput: string,
    leaseTokenInput: string
  ): Promise<boolean> {
    const tenantId = identifier(principal.tenantId, 'tenant id');
    const userId = identifier(principal.userId, 'user id');
    const taskId = identifier(taskIdInput, 'task id');
    const invocationId = identifier(invocationIdInput, 'invocation id');
    const leaseToken = identifier(leaseTokenInput, 'reconciliation lease');
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      await this.#lockQuota(client, tenantId);
      const task = await client.query(
        `
        SELECT 1
          FROM e_mate_model_usage_task
         WHERE tenant_id = $1 AND user_id = $2 AND task_id = $3
         FOR UPDATE
      `,
        [tenantId, userId, taskId]
      );
      if (!task.rowCount) {
        await client.query('COMMIT');
        return false;
      }
      const invocation = await client.query<{ quota_expires_at: Date }>(
        `
        SELECT quota_expires_at
          FROM e_mate_model_invocation
         WHERE invocation_id = $1
           AND tenant_id = $2 AND user_id = $3 AND task_id = $4
           AND status = 'PREPARED'
           AND reconcile_lease_token = $5
         FOR UPDATE
      `,
        [invocationId, tenantId, userId, taskId, leaseToken]
      );
      if (!invocation.rowCount) {
        await client.query('COMMIT');
        return false;
      }
      const databaseNow = await this.#databaseNow(client);
      await client.query(
        `
        UPDATE e_mate_model_invocation
           SET quota_expires_at =
                 greatest(
                   quota_expires_at,
                   $2::timestamptz + ($3::double precision * interval '1 millisecond')
                 ),
               quota_released_at = NULL
         WHERE invocation_id = $1
      `,
        [invocationId, databaseNow, this.#limits.invocationLeaseMs]
      );
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async complete(invocationIdInput: string, value: UsageFact): Promise<void> {
    await this.#complete(invocationIdInput, value);
  }

  async completeReconciliation(invocationIdInput: string, leaseTokenInput: string, value: UsageFact): Promise<void> {
    await this.#complete(invocationIdInput, value, identifier(leaseTokenInput, 'reconciliation lease'));
  }

  async #complete(invocationIdInput: string, value: UsageFact, leaseToken?: string): Promise<void> {
    const invocationId = identifier(invocationIdInput, 'invocation id');
    const fact = validateFact(value);
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      await this.#lockQuota(client, fact.tenantId);
      await client.query(
        `
        SELECT 1
          FROM e_mate_model_usage_task
         WHERE tenant_id = $1 AND user_id = $2 AND task_id = $3
         FOR UPDATE
      `,
        [fact.tenantId, fact.userId, fact.taskId]
      );
      const current = await client.query<InvocationRow>(
        `
        SELECT invocation_id, trace_id, model_id, provider_id,
               request_digest, route_fingerprint, status,
               provider_response_id, reconcile_after,
               reconcile_lease_token
          FROM e_mate_model_invocation
         WHERE invocation_id = $1
           AND tenant_id = $2 AND user_id = $3 AND task_id = $4
         FOR UPDATE
      `,
        [invocationId, fact.tenantId, fact.userId, fact.taskId]
      );
      const invocation = current.rows[0];
      if (
        !invocation ||
        invocation.trace_id !== fact.traceId ||
        invocation.model_id !== fact.modelId ||
        invocation.provider_id !== fact.providerId
      ) {
        throw new Error('Invocation scope changed');
      }
      if (invocation.status === 'COMPLETED') {
        if (invocation.provider_response_id !== fact.providerResponseId) {
          throw new Error('Usage attempt idempotency conflict');
        }
        const replay = await client.query<AttemptRow>(
          `
          SELECT trace_id, model_id, provider_id, input_tokens, output_tokens,
                 cache_read_tokens, cache_write_tokens, cost_usd
            FROM e_mate_model_usage_attempt
           WHERE tenant_id = $1 AND user_id = $2 AND task_id = $3
             AND provider_response_id = $4
           LIMIT 1
        `,
          [fact.tenantId, fact.userId, fact.taskId, fact.providerResponseId]
        );
        if (!replay.rows[0] || !sameAttempt(replay.rows[0], fact)) {
          throw new Error('Usage attempt idempotency conflict');
        }
        await client.query('COMMIT');
        return;
      }
      if (invocation.status !== 'PREPARED') {
        throw new Error('Invocation was not prepared');
      }
      if (leaseToken !== undefined && invocation.reconcile_lease_token !== leaseToken) {
        throw new Error('Invocation reconciliation lease changed');
      }
      await this.#add(client, fact, true);
      const completedAt = await this.#databaseNow(client);
      await client.query(
        `
        UPDATE e_mate_model_invocation
           SET status = 'COMPLETED',
               provider_response_id = $2,
               reconcile_after = NULL,
               reconcile_lease_token = NULL,
               quota_released_at = greatest($3, quota_admitted_at),
               finished_at = greatest($3, quota_admitted_at)
         WHERE invocation_id = $1
      `,
        [invocationId, fact.providerResponseId, completedAt]
      );
      await client.query('COMMIT');
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async reject(principal: ModelGatewayPrincipal, taskIdInput: string, invocationIdInput: string): Promise<void> {
    await this.#reject(principal, taskIdInput, invocationIdInput);
  }

  async rejectReconciliation(
    principal: ModelGatewayPrincipal,
    taskIdInput: string,
    invocationIdInput: string,
    leaseTokenInput: string
  ): Promise<void> {
    await this.#reject(principal, taskIdInput, invocationIdInput, identifier(leaseTokenInput, 'reconciliation lease'));
  }

  async #reject(
    principal: ModelGatewayPrincipal,
    taskIdInput: string,
    invocationIdInput: string,
    leaseToken?: string
  ): Promise<void> {
    const tenantId = identifier(principal.tenantId, 'tenant id');
    const userId = identifier(principal.userId, 'user id');
    const taskId = identifier(taskIdInput, 'task id');
    const invocationId = identifier(invocationIdInput, 'invocation id');
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      await this.#lockQuota(client, tenantId);
      await client.query(
        `
        SELECT 1
          FROM e_mate_model_usage_task
         WHERE tenant_id = $1 AND user_id = $2 AND task_id = $3
         FOR UPDATE
      `,
        [tenantId, userId, taskId]
      );
      const current = await client.query<Pick<InvocationRow, 'status' | 'reconcile_lease_token'>>(
        `
        SELECT status, reconcile_lease_token
          FROM e_mate_model_invocation
         WHERE invocation_id = $1
           AND tenant_id = $2 AND user_id = $3 AND task_id = $4
         FOR UPDATE
      `,
        [invocationId, tenantId, userId, taskId]
      );
      const invocation = current.rows[0];
      if (!invocation) throw new Error('Invocation was not found');
      if (invocation.status === 'COMPLETED') {
        throw new Error('Completed invocation cannot be rejected');
      }
      if (
        invocation.status === 'PREPARED' &&
        leaseToken !== undefined &&
        invocation.reconcile_lease_token !== leaseToken
      ) {
        throw new Error('Invocation reconciliation lease changed');
      }
      if (invocation.status === 'PREPARED') {
        const rejectedAt = await this.#databaseNow(client);
        await client.query(
          `
          UPDATE e_mate_model_invocation
             SET status = 'REJECTED',
                 reconcile_after = NULL,
                 reconcile_lease_token = NULL,
                 quota_released_at = greatest($2, quota_admitted_at),
                 finished_at = greatest($2, quota_admitted_at)
           WHERE invocation_id = $1
        `,
          [invocationId, rejectedAt]
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async add(value: UsageFact): Promise<void> {
    const fact = validateFact(value);
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      await this.#add(client, fact);
      await client.query('COMMIT');
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async #add(client: PoolClient, fact: UsageFact, allowPrepared = false, recordedAt?: Date): Promise<void> {
    await client.query(
      `
        INSERT INTO e_mate_model_usage_task (
          tenant_id, user_id, task_id, trace_id, model_id, provider_id, status
        )
        VALUES ($1,$2,$3,$4,$5,$6,'ACCUMULATING')
        ON CONFLICT DO NOTHING
      `,
      [fact.tenantId, fact.userId, fact.taskId, fact.traceId, fact.modelId, fact.providerId]
    );
    const task = await client.query<TaskRow>(
      `
        SELECT tenant_id, user_id, task_id, trace_id, model_id, provider_id,
               status, input_tokens, output_tokens, cache_read_tokens,
               cache_write_tokens, cost_usd, usage_id, finalized_at
          FROM e_mate_model_usage_task
         WHERE tenant_id = $1 AND user_id = $2 AND task_id = $3
         FOR UPDATE
      `,
      [fact.tenantId, fact.userId, fact.taskId]
    );
    const taskRow = task.rows[0];
    if (
      !taskRow ||
      taskRow.trace_id !== fact.traceId ||
      taskRow.model_id !== fact.modelId ||
      taskRow.provider_id !== fact.providerId
    ) {
      throw new Error('Task usage scope changed');
    }
    if (!allowPrepared) {
      const pending = await client.query(
        `
          SELECT 1
            FROM e_mate_model_invocation
           WHERE tenant_id = $1 AND user_id = $2 AND task_id = $3
             AND status = 'PREPARED'
           LIMIT 1
        `,
        [fact.tenantId, fact.userId, fact.taskId]
      );
      if (pending.rowCount) {
        throw new Error('Invocation completion is required');
      }
    }
    const replay = await client.query<AttemptRow>(
      `
        SELECT trace_id, model_id, provider_id, input_tokens, output_tokens,
               cache_read_tokens, cache_write_tokens, cost_usd
          FROM e_mate_model_usage_attempt
         WHERE tenant_id = $1
           AND user_id = $2
           AND task_id = $3
           AND provider_response_id = $4
         LIMIT 1
      `,
      [fact.tenantId, fact.userId, fact.taskId, fact.providerResponseId]
    );
    if (replay.rows[0]) {
      if (!sameAttempt(replay.rows[0], fact)) {
        throw new Error('Usage attempt idempotency conflict');
      }
      return;
    }
    if (taskRow.status !== 'ACCUMULATING') {
      throw new Error('Task usage was already finalized');
    }
    await client.query(
      `
        INSERT INTO e_mate_model_usage_attempt (
          tenant_id, user_id, task_id, provider_response_id, trace_id,
          model_id, provider_id, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, cost_usd, recorded_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,COALESCE($13::timestamptz, now()))
      `,
      [
        fact.tenantId,
        fact.userId,
        fact.taskId,
        fact.providerResponseId,
        fact.traceId,
        fact.modelId,
        fact.providerId,
        fact.inputTokens,
        fact.outputTokens,
        fact.cacheReadTokens,
        fact.cacheWriteTokens,
        fact.costUsd,
        recordedAt ?? null,
      ]
    );
    await client.query(
      `
        UPDATE e_mate_model_usage_task
           SET input_tokens = input_tokens + $4,
               output_tokens = output_tokens + $5,
               cache_read_tokens = cache_read_tokens + $6,
               cache_write_tokens = cache_write_tokens + $7,
               cost_usd = cost_usd + $8,
               updated_at = now()
         WHERE tenant_id = $1 AND user_id = $2 AND task_id = $3
      `,
      [
        fact.tenantId,
        fact.userId,
        fact.taskId,
        fact.inputTokens,
        fact.outputTokens,
        fact.cacheReadTokens,
        fact.cacheWriteTokens,
        fact.costUsd,
      ]
    );
  }

  async ingestAuditUsage(records: AuditUsageRecord[]): Promise<AuditUsageReceipt[]> {
    const factIds = new Set<string>();
    const input = records.map((record) => {
      const fact = validateFact(record.fact);
      const occurredAt = new Date(record.occurredAt);
      if (
        !/^auditfact_[0-9a-f]{64}$/.test(record.factId) ||
        !/^[0-9a-f]{64}$/.test(record.payloadSha256) ||
        fact.providerResponseId !== record.factId ||
        factIds.has(record.factId) ||
        Number.isNaN(occurredAt.getTime())
      ) {
        throw new Error('Invalid audit usage record');
      }
      factIds.add(record.factId);
      return {
        ...record,
        fact,
        occurredAt,
        receiptId: `auditreceipt_${createHash('sha256').update(record.factId).digest('hex')}`,
        requestDigest: createHash('sha256').update(record.payloadSha256).digest('base64url'),
        routeFingerprint: createHash('sha256').update(fact.modelId).digest('base64url'),
      };
    });
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const receipts: AuditUsageReceipt[] = [];
      for (const record of input) {
        const existing = await client.query<AuditInvocationRow>(
          `
          SELECT invocation_id, tenant_id, user_id, task_id, trace_id,
                 model_id, provider_id, request_digest, route_fingerprint,
                 status, provider_response_id, quota_admitted_at
            FROM e_mate_model_invocation
           WHERE invocation_id = $1
           FOR UPDATE
        `,
          [record.receiptId]
        );
        const current = existing.rows[0];
        if (
          current && (
            current.tenant_id !== record.fact.tenantId ||
            current.user_id !== record.fact.userId ||
            current.task_id !== record.fact.taskId ||
            current.trace_id !== record.fact.traceId ||
            current.model_id !== record.fact.modelId ||
            current.provider_id !== record.fact.providerId ||
            current.request_digest !== record.requestDigest ||
            current.route_fingerprint !== record.routeFingerprint ||
            current.status !== 'COMPLETED' ||
            current.provider_response_id !== record.factId
          )
        ) {
          throw new AuditUsageConflictError('Audit usage fact conflicts with the existing invocation');
        }
        try {
          await this.#add(client, record.fact, true, record.occurredAt);
        } catch (error) {
          if (
            error instanceof Error &&
            /idempotency conflict|scope changed|already finalized|completion is required/i.test(error.message)
          ) {
            throw new AuditUsageConflictError('Audit usage fact conflicts with the existing ledger');
          }
          throw error;
        }
        if (!current) {
          const acceptedAt = await this.#databaseNow(client);
          await client.query(
            `
            INSERT INTO e_mate_model_invocation (
              invocation_id, tenant_id, user_id, task_id, trace_id, model_id,
              provider_id, request_digest, route_fingerprint, status,
              provider_response_id, prepared_at, quota_admitted_at,
              quota_expires_at, quota_released_at, finished_at
            )
            VALUES (
              $1,$2,$3,$4,$5,$6,$7,$8,$9,'COMPLETED',$10,
              $11,$12,$12,$12,$11
            )
            ON CONFLICT (invocation_id) DO NOTHING
          `,
            [
              record.receiptId,
              record.fact.tenantId,
              record.fact.userId,
              record.fact.taskId,
              record.fact.traceId,
              record.fact.modelId,
              record.fact.providerId,
              record.requestDigest,
              record.routeFingerprint,
              record.factId,
              record.occurredAt,
              acceptedAt,
            ]
          );
        }
        const recorded = await client.query<AuditInvocationRow>(
          `
          SELECT invocation_id, tenant_id, user_id, task_id, trace_id,
                 model_id, provider_id, request_digest, route_fingerprint,
                 status, provider_response_id, quota_admitted_at
            FROM e_mate_model_invocation
           WHERE invocation_id = $1
           FOR UPDATE
        `,
          [record.receiptId]
        );
        const row = recorded.rows[0];
        if (
          !row ||
          row.tenant_id !== record.fact.tenantId ||
          row.user_id !== record.fact.userId ||
          row.task_id !== record.fact.taskId ||
          row.trace_id !== record.fact.traceId ||
          row.model_id !== record.fact.modelId ||
          row.provider_id !== record.fact.providerId ||
          row.request_digest !== record.requestDigest ||
          row.route_fingerprint !== record.routeFingerprint ||
          row.status !== 'COMPLETED' ||
          row.provider_response_id !== record.factId ||
          !(row.quota_admitted_at instanceof Date)
        ) {
          throw new AuditUsageConflictError('Audit usage fact conflicts with the recorded invocation');
        }
        const usageId = `auditusage_${createHash('sha256').update(record.factId).digest('hex')}`;
        const finalized = await client.query<Pick<TaskRow, 'status' | 'usage_id' | 'finalized_at'>>(
          `
          UPDATE e_mate_model_usage_task
             SET status = 'FINALIZED',
                 usage_id = $4,
                 finalized_at = $5,
                 updated_at = now()
           WHERE tenant_id = $1 AND user_id = $2 AND task_id = $3
             AND status = 'ACCUMULATING'
       RETURNING status, usage_id, finalized_at
        `,
          [record.fact.tenantId, record.fact.userId, record.fact.taskId, usageId, record.occurredAt]
        );
        const usageTask = finalized.rows[0] ?? (
          await client.query<Pick<TaskRow, 'status' | 'usage_id' | 'finalized_at'>>(
            `
            SELECT status, usage_id, finalized_at
              FROM e_mate_model_usage_task
             WHERE tenant_id = $1 AND user_id = $2 AND task_id = $3
             FOR UPDATE
          `,
            [record.fact.tenantId, record.fact.userId, record.fact.taskId]
          )
        ).rows[0];
        if (
          !usageTask ||
          usageTask.status !== 'FINALIZED' ||
          usageTask.usage_id !== usageId ||
          usageTask.finalized_at?.getTime() !== record.occurredAt.getTime()
        ) {
          throw new AuditUsageConflictError('Audit usage fact conflicts with the finalized ledger');
        }
        receipts.push({
          factId: record.factId,
          payloadSha256: record.payloadSha256,
          receiptId: record.receiptId,
          acceptedAt: row.quota_admitted_at.toISOString(),
        });
      }
      await client.query('COMMIT');
      return receipts;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async ingestAuditTasks(records: AuditTaskRecord[]): Promise<AuditTaskReceipt[]> {
    const eventIds = new Set<string>();
    const input = records.map((record) => {
      const occurredAt = new Date(record.event.occurredAt);
      if (
        !identifierPattern.test(record.tenantId) ||
        !identifierPattern.test(record.userId) ||
        !/^taskevent_[0-9a-f]{64}$/.test(record.event.eventId) ||
        !identifierPattern.test(record.event.taskId) ||
        !taskScenarios.has(record.event.scenario) ||
        !/^[0-9a-f]{64}$/.test(record.payloadSha256) ||
        eventIds.has(record.event.eventId) ||
        Number.isNaN(occurredAt.getTime())
      ) {
        throw new Error('Invalid task audit record');
      }
      eventIds.add(record.event.eventId);
      return {
        ...record,
        occurredAt,
        receiptId: `taskreceipt_${createHash('sha256').update(record.event.eventId).digest('hex')}`,
      };
    });
    const terminal = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const receipts: AuditTaskReceipt[] = [];
      for (const record of input) {
        const existing = await client.query<TaskAuditEventRow>(
          `SELECT user_id, task_id, type, scenario, occurred_at, recorded_at
             FROM e_mate_task_event
            WHERE tenant_id = $1 AND event_id = $2
            FOR UPDATE`,
          [record.tenantId, record.event.eventId]
        );
        const current = existing.rows[0];
        if (current) {
          if (
            current.user_id !== record.userId ||
            current.task_id !== record.event.taskId ||
            current.type !== record.event.type ||
            current.scenario !== record.event.scenario ||
            current.occurred_at.toISOString() !== record.event.occurredAt
          ) {
            throw new AuditTaskConflictError('Task audit event conflicts with the existing ledger');
          }
          receipts.push({
            eventId: record.event.eventId,
            payloadSha256: record.payloadSha256,
            receiptId: record.receiptId,
            acceptedAt: current.recorded_at.toISOString(),
          });
          continue;
        }
        if (record.event.type === 'RECEIVED') {
          const inserted = await client.query(
            `INSERT INTO e_mate_task_fact (
               tenant_id, task_id, user_id, scenario, received_event_id, received_at, status
             ) VALUES ($1,$2,$3,$4,$5,$6,'RECEIVED')
             ON CONFLICT DO NOTHING`,
            [
              record.tenantId,
              record.event.taskId,
              record.userId,
              record.event.scenario,
              record.event.eventId,
              record.event.occurredAt,
            ]
          );
          if (inserted.rowCount !== 1) {
            throw new AuditTaskConflictError('Task audit receive conflicts with the existing task');
          }
        } else {
          const taskResult = await client.query<TaskAuditFactRow>(
            `SELECT user_id, scenario, status, received_at, terminal_at
               FROM e_mate_task_fact
              WHERE tenant_id = $1 AND task_id = $2
              FOR UPDATE`,
            [record.tenantId, record.event.taskId]
          );
          const task = taskResult.rows[0];
          if (
            !task ||
            task.user_id !== record.userId ||
            task.scenario !== record.event.scenario ||
            task.status !== 'RECEIVED' ||
            record.occurredAt.getTime() < task.received_at.getTime() ||
            task.terminal_at !== null
          ) {
            throw new AuditTaskConflictError('Task audit event has no compatible received task');
          }
        }
        const inserted = await client.query<{ recorded_at: Date }>(
          `INSERT INTO e_mate_task_event (
             tenant_id, event_id, task_id, user_id, type, scenario, occurred_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7)
           RETURNING recorded_at`,
          [
            record.tenantId,
            record.event.eventId,
            record.event.taskId,
            record.userId,
            record.event.type,
            record.event.scenario,
            record.event.occurredAt,
          ]
        );
        const recordedAt = inserted.rows[0]?.recorded_at;
        if (!(recordedAt instanceof Date)) throw new Error('Task audit receipt time was unavailable');
        if (terminal.has(record.event.type)) {
          await client.query(
            `UPDATE e_mate_task_fact
                SET status = $3, terminal_event_id = $4, terminal_at = $5
              WHERE tenant_id = $1 AND task_id = $2`,
            [
              record.tenantId,
              record.event.taskId,
              record.event.type,
              record.event.eventId,
              record.event.occurredAt,
            ]
          );
        }
        receipts.push({
          eventId: record.event.eventId,
          payloadSha256: record.payloadSha256,
          receiptId: record.receiptId,
          acceptedAt: recordedAt.toISOString(),
        });
      }
      await client.query('COMMIT');
      return receipts;
    } catch (error) {
      await rollback(client);
      if ((error as { code?: unknown }).code === '23505') {
        throw new AuditTaskConflictError('Task audit event conflicts with the existing ledger');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async finalize(principal: ModelGatewayPrincipal, taskIdInput: string): Promise<FinalizedUsage | null> {
    const tenantId = identifier(principal.tenantId, 'tenant id');
    const userId = identifier(principal.userId, 'user id');
    const taskId = identifier(taskIdInput, 'task id');
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query<TaskRow>(
        `
        SELECT tenant_id, user_id, task_id, trace_id, model_id, provider_id,
               status, input_tokens, output_tokens, cache_read_tokens,
               cache_write_tokens, cost_usd, usage_id, finalized_at
          FROM e_mate_model_usage_task
         WHERE tenant_id = $1 AND user_id = $2 AND task_id = $3
         FOR UPDATE
      `,
        [tenantId, userId, taskId]
      );
      let row = current.rows[0];
      if (!row) {
        await client.query('COMMIT');
        return null;
      }
      if (row.status === 'ACCUMULATING') {
        const pending = await client.query(
          `
          SELECT 1
            FROM e_mate_model_invocation
           WHERE tenant_id = $1 AND user_id = $2 AND task_id = $3
             AND status = 'PREPARED'
           LIMIT 1
        `,
          [tenantId, userId, taskId]
        );
        if (pending.rowCount) {
          throw new Error('Task invocation requires reconciliation');
        }
        const attempts = await client.query(
          `
          SELECT 1
            FROM e_mate_model_usage_attempt
           WHERE tenant_id = $1 AND user_id = $2 AND task_id = $3
           LIMIT 1
        `,
          [tenantId, userId, taskId]
        );
        if (!attempts.rowCount) {
          await client.query('COMMIT');
          return null;
        }
        const finalized = await client.query<TaskRow>(
          `
          UPDATE e_mate_model_usage_task
             SET status = 'FINALIZED',
                 usage_id = $4,
                 finalized_at = now(),
                 updated_at = now()
           WHERE tenant_id = $1 AND user_id = $2 AND task_id = $3
          RETURNING tenant_id, user_id, task_id, trace_id, model_id,
                    provider_id, status, input_tokens, output_tokens,
                    cache_read_tokens, cache_write_tokens, cost_usd,
                    usage_id, finalized_at
        `,
          [tenantId, userId, taskId, randomUUID()]
        );
        row = finalized.rows[0];
      }
      if (!row) throw new Error('Usage finalization failed');
      await client.query('COMMIT');
      return mapFinalized(row);
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

function postgresUrl(value: string): string {
  const url = new URL(value);
  const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname);
  const privateService = url.hostname === 'postgres';
  const queryValid =
    loopback || privateService
      ? !url.search
      : url.searchParams.size === 1 && url.searchParams.get('sslmode') === 'require';
  if ((url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') || !url.hostname || url.hash || !queryValid) {
    throw new Error('PostgreSQL URL was invalid');
  }
  return url.toString();
}

export async function openPostgresUsageStore(
  url: string,
  limits: InvocationLimits
): Promise<{
  store: PostgresUsageStore;
  close: () => Promise<void>;
}> {
  const connectionString = postgresUrl(url);
  const hostname = new URL(connectionString).hostname;
  const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname);
  const privateService = hostname === 'postgres';
  const pool = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ...(loopback || privateService ? {} : { ssl: { rejectUnauthorized: true } }),
  });
  pool.on('error', () => undefined);
  const store = new PostgresUsageStore(pool, limits);
  try {
    await store.initialize();
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
  return { store, close: () => pool.end() };
}
