import { createHash, randomUUID, sign, type KeyObject } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import {
  isDefaultEnabledModelRoute,
  isRetiredModelRoute,
  modelSupportsClient,
  parseConsentAcceptanceInput,
  type ConsentAcceptanceInput,
} from '@e-mate/admin-contract';
import { ConsentStoreError, type ConsentStore } from '@e-mate/consent-store';
import { parseTaskEventInput, type TaskEventInput } from '@e-mate/monitoring-contract';
import { chatCompletionsToResponsesStream, responsesToChatCompletionsRequest, nativeChatCompletionsRequest, chatCompletionUsageEvent } from './chat-completions-adapter.ts';
import {
  createImageObservation,
  imageFailureCode,
  type ImageCorrelation,
  type ImageFailureCode,
  type ImageObservation,
} from './image-observability.ts';
import {
  parseUsageActivityQuery,
  projectUsageActivity,
  usageActivityDate,
  type UsageActivity,
  type UsageActivityLedgerDay,
  type UsageActivityQuery,
} from './activity-contract.ts';

const maxRequestBytes = 4 * 1024 * 1024;
// Keep below the deployed 50 MiB reverse-proxy fence; model JSON carries base64 images.
export const MAX_RESPONSES_REQUEST_BYTES = 48 * 1024 * 1024;
const maxLargeResponsesInFlight = 2;
const maxAuditRequestBytes = 512 * 1024;
const maxAuditBatchSize = 64;
const maxAuditTokenCount = 1_000_000_000_000;
const maxImageEditRequestBytes = 84 * 1024 * 1024;
const maxImageEditBytes = 5 * 1024 * 1024;
const maxImageEditInputs = 16;
const imageEditMediaTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type ModelGatewayPrincipal = {
  tenantId: string;
  userId: string;
  roles?: Array<'TENANT_ADMIN' | 'AUDIT_ADMIN' | 'MEMBER'>;
  modelIds: string[];
  sessionId?: string;
};

export type ModelGatewayRoute = {
  id: string;
  apiMode?: 'responses' | 'chat-completions' | 'images-generations';
  upstreamModelId: string;
  upstreamBaseUrl: string;
  allowInsecureHttpUpstream?: true;
  upstreamApiKey: string;
  providerId: string;
  label: string;
  buttonLabel: string;
  provider: string;
  providerMark: string;
  reasoning: boolean;
  input: Array<'text' | 'image'>;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  remoteCompactionV2?: boolean;
  nativeChatCompletions?: true;
};

const fixedReasoningEffort = (routeId: string): 'high' | 'medium' | 'low' =>
  (routeId === 'gpt-5.6-luna' ? 'high' : routeId === 'gpt-6-astra' ? 'low' : 'medium');

const managedCodexModelIds = new Set([
  'gpt-5.6-luna',
  'gpt-5.6-sol',
  'gpt-6-astra',
  'deepseek',
]);
const runtimeModelsClientVersions = new Set(['2.0.12', '2.0.13', '2.0.14', '2.0.15', '2.0.16', '2.0.17', '2.0.18']);
const modelSessionJwtPattern = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

const deepSeekSearchCredentialRouteId = 'deepseek-web-search';
const deepSeekSearchProviderId = 'deepseek-official';
const deepSeekSearchBaseUrl = 'https://api.deepseek.com/anthropic/v1';
const deepSeekSearchModelId = 'deepseek-v4-flash';

const runtimeApiMode = (route: ModelGatewayRoute): 'responses' | 'chat-completions' =>
  route.apiMode === 'chat-completions' ? 'chat-completions' : 'responses';

const eMateAgentBaseInstructions = `You are 小芯, the all-purpose office and creative agent developed by 亦芯 for e-Mate. Work with the user until the requested outcome is genuinely handled. Follow all session, developer, Skill, and tool instructions injected by e-Mate. Use only capabilities actually available in the current session, respect workspace and permission boundaries, and request authorization before side effects. Never fabricate tool results, tests, files, sources, or completion; verify deliverables and report partial failures accurately. Protect user data and hidden reasoning, exposing only safe progress summaries. Never expose internal runtime or provider brands. Respond in Chinese unless the user requests another language.`;

type CodexCatalogRoute = Pick<
  ModelGatewayRoute,
  'buttonLabel' | 'contextWindow' | 'id' | 'input' | 'label' | 'provider' | 'reasoning'
>;

/** Managed Codex clients require a complete ModelInfo payload for client-version catalog requests. */
function codexModelInfo(route: CodexCatalogRoute, priority: number) {
  const reasoningEffort = fixedReasoningEffort(route.id);
  return {
    slug: route.id,
    display_name: route.label,
    description: `${route.label} · ${route.provider}`,
    default_reasoning_level: route.reasoning ? reasoningEffort : null,
    supported_reasoning_levels: route.reasoning ? [{ effort: reasoningEffort, description: route.buttonLabel }] : [],
    shell_type: 'shell_command',
    visibility: 'list',
    supported_in_api: true,
    priority,
    additional_speed_tiers: [],
    service_tiers: [],
    availability_nux: null,
    upgrade: null,
    base_instructions: eMateAgentBaseInstructions,
    model_messages: null,
    include_skills_usage_instructions: false,
    supports_reasoning_summary_parameter: route.reasoning,
    default_reasoning_summary: route.reasoning ? 'auto' : 'none',
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: 'freeform',
    web_search_tool_type: 'text',
    truncation_policy: { mode: 'tokens', limit: 10_000 },
    supports_parallel_tool_calls: true,
    supports_image_detail_original: route.input.includes('image'),
    context_window: route.contextWindow,
    max_context_window: route.contextWindow,
    auto_compact_token_limit: null,
    experimental_supported_tools: [],
    input_modalities: route.input,
    supports_search_tool: true,
    use_responses_lite: false,
  };
}

export type UsageFact = {
  tenantId: string;
  userId: string;
  taskId: string;
  traceId: string;
  modelId: string;
  providerId: string;
  providerResponseId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
};

export type InvocationFact = Pick<
  UsageFact,
  'tenantId' | 'userId' | 'taskId' | 'traceId' | 'modelId' | 'providerId'
> & {
  requestDigest: string;
  routeFingerprint: string;
  imageTraffic?: 'single' | 'batch';
};

export const IMAGE_ADMISSION_RETRY_MS = 1_000;
export const IMAGE_SINGLE_WAIT_TTL_MS = 30_000;

export type PreparedInvocation = {
  status: 'STARTED' | 'PENDING' | 'RECORDED';
  invocationId: string;
};

export type InvocationLimits = {
  tenantRequestsPerMinute: number;
  tenantBurst: number;
  tenantMaxConcurrent: number;
  invocationLeaseMs: number;
};

export class InvocationRequestConflictError extends Error {}

export class InvocationAdmissionError extends Error {
  readonly code: 'TENANT_REQUEST_RATE_LIMITED' | 'TENANT_CONCURRENCY_LIMITED' | 'USER_TOKEN_LIMIT_REACHED';
  readonly retryAfterMs: number;

  constructor(code: InvocationAdmissionError['code'], retryAfterMs: number) {
    super(
      code === 'TENANT_REQUEST_RATE_LIMITED'
        ? 'Model request rate limit reached'
        : code === 'TENANT_CONCURRENCY_LIMITED'
          ? 'Too many model requests are already running'
          : 'User token limit reached'
    );
    this.code = code;
    this.retryAfterMs = Math.min(3_600_000, Math.max(1_000, Math.ceil(retryAfterMs)));
  }
}

export type ReconciliationClaim = {
  fact: InvocationFact;
  leaseToken: string;
};

export type ProviderInvocationReceiptRequest = {
  invocationId: string;
  requestDigest: string;
  routeFingerprint: string;
  providerId: string;
  modelId: string;
  upstreamModelId: string;
  upstreamBaseUrl: string;
  upstreamApiKey: string;
  signal: AbortSignal;
};

export type ProviderInvocationReceipt =
  | {
      status: 'PENDING' | 'UNKNOWN' | 'NOT_ACCEPTED';
      invocationId: string;
      requestDigest: string;
      routeFingerprint: string;
    }
  | {
      status: 'ACCOUNTED';
      invocationId: string;
      requestDigest: string;
      routeFingerprint: string;
      response: unknown;
    };

export type FinalizedUsage = Omit<UsageFact, 'providerResponseId'> & {
  usageId: string;
  occurredAt: string;
};

export type AccountUsage = {
  totalTokens: number;
  weekStartedAt: string;
  calculatedAt: string;
};

export type AuditUsageRecord = {
  factId: string;
  payloadSha256: string;
  occurredAt: string;
  fact: UsageFact;
};

export type AuditUsageReceipt = {
  factId: string;
  payloadSha256: string;
  receiptId: string;
  acceptedAt: string;
};

export class AuditUsageConflictError extends Error {}

export type AuditTaskRecord = {
  tenantId: string;
  userId: string;
  payloadSha256: string;
  event: TaskEventInput;
};

export type AuditTaskReceipt = {
  eventId: string;
  payloadSha256: string;
  receiptId: string;
  acceptedAt: string;
};

export class AuditTaskConflictError extends Error {}

export type UsageStore = {
  currentAccountUsage(principal: ModelGatewayPrincipal): Promise<AccountUsage>;
  accountUsageActivity(principal: ModelGatewayPrincipal, query: UsageActivityQuery): Promise<UsageActivity>;
  prepare(fact: InvocationFact): Promise<PreparedInvocation>;
  claimReconciliation(
    principal: ModelGatewayPrincipal,
    taskId: string,
    invocationId: string,
    routeFingerprint: string
  ): Promise<ReconciliationClaim | null>;
  complete(invocationId: string, fact: UsageFact): Promise<void>;
  completeReconciliation(invocationId: string, leaseToken: string, fact: UsageFact): Promise<void>;
  renewReconciliation(
    principal: ModelGatewayPrincipal,
    taskId: string,
    invocationId: string,
    leaseToken: string
  ): Promise<boolean>;
  reject(principal: ModelGatewayPrincipal, taskId: string, invocationId: string): Promise<void>;
  rejectReconciliation(
    principal: ModelGatewayPrincipal,
    taskId: string,
    invocationId: string,
    leaseToken: string
  ): Promise<void>;
  add(fact: UsageFact): Promise<void>;
  ingestAuditUsage(records: AuditUsageRecord[]): Promise<AuditUsageReceipt[]>;
  ingestAuditTasks(records: AuditTaskRecord[]): Promise<AuditTaskReceipt[]>;
  finalize(principal: ModelGatewayPrincipal, taskId: string): Promise<FinalizedUsage | null>;
};

type InvocationState = 'PREPARED' | 'COMPLETED' | 'REJECTED';

type InvocationScope = Pick<InvocationFact, 'tenantId' | 'userId' | 'taskId' | 'traceId' | 'modelId' | 'providerId'>;

type InMemoryUsageEntry = {
  scope: InvocationScope;
  fact?: UsageFact;
  attempts: Map<string, { fact: UsageFact; occurredAt: number }>;
  invocations: Map<
    string,
    {
      fact: InvocationFact;
      state: InvocationState;
      reconcileAfter?: number;
      reconcileLeaseToken?: string;
      quotaExpiresAt: number;
      quotaReleased: boolean;
      finishedAt?: string;
    }
  >;
  finalized?: FinalizedUsage;
};

type InMemoryQuotaState = {
  tokens: number;
  lastRefillAt: number;
  singleImageWaitUntil?: number;
};

export function validateInvocationLimits(value: InvocationLimits): InvocationLimits {
  if (
    !Number.isSafeInteger(value.tenantRequestsPerMinute) ||
    value.tenantRequestsPerMinute < 1 ||
    value.tenantRequestsPerMinute > 1_000_000 ||
    !Number.isSafeInteger(value.tenantBurst) ||
    value.tenantBurst < 1 ||
    value.tenantBurst > 1_000_000 ||
    !Number.isSafeInteger(value.tenantMaxConcurrent) ||
    value.tenantMaxConcurrent < 1 ||
    value.tenantMaxConcurrent > 10_000 ||
    !Number.isSafeInteger(value.invocationLeaseMs) ||
    value.invocationLeaseMs < 1_000 ||
    value.invocationLeaseMs > 86_400_000
  ) {
    throw new Error('Invalid invocation limits');
  }
  return { ...value };
}

function sameUsageFact(left: UsageFact, right: UsageFact): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.userId === right.userId &&
    left.taskId === right.taskId &&
    left.traceId === right.traceId &&
    left.modelId === right.modelId &&
    left.providerId === right.providerId &&
    left.providerResponseId === right.providerResponseId &&
    left.inputTokens === right.inputTokens &&
    left.outputTokens === right.outputTokens &&
    left.cacheReadTokens === right.cacheReadTokens &&
    left.cacheWriteTokens === right.cacheWriteTokens &&
    left.costUsd === right.costUsd
  );
}

function normalizeInvocationFact(value: InvocationFact): InvocationFact {
  if (
    !identifierPattern.test(value.tenantId) ||
    !identifierPattern.test(value.userId) ||
    !identifierPattern.test(value.taskId) ||
    !identifierPattern.test(value.traceId) ||
    !identifierPattern.test(value.modelId) ||
    !identifierPattern.test(value.providerId) ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.requestDigest) ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.routeFingerprint) ||
    (value.imageTraffic !== undefined && value.imageTraffic !== 'single' && value.imageTraffic !== 'batch')
  ) {
    throw new Error('Invalid invocation fact');
  }
  return { ...value };
}

function sameInvocationScope(left: InvocationScope, right: InvocationScope): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.userId === right.userId &&
    left.taskId === right.taskId &&
    left.traceId === right.traceId &&
    left.modelId === right.modelId &&
    left.providerId === right.providerId
  );
}

function normalizeUsageFact(value: UsageFact): UsageFact {
  const counts = [value.inputTokens, value.outputTokens, value.cacheReadTokens, value.cacheWriteTokens];
  if (
    !identifierPattern.test(value.tenantId) ||
    !identifierPattern.test(value.userId) ||
    !identifierPattern.test(value.taskId) ||
    !identifierPattern.test(value.traceId) ||
    !identifierPattern.test(value.modelId) ||
    !identifierPattern.test(value.providerId) ||
    !identifierPattern.test(value.providerResponseId) ||
    counts.some((count) => !Number.isSafeInteger(count) || count < 0) ||
    !Number.isSafeInteger(counts.reduce((total, count) => total + count, 0)) ||
    !Number.isFinite(value.costUsd) ||
    value.costUsd < 0 ||
    value.costUsd > 1_000_000
  ) {
    throw new Error('Invalid usage fact');
  }
  return { ...value, costUsd: Number(value.costUsd.toFixed(12)) };
}

export class InMemoryUsageStore implements UsageStore {
  readonly #facts = new Map<string, InMemoryUsageEntry>();
  readonly #limits: InvocationLimits;
  readonly #now: () => number;
  readonly #quota = new Map<string, InMemoryQuotaState>();
  readonly #weeklyUsage = new Map<string, number>();
  readonly #auditReceipts = new Map<string, AuditUsageReceipt>();
  readonly #taskAuditEvents = new Map<string, AuditTaskRecord & { acceptedAt: string }>();
  readonly #taskAuditStates = new Map<string, { userId: string; scenario: string; terminal: boolean }>();

  constructor(limits: InvocationLimits, now: () => number = Date.now) {
    this.#limits = validateInvocationLimits(limits);
    this.#now = now;
  }

  #tenantNow(tenantId: string): number {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new Error('Invalid quota clock');
    }
    return Math.max(now, this.#quota.get(tenantId)?.lastRefillAt ?? now);
  }

  #weekStartedAt(now: number): string {
    const date = new Date(now);
    const day = (date.getUTCDay() + 6) % 7;
    date.setUTCDate(date.getUTCDate() - day);
    date.setUTCHours(0, 0, 0, 0);
    return date.toISOString();
  }

  async currentAccountUsage(principal: ModelGatewayPrincipal): Promise<AccountUsage> {
    const now = this.#tenantNow(principal.tenantId);
    const weekStartedAt = this.#weekStartedAt(now);
    return {
      totalTokens: this.#weeklyUsage.get(`${principal.tenantId}\0${principal.userId}\0${weekStartedAt}`) ?? 0,
      weekStartedAt,
      calculatedAt: new Date(now).toISOString(),
    };
  }

  async accountUsageActivity(
    principal: ModelGatewayPrincipal,
    query: UsageActivityQuery
  ): Promise<UsageActivity> {
    const buckets = new Map<string, [bigint, bigint, bigint, bigint]>();
    for (const entry of this.#facts.values()) {
      if (entry.scope.tenantId !== principal.tenantId || entry.scope.userId !== principal.userId) continue;
      for (const { fact, occurredAt } of entry.attempts.values()) {
        const date = usageActivityDate(occurredAt, query.timezone);
        if (date < query.startDate || date > query.endDate) continue;
        const current = buckets.get(date) ?? [0n, 0n, 0n, 0n];
        current[0] += BigInt(fact.inputTokens);
        current[1] += BigInt(fact.outputTokens);
        current[2] += BigInt(fact.cacheReadTokens);
        current[3] += BigInt(fact.cacheWriteTokens);
        buckets.set(date, current);
      }
    }
    const rows: UsageActivityLedgerDay[] = [...buckets].map(([date, values]) => ({
      date,
      inputTokens: values[0].toString(),
      outputTokens: values[1].toString(),
      cacheReadTokens: values[2].toString(),
      cacheWriteTokens: values[3].toString(),
    }));
    return projectUsageActivity(query, rows, new Date(this.#tenantNow(principal.tenantId)));
  }

  async prepare(value: InvocationFact): Promise<PreparedInvocation> {
    const fact = normalizeInvocationFact(value);
    const key = `${fact.tenantId}\0${fact.userId}\0${fact.taskId}`;
    let entry = this.#facts.get(key);
    if (entry && !sameInvocationScope(entry.scope, fact)) {
      throw new Error('Task usage scope changed');
    }
    const pending = entry
      ? [...entry.invocations.entries()].find(([, invocation]) => invocation.state === 'PREPARED')
      : undefined;
    if (pending) {
      if (pending[1].fact.requestDigest !== fact.requestDigest) {
        throw new InvocationRequestConflictError('Invocation request digest changed');
      }
      return { status: 'PENDING', invocationId: pending[0] };
    }
    const completed = entry
      ? [...entry.invocations.entries()]
          .toReversed()
          .find(
            ([, invocation]) => invocation.state === 'COMPLETED' && invocation.fact.requestDigest === fact.requestDigest
          )
      : undefined;
    if (completed) {
      return { status: 'RECORDED', invocationId: completed[0] };
    }
    if (entry?.finalized) throw new Error('Task usage was already finalized');
    const rejected = entry
      ? [...entry.invocations.entries()]
          .toReversed()
          .find(
            ([, invocation]) => invocation.state === 'REJECTED' && invocation.fact.requestDigest === fact.requestDigest
          )
      : undefined;
    const invocationId = rejected?.[0] ?? randomUUID();
    const now = this.#tenantNow(fact.tenantId);
    const quota: InMemoryQuotaState = this.#quota.get(fact.tenantId) ?? {
      tokens: this.#limits.tenantBurst,
      lastRefillAt: now,
    };
    const elapsed = Math.max(0, now - quota.lastRefillAt);
    quota.tokens = Math.min(
      this.#limits.tenantBurst,
      quota.tokens + (elapsed * this.#limits.tenantRequestsPerMinute) / 60_000
    );
    quota.lastRefillAt = now;
    if (quota.singleImageWaitUntil !== undefined && quota.singleImageWaitUntil <= now) {
      delete quota.singleImageWaitUntil;
    }
    const active = [...this.#facts.values()].reduce(
      (total, current) =>
        current.scope.tenantId !== fact.tenantId
          ? total
          : total +
            [...current.invocations.values()].filter(
              (invocation) =>
                invocation.state === 'PREPARED' && !invocation.quotaReleased && invocation.quotaExpiresAt > now
            ).length,
      0
    );
    if (active >= this.#limits.tenantMaxConcurrent) {
      if (fact.imageTraffic === 'single') {
        quota.singleImageWaitUntil ??= now + IMAGE_SINGLE_WAIT_TTL_MS;
        this.#quota.set(fact.tenantId, quota);
      }
      if (fact.imageTraffic !== undefined) {
        throw new InvocationAdmissionError('TENANT_CONCURRENCY_LIMITED', IMAGE_ADMISSION_RETRY_MS);
      }
      const earliest = Math.min(
        ...[...this.#facts.values()].flatMap((current) =>
          current.scope.tenantId !== fact.tenantId
            ? []
            : [...current.invocations.values()]
                .filter(
                  (invocation) =>
                    invocation.state === 'PREPARED' && !invocation.quotaReleased && invocation.quotaExpiresAt > now
                )
                .map((invocation) => invocation.quotaExpiresAt)
        )
      );
      throw new InvocationAdmissionError('TENANT_CONCURRENCY_LIMITED', earliest - now);
    }
    if (fact.imageTraffic === 'batch' && quota.singleImageWaitUntil !== undefined
      && active === this.#limits.tenantMaxConcurrent - 1) {
      throw new InvocationAdmissionError('TENANT_CONCURRENCY_LIMITED', IMAGE_ADMISSION_RETRY_MS);
    }
    if (quota.tokens < 1) {
      throw new InvocationAdmissionError(
        'TENANT_REQUEST_RATE_LIMITED',
        ((1 - quota.tokens) * 60_000) / this.#limits.tenantRequestsPerMinute
      );
    }
    quota.tokens -= 1;
    if (fact.imageTraffic === 'single') delete quota.singleImageWaitUntil;
    this.#quota.set(fact.tenantId, quota);
    if (!entry) {
      entry = {
        scope: {
          tenantId: fact.tenantId,
          userId: fact.userId,
          taskId: fact.taskId,
          traceId: fact.traceId,
          modelId: fact.modelId,
          providerId: fact.providerId,
        },
        attempts: new Map(),
        invocations: new Map(),
      };
      this.#facts.set(key, entry);
    }
    entry.invocations.set(invocationId, {
      fact,
      state: 'PREPARED',
      quotaExpiresAt: now + this.#limits.invocationLeaseMs,
      quotaReleased: false,
    });
    return { status: 'STARTED', invocationId };
  }

  async complete(invocationId: string, value: UsageFact): Promise<void> {
    return this.#complete(invocationId, value);
  }

  async completeReconciliation(invocationId: string, leaseToken: string, value: UsageFact): Promise<void> {
    return this.#complete(invocationId, value, leaseToken);
  }

  async #complete(invocationId: string, value: UsageFact, leaseToken?: string): Promise<void> {
    const fact = normalizeUsageFact(value);
    const key = `${fact.tenantId}\0${fact.userId}\0${fact.taskId}`;
    const entry = this.#facts.get(key);
    const invocation = entry?.invocations.get(invocationId);
    if (
      !entry ||
      !invocation ||
      !sameInvocationScope(entry.scope, {
        ...fact,
      })
    ) {
      throw new Error('Invocation scope changed');
    }
    if (invocation.state === 'COMPLETED') {
      const replay = entry.attempts.get(fact.providerResponseId);
      if (!replay || !sameUsageFact(replay.fact, fact)) {
        throw new Error('Usage attempt idempotency conflict');
      }
      return;
    }
    if (invocation.state !== 'PREPARED') {
      throw new Error('Invocation was not prepared');
    }
    if (leaseToken !== undefined && invocation.reconcileLeaseToken !== leaseToken) {
      throw new Error('Invocation reconciliation lease changed');
    }
    this.#add(entry, fact);
    invocation.state = 'COMPLETED';
    invocation.reconcileAfter = undefined;
    invocation.reconcileLeaseToken = undefined;
    invocation.quotaReleased = true;
  }

  async claimReconciliation(
    principal: ModelGatewayPrincipal,
    taskId: string,
    invocationId: string,
    routeFingerprint: string
  ): Promise<ReconciliationClaim | null> {
    const key = `${principal.tenantId}\0${principal.userId}\0${taskId}`;
    const invocation = this.#facts.get(key)?.invocations.get(invocationId);
    if (!invocation || invocation.state !== 'PREPARED') return null;
    if (invocation.fact.routeFingerprint !== routeFingerprint) return null;
    const now = this.#tenantNow(invocation.fact.tenantId);
    if ((invocation.reconcileAfter ?? 0) > now) return null;
    const leaseToken = randomUUID();
    invocation.reconcileAfter = now + 30_000;
    invocation.reconcileLeaseToken = leaseToken;
    return { fact: { ...invocation.fact }, leaseToken };
  }

  async renewReconciliation(
    principal: ModelGatewayPrincipal,
    taskId: string,
    invocationId: string,
    leaseToken: string
  ): Promise<boolean> {
    const key = `${principal.tenantId}\0${principal.userId}\0${taskId}`;
    const invocation = this.#facts.get(key)?.invocations.get(invocationId);
    if (!invocation || invocation.state !== 'PREPARED' || invocation.reconcileLeaseToken !== leaseToken) {
      return false;
    }
    const now = this.#tenantNow(principal.tenantId);
    invocation.quotaExpiresAt = Math.max(invocation.quotaExpiresAt, now + this.#limits.invocationLeaseMs);
    return true;
  }

  async reject(principal: ModelGatewayPrincipal, taskId: string, invocationId: string): Promise<void> {
    const key = `${principal.tenantId}\0${principal.userId}\0${taskId}`;
    const invocation = this.#facts.get(key)?.invocations.get(invocationId);
    if (!invocation) throw new Error('Invocation was not found');
    if (invocation.state === 'COMPLETED') {
      throw new Error('Completed invocation cannot be rejected');
    }
    if (invocation.state === 'PREPARED') {
      invocation.state = 'REJECTED';
      invocation.reconcileAfter = undefined;
      invocation.reconcileLeaseToken = undefined;
      invocation.quotaReleased = true;
    }
  }

  async rejectReconciliation(
    principal: ModelGatewayPrincipal,
    taskId: string,
    invocationId: string,
    leaseToken: string
  ): Promise<void> {
    const key = `${principal.tenantId}\0${principal.userId}\0${taskId}`;
    const invocation = this.#facts.get(key)?.invocations.get(invocationId);
    if (!invocation) throw new Error('Invocation was not found');
    if (invocation.state !== 'PREPARED' || invocation.reconcileLeaseToken !== leaseToken) {
      throw new Error('Invocation reconciliation lease changed');
    }
    invocation.state = 'REJECTED';
    invocation.reconcileAfter = undefined;
    invocation.reconcileLeaseToken = undefined;
    invocation.quotaReleased = true;
  }

  async add(value: UsageFact): Promise<void> {
    const fact = normalizeUsageFact(value);
    const key = `${fact.tenantId}\0${fact.userId}\0${fact.taskId}`;
    let entry = this.#facts.get(key);
    if (!entry) {
      entry = {
        scope: {
          tenantId: fact.tenantId,
          userId: fact.userId,
          taskId: fact.taskId,
          traceId: fact.traceId,
          modelId: fact.modelId,
          providerId: fact.providerId,
        },
        attempts: new Map(),
        invocations: new Map(),
      };
      this.#facts.set(key, entry);
    }
    if (
      !sameInvocationScope(entry.scope, {
        ...fact,
      })
    ) {
      throw new Error('Task usage scope changed');
    }
    if ([...entry.invocations.values()].some(({ state }) => state === 'PREPARED')) {
      throw new Error('Invocation completion is required');
    }
    this.#add(entry, fact);
  }

  #add(entry: InMemoryUsageEntry, fact: UsageFact, occurredAt = this.#tenantNow(fact.tenantId)): void {
    const replay = entry?.attempts.get(fact.providerResponseId);
    if (replay) {
      if (!sameUsageFact(replay.fact, fact)) {
        throw new Error('Usage attempt idempotency conflict');
      }
      return;
    }
    if (entry?.finalized) throw new Error('Task usage was already finalized');
    const current = entry?.fact;
    if (
      current &&
      (current.traceId !== fact.traceId || current.modelId !== fact.modelId || current.providerId !== fact.providerId)
    ) {
      throw new Error('Task usage scope changed');
    }
    const totals = [
      (current?.inputTokens ?? 0) + fact.inputTokens,
      (current?.outputTokens ?? 0) + fact.outputTokens,
      (current?.cacheReadTokens ?? 0) + fact.cacheReadTokens,
      (current?.cacheWriteTokens ?? 0) + fact.cacheWriteTokens,
    ];
    const totalTokens = totals.reduce((total, count) => total + count, 0);
    const totalCost = Number(((current?.costUsd ?? 0) + fact.costUsd).toFixed(12));
    if (
      totals.some((count) => !Number.isSafeInteger(count)) ||
      !Number.isSafeInteger(totalTokens) ||
      totalCost > 1_000_000
    ) {
      throw new Error('Task usage exceeds ledger limits');
    }
    const usageKey = `${fact.tenantId}\0${fact.userId}\0${this.#weekStartedAt(occurredAt)}`;
    const nextUsage = (this.#weeklyUsage.get(usageKey) ?? 0) +
      fact.inputTokens + fact.outputTokens + fact.cacheReadTokens + fact.cacheWriteTokens;
    if (!Number.isSafeInteger(nextUsage)) throw new Error('Account usage exceeds its boundary');
    entry.fact = {
      ...fact,
      inputTokens: totals[0] as number,
      outputTokens: totals[1] as number,
      cacheReadTokens: totals[2] as number,
      cacheWriteTokens: totals[3] as number,
      costUsd: totalCost,
    };
    entry.attempts.set(fact.providerResponseId, { fact, occurredAt });
    this.#weeklyUsage.set(usageKey, nextUsage);
  }

  async ingestAuditUsage(records: AuditUsageRecord[]): Promise<AuditUsageReceipt[]> {
    if (records.length < 1 || records.length > maxAuditBatchSize) throw new Error('Invalid audit usage batch');
    const input = records.map((record) => {
      const fact = normalizeUsageFact(record.fact);
      const occurredAt = Date.parse(record.occurredAt);
      if (
        !auditFactIdPattern.test(record.factId) ||
        !auditSha256Pattern.test(record.payloadSha256) ||
        fact.providerResponseId !== record.factId ||
        !Number.isFinite(occurredAt)
      ) {
        throw new Error('Invalid audit usage record');
      }
      return { ...record, fact, occurredAtMs: occurredAt };
    });
    const weeklyDeltas = new Map<string, number>();
    for (const record of input) {
      const receipt = this.#auditReceipts.get(record.factId);
      if (receipt && receipt.payloadSha256 !== record.payloadSha256) {
        throw new AuditUsageConflictError('Audit usage fact conflicts with its recorded payload');
      }
      const entry = this.#facts.get(`${record.fact.tenantId}\0${record.fact.userId}\0${record.fact.taskId}`);
      const replay = entry?.attempts.get(record.fact.providerResponseId);
      if (
        entry && (
          !sameInvocationScope(entry.scope, record.fact) ||
          entry.finalized !== undefined && receipt === undefined ||
          [...entry.invocations.values()].some(({ state }) => state === 'PREPARED') ||
          replay !== undefined && !sameUsageFact(replay.fact, record.fact)
        )
      ) {
        throw new AuditUsageConflictError('Audit usage fact conflicts with the existing ledger');
      }
      if (receipt && !replay) {
        throw new AuditUsageConflictError('Audit usage receipt is missing its ledger fact');
      }
      if (!receipt) {
        const usageKey = `${record.fact.tenantId}\0${record.fact.userId}\0${this.#weekStartedAt(record.occurredAtMs)}`;
        const delta =
          record.fact.inputTokens +
          record.fact.outputTokens +
          record.fact.cacheReadTokens +
          record.fact.cacheWriteTokens;
        const nextDelta = (weeklyDeltas.get(usageKey) ?? 0) + delta;
        if (!Number.isSafeInteger(nextDelta)) throw new Error('Account usage exceeds its boundary');
        weeklyDeltas.set(usageKey, nextDelta);
      }
    }
    for (const [usageKey, delta] of weeklyDeltas) {
      if (!Number.isSafeInteger((this.#weeklyUsage.get(usageKey) ?? 0) + delta)) {
        throw new Error('Account usage exceeds its boundary');
      }
    }

    const acceptedAtMs = this.#now();
    if (!Number.isSafeInteger(acceptedAtMs) || acceptedAtMs < 0) throw new Error('Invalid quota clock');
    const acceptedAt = new Date(acceptedAtMs).toISOString();
    return input.map((record) => {
      const replay = this.#auditReceipts.get(record.factId);
      if (replay) return replay;
      const key = `${record.fact.tenantId}\0${record.fact.userId}\0${record.fact.taskId}`;
      let entry = this.#facts.get(key);
      if (!entry) {
        entry = {
          scope: record.fact,
          attempts: new Map(),
          invocations: new Map(),
        };
        this.#facts.set(key, entry);
      }
      this.#add(entry, record.fact, record.occurredAtMs);
      const receipt: AuditUsageReceipt = {
        factId: record.factId,
        payloadSha256: record.payloadSha256,
        receiptId: `auditreceipt_${createHash('sha256').update(record.factId).digest('hex')}`,
        acceptedAt,
      };
      entry.invocations.set(receipt.receiptId, {
        fact: {
          ...record.fact,
          requestDigest: createHash('sha256').update(record.payloadSha256).digest('base64url'),
          routeFingerprint: createHash('sha256').update(record.fact.modelId).digest('base64url'),
        },
        state: 'COMPLETED',
        quotaExpiresAt: Date.parse(acceptedAt),
        quotaReleased: true,
        finishedAt: record.occurredAt,
      });
      const { providerResponseId: _providerResponseId, ...fact } = entry.fact as UsageFact;
      entry.finalized = {
        ...fact,
        usageId: `auditusage_${createHash('sha256').update(record.factId).digest('hex')}`,
        occurredAt: new Date(record.occurredAtMs).toISOString(),
      };
      this.#auditReceipts.set(record.factId, receipt);
      return receipt;
    });
  }

  async ingestAuditTasks(records: AuditTaskRecord[]): Promise<AuditTaskReceipt[]> {
    const events = new Map(this.#taskAuditEvents);
    const tasks = new Map(this.#taskAuditStates);
    const acceptedAtMs = this.#now();
    if (!Number.isSafeInteger(acceptedAtMs) || acceptedAtMs < 0) throw new Error('Invalid quota clock');
    const acceptedAt = new Date(acceptedAtMs).toISOString();
    const receipts: AuditTaskReceipt[] = [];
    for (const record of records) {
      const eventKey = `${record.tenantId}\0${record.event.eventId}`;
      const taskKey = `${record.tenantId}\0${record.event.taskId}`;
      const existing = events.get(eventKey);
      if (existing) {
        if (canonicalJson(existing.event) !== canonicalJson(record.event)
          || existing.userId !== record.userId
          || existing.payloadSha256 !== record.payloadSha256) {
          throw new AuditTaskConflictError('Task audit event conflicts with the existing ledger');
        }
        receipts.push({
          eventId: record.event.eventId,
          payloadSha256: record.payloadSha256,
          receiptId: `taskreceipt_${createHash('sha256').update(record.event.eventId).digest('hex')}`,
          acceptedAt: existing.acceptedAt,
        });
        continue;
      }
      const task = tasks.get(taskKey);
      if (record.event.type === 'RECEIVED') {
        if (task) throw new AuditTaskConflictError('Task audit receive conflicts with the existing task');
        tasks.set(taskKey, { userId: record.userId, scenario: record.event.scenario, terminal: false });
      } else if (
        !task ||
        task.userId !== record.userId ||
        task.scenario !== record.event.scenario ||
        task.terminal ||
        (['COMPLETED', 'FAILED', 'CANCELLED'].includes(record.event.type) && task.terminal)
      ) {
        throw new AuditTaskConflictError('Task audit event has no compatible received task');
      } else if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(record.event.type)) {
        tasks.set(taskKey, { ...task, terminal: true });
      }
      events.set(eventKey, { ...structuredClone(record), acceptedAt });
      receipts.push({
        eventId: record.event.eventId,
        payloadSha256: record.payloadSha256,
        receiptId: `taskreceipt_${createHash('sha256').update(record.event.eventId).digest('hex')}`,
        acceptedAt,
      });
    }
    this.#taskAuditEvents.clear();
    events.forEach((value, key) => this.#taskAuditEvents.set(key, value));
    this.#taskAuditStates.clear();
    tasks.forEach((value, key) => this.#taskAuditStates.set(key, value));
    return receipts;
  }

  async finalize(principal: ModelGatewayPrincipal, taskId: string): Promise<FinalizedUsage | null> {
    const key = `${principal.tenantId}\0${principal.userId}\0${taskId}`;
    const entry = this.#facts.get(key);
    if (!entry) return null;
    if ([...entry.invocations.values()].some(({ state }) => state === 'PREPARED')) {
      throw new Error('Task invocation requires reconciliation');
    }
    if (!entry.fact) return null;
    if (!entry.finalized) {
      const { providerResponseId, ...fact } = entry.fact;
      entry.finalized = {
        ...fact,
        usageId: randomUUID(),
        occurredAt: new Date().toISOString(),
      };
    }
    return entry.finalized;
  }
}

export function safeProviderTrace(headers: Headers): { header: string; id: string } | undefined {
  for (const header of ['x-request-id', 'request-id', 'openai-request-id', 'x-tt-logid']) {
    const id = headers.get(header);
    if (id && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,100}$/.test(id)) return { header, id };
  }
  return undefined;
}

export type UpstreamRejectionObservation = {
  schema_version: 1;
  occurred_at: string;
  invocation_id: string;
  task_id: string;
  trace_id: string;
  route_id: string;
  provider_id: string;
  endpoint: 'responses' | 'chat_completions' | 'image_edits' | 'image_generations';
  upstream_status: number;
  content_type?: string;
  has_body: boolean;
  reason: 'http_non_2xx' | 'unexpected_content_type' | 'missing_body' | 'invalid_payload';
  provider_trace?: { header: string; id: string };
};

function observeUpstreamRejection(
  callback: ModelGatewayOptions['upstreamRejectionObservation'],
  upstream: Response,
  context: Pick<UpstreamRejectionObservation, 'invocation_id' | 'task_id' | 'trace_id' | 'route_id' | 'provider_id' | 'endpoint'>,
  reason: UpstreamRejectionObservation['reason']
): void {
  if (callback === undefined) return;
  queueMicrotask(() => {
    try {
      const mediaType = upstream.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
      const contentType = mediaType && mediaType.length <= 100 && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mediaType) ? mediaType : undefined;
      const providerTrace = safeProviderTrace(upstream.headers);
      callback({
        schema_version: 1, occurred_at: new Date().toISOString(),
        invocation_id: context.invocation_id, task_id: context.task_id, trace_id: context.trace_id,
        route_id: context.route_id, provider_id: context.provider_id, endpoint: context.endpoint,
        upstream_status: upstream.status, has_body: upstream.body !== null, reason,
        ...(contentType === undefined ? {} : { content_type: contentType }),
        ...(providerTrace === undefined ? {} : { provider_trace: providerTrace }),
      });
    } catch { /* Diagnostics never own response success or invocation state. */ }
  });
}

export type ModelGatewayOptions = {
  routes: ModelGatewayRoute[];
  authenticate(token: string): Promise<ModelGatewayPrincipal | null>;
  publicBaseUrl?: string;
  tenantModelRoutePolicy?: TenantModelRoutePolicy;
  usageStore: UsageStore;
  usageKeyId: string;
  usagePrivateKey: KeyObject;
  consentStore?: ConsentStore;
  fetchImplementation?: typeof fetch;
  reconcileProviderInvocation?: (
    request: ProviderInvocationReceiptRequest
  ) => Promise<ProviderInvocationReceipt> | ProviderInvocationReceipt;
  upstreamTimeoutMs?: number;
  imageObservation?: (event: ImageObservation) => void;
  upstreamRejectionObservation?: (event: UpstreamRejectionObservation) => void;
};

export type TenantModelRoutePolicy = {
  isEnabled(tenantId: string, routeId: string): Promise<boolean>;
  upstreamApiKey?(tenantId: string, routeId: string): Promise<string | null>;
};

class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function json(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  response.end(body);
}

function bearer(request: IncomingMessage): string {
  const value = request.headers.authorization;
  if (typeof value !== 'string' || value.length > 8_199 || !/^Bearer [^\s]{32,8192}$/.test(value)) {
    throw new HttpError(401, 'AUTHENTICATION_REQUIRED', 'Authentication required');
  }
  return value.slice(7);
}

async function principal(
  token: string,
  authenticate: ModelGatewayOptions['authenticate']
): Promise<ModelGatewayPrincipal> {
  let value: ModelGatewayPrincipal | null;
  try {
    value = await authenticate(token);
  } catch {
    throw new HttpError(503, 'AUTHENTICATION_UNAVAILABLE', 'Authentication temporarily unavailable');
  }
  if (
    !value ||
    !identifierPattern.test(value.tenantId) ||
    !identifierPattern.test(value.userId) ||
    !Array.isArray(value.modelIds) ||
    value.modelIds.length > 20 ||
    value.modelIds.some((modelId) => !identifierPattern.test(modelId)) ||
    new Set(value.modelIds).size !== value.modelIds.length ||
    (value.sessionId !== undefined && !identifierPattern.test(value.sessionId))
  ) {
    throw new HttpError(401, 'AUTHENTICATION_REQUIRED', 'Authentication required');
  }
  return value;
}

function legacyRuntimeGatewayRoute(publicBaseUrl: string | undefined): {
  upstreamBaseUrl: string;
  allowInsecureHttpUpstream?: true;
} {
  let url: URL;
  try {
    url = new URL(publicBaseUrl ?? '');
  } catch {
    throw new HttpError(503, 'RUNTIME_MODEL_COMPATIBILITY_UNAVAILABLE', 'Runtime model compatibility unavailable');
  }
  const loopbackHttp = url.protocol === 'http:' && ['127.0.0.1', '::1', 'localhost'].includes(url.hostname);
  const path = url.pathname.replace(/\/+$/u, '');
  if (
    (!loopbackHttp && url.protocol !== 'https:') ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    path.endsWith('/v1') ||
    /\p{Cc}/u.test(publicBaseUrl ?? '')
  ) {
    throw new HttpError(503, 'RUNTIME_MODEL_COMPATIBILITY_UNAVAILABLE', 'Runtime model compatibility unavailable');
  }
  url.pathname = path;
  const root = url.toString().replace(/\/+$/u, '');
  return { upstreamBaseUrl: `${root}/v1`, ...(loopbackHttp ? { allowInsecureHttpUpstream: true } : {}) };
}

function principalAllowsRoute(identity: ModelGatewayPrincipal, routeId: string): boolean {
  return routeId !== deepSeekSearchCredentialRouteId && identity.modelIds.includes(routeId);
}

function officialDeepSeekSearchCredentialRoute(
  routes: Map<string, ModelGatewayRoute>
): ModelGatewayRoute | undefined {
  const route = routes.get(deepSeekSearchCredentialRouteId);
  return route?.providerId === deepSeekSearchProviderId &&
    route.upstreamBaseUrl === deepSeekSearchBaseUrl &&
    route.upstreamModelId === deepSeekSearchModelId
    ? route
    : undefined;
}

const auditSha256Pattern = /^[0-9a-f]{64}$/;
const auditFactIdPattern = /^auditfact_[0-9a-f]{64}$/;
const taskEventIdPattern = /^taskevent_[0-9a-f]{64}$/;
const auditPolicyIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const auditTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const auditPayloadKeys = [
  'account_subject_sha256',
  'actual_model_id',
  'actual_provider_id',
  'cache_read_tokens',
  'cache_write_tokens',
  'event_seq',
  'input_tokens',
  'output_tokens',
  'policy_receipt_id',
  'policy_revision',
  'policy_sha256',
  'provider_created_at',
  'reasoning_tokens',
  'requested_model_id',
  'schema_version',
  'session_id_sha256',
  'source_id',
  'source_service',
  'step',
  'total_tokens',
  'turn',
  'usage_kind',
] as const;

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function auditToken(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maxAuditTokenCount;
}

function parseAuditUsageBatch(
  value: Record<string, unknown>,
  identity: ModelGatewayPrincipal,
  routes: Map<string, ModelGatewayRoute>
): Array<{ record: AuditUsageRecord; routeId: string }> {
  if (
    !exactKeys(value, ['records', 'schema_version']) ||
    value.schema_version !== 1 ||
    !Array.isArray(value.records) ||
    value.records.length < 1 ||
    value.records.length > maxAuditBatchSize
  ) {
    throw new HttpError(400, 'INVALID_AUDIT_USAGE', 'Invalid audit usage batch');
  }
  const expectedAccount = createHash('sha256')
    .update(`${identity.tenantId}:${identity.userId}`)
    .digest('hex');
  const factIds = new Set<string>();
  return value.records.map((input) => {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new HttpError(400, 'INVALID_AUDIT_USAGE', 'Invalid audit usage record');
    }
    const envelope = input as Record<string, unknown>;
    const payload = envelope.payload;
    if (
      !exactKeys(envelope, ['fact_id', 'payload', 'payload_sha256']) ||
      typeof envelope.fact_id !== 'string' ||
      !auditFactIdPattern.test(envelope.fact_id) ||
      factIds.has(envelope.fact_id) ||
      typeof envelope.payload_sha256 !== 'string' ||
      !auditSha256Pattern.test(envelope.payload_sha256) ||
      typeof payload !== 'object' ||
      payload === null ||
      Array.isArray(payload) ||
      !exactKeys(payload as Record<string, unknown>, auditPayloadKeys)
    ) {
      throw new HttpError(400, 'INVALID_AUDIT_USAGE', 'Invalid audit usage record');
    }
    factIds.add(envelope.fact_id);
    const fact = payload as Record<string, unknown>;
    const counts = [
      fact.input_tokens,
      fact.output_tokens,
      fact.cache_read_tokens,
      fact.cache_write_tokens,
      fact.reasoning_tokens,
      fact.total_tokens,
    ];
    const occurredAt = typeof fact.provider_created_at === 'string' ? fact.provider_created_at : '';
    const occurredAtMs = Date.parse(occurredAt);
    const modelId = typeof fact.actual_model_id === 'string' ? fact.actual_model_id : '';
    const matchingRoutes = [...routes.values()].filter(
      (route) =>
        route.apiMode !== 'images-generations' &&
        (route.id === modelId || route.upstreamModelId === modelId)
    );
    const eventSeq = fact.event_seq;
    const sessionIdSha256 = fact.session_id_sha256;
    const sourceId = fact.source_id;
    if (
      fact.schema_version !== 1 ||
      fact.source_service !== 'e-mate-audit' ||
      fact.usage_kind !== 'chat' ||
      typeof sessionIdSha256 !== 'string' ||
      !auditSha256Pattern.test(sessionIdSha256) ||
      !Number.isSafeInteger(eventSeq) ||
      Number(eventSeq) < 0 ||
      typeof sourceId !== 'string' ||
      sourceId !== `harness:${sessionIdSha256}:${eventSeq}` ||
      !Number.isSafeInteger(fact.turn) ||
      Number(fact.turn) < 1 ||
      !Number.isSafeInteger(fact.step) ||
      Number(fact.step) < 1 ||
      !auditTimestampPattern.test(occurredAt) ||
      !Number.isFinite(occurredAtMs) ||
      occurredAtMs < Date.UTC(2000, 0, 1) ||
      occurredAtMs > Date.now() + 5 * 60_000 ||
      fact.requested_model_id !== modelId ||
      matchingRoutes.length !== 1 ||
      !principalAllowsRoute(identity, matchingRoutes[0]!.id) ||
      typeof fact.actual_provider_id !== 'string' ||
      !identifierPattern.test(fact.actual_provider_id) ||
      counts.some((count) => !auditToken(count)) ||
      Number(fact.total_tokens) < 1 ||
      Number(fact.total_tokens) !==
        Number(fact.input_tokens) +
          Number(fact.output_tokens) +
          Number(fact.cache_read_tokens) +
          Number(fact.cache_write_tokens) ||
      fact.account_subject_sha256 !== expectedAccount ||
      !Number.isSafeInteger(fact.policy_revision) ||
      Number(fact.policy_revision) < 1 ||
      typeof fact.policy_receipt_id !== 'string' ||
      !auditPolicyIdPattern.test(fact.policy_receipt_id) ||
      typeof fact.policy_sha256 !== 'string' ||
      !auditSha256Pattern.test(fact.policy_sha256) ||
      envelope.fact_id !==
        `auditfact_${createHash('sha256').update(`e-Mate audit v1\0${sourceId}`).digest('hex')}` ||
      envelope.payload_sha256 !== createHash('sha256').update(canonicalJson(fact)).digest('hex')
    ) {
      throw new HttpError(400, 'INVALID_AUDIT_USAGE', 'Invalid audit usage record');
    }
    const route = matchingRoutes[0]!;
    return {
      routeId: route.id,
      record: {
        factId: envelope.fact_id,
        payloadSha256: envelope.payload_sha256,
        occurredAt,
        fact: {
          tenantId: identity.tenantId,
          userId: identity.userId,
          taskId: sourceId,
          traceId: sessionIdSha256,
          modelId: route.id,
          providerId: fact.actual_provider_id,
          providerResponseId: envelope.fact_id,
          inputTokens: Number(fact.input_tokens),
          outputTokens: Number(fact.output_tokens),
          cacheReadTokens: Number(fact.cache_read_tokens),
          cacheWriteTokens: Number(fact.cache_write_tokens),
          costUsd: usageCost(route, {
            inputTokens: Number(fact.input_tokens),
            outputTokens: Number(fact.output_tokens),
            cacheReadTokens: Number(fact.cache_read_tokens),
            cacheWriteTokens: Number(fact.cache_write_tokens),
          }),
        },
      },
    };
  });
}

function parseAuditTaskBatch(
  value: Record<string, unknown>,
  identity: ModelGatewayPrincipal
): AuditTaskRecord[] {
  if (
    !exactKeys(value, ['records', 'schema_version']) ||
    value.schema_version !== 1 ||
    !Array.isArray(value.records) ||
    value.records.length < 1 ||
    value.records.length > maxAuditBatchSize
  ) {
    throw new HttpError(400, 'INVALID_AUDIT_TASK', 'Invalid task audit batch');
  }
  const expectedAccount = createHash('sha256')
    .update(`${identity.tenantId}:${identity.userId}`)
    .digest('hex');
  const eventIds = new Set<string>();
  return value.records.map((input) => {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new HttpError(400, 'INVALID_AUDIT_TASK', 'Invalid task audit record');
    }
    const envelope = input as Record<string, unknown>;
    if (
      !exactKeys(envelope, ['account_subject_sha256', 'event_id', 'payload', 'payload_sha256']) ||
      typeof envelope.event_id !== 'string' ||
      !taskEventIdPattern.test(envelope.event_id) ||
      eventIds.has(envelope.event_id) ||
      envelope.account_subject_sha256 !== expectedAccount ||
      typeof envelope.payload_sha256 !== 'string' ||
      !auditSha256Pattern.test(envelope.payload_sha256)
    ) {
      throw new HttpError(400, 'INVALID_AUDIT_TASK', 'Invalid task audit record');
    }
    let event: TaskEventInput;
    try {
      event = parseTaskEventInput(envelope.payload);
    } catch {
      throw new HttpError(400, 'INVALID_AUDIT_TASK', 'Invalid task audit event');
    }
    const occurredAtMs = Date.parse(event.occurredAt);
    if (
      event.eventId !== envelope.event_id ||
      !taskEventIdPattern.test(event.eventId) ||
      occurredAtMs < Date.UTC(2000, 0, 1) ||
      occurredAtMs > Date.now() + 5 * 60_000 ||
      envelope.payload_sha256 !== createHash('sha256').update(canonicalJson(event)).digest('hex')
    ) {
      throw new HttpError(400, 'INVALID_AUDIT_TASK', 'Invalid task audit event');
    }
    eventIds.add(event.eventId);
    return {
      tenantId: identity.tenantId,
      userId: identity.userId,
      payloadSha256: envelope.payload_sha256,
      event,
    };
  });
}

async function readBody(request: IncomingMessage, maximum = maxRequestBytes): Promise<Buffer> {
  const declared = request.headers['content-length'];
  if (typeof declared === 'string' && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    throw new HttpError(413, 'REQUEST_TOO_LARGE', 'Request too large');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maximum) {
      throw new HttpError(413, 'REQUEST_TOO_LARGE', 'Request too large');
    }
    chunks.push(buffer);
  }
  if (typeof declared === 'string' && size !== Number(declared)) {
    throw new HttpError(400, 'INVALID_REQUEST', 'Invalid request body length');
  }
  return Buffer.concat(chunks, size);
}

async function readJson(request: IncomingMessage, maximum = maxRequestBytes): Promise<Record<string, unknown>> {
  if (request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    throw new HttpError(415, 'CONTENT_TYPE_UNSUPPORTED', 'Expected JSON');
  }
  let value: unknown;
  try {
    value = JSON.parse((await readBody(request, maximum)).toString('utf8'));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'INVALID_REQUEST', 'Invalid JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'INVALID_REQUEST', 'Invalid request');
  }
  return value as Record<string, unknown>;
}

type ImageEditInput = { bytes: Buffer; mediaType: string };

async function readImageEdit(request: IncomingMessage): Promise<{
  model: string;
  prompt: string;
  images: ImageEditInput[];
}> {
  const contentType = request.headers['content-type'];
  if (typeof contentType !== 'string' || !/^multipart\/form-data\s*;/i.test(contentType)) {
    throw new HttpError(415, 'CONTENT_TYPE_UNSUPPORTED', 'Expected multipart form data');
  }
  let form: FormData;
  try {
    form = await new Response(new Uint8Array(await readBody(request, maxImageEditRequestBytes)), {
      headers: { 'content-type': contentType },
    }).formData();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'INVALID_MODEL_REQUEST', 'Invalid image edit request');
  }
  const entries = [...form.entries()];
  if (entries.some(([key]) => !['model', 'prompt', 'image', 'image[]'].includes(key))) {
    throw new HttpError(400, 'INVALID_MODEL_REQUEST', 'Invalid image edit request');
  }
  const strings = (key: string): string[] => form.getAll(key).filter((value): value is string => typeof value === 'string');
  const model = strings('model');
  const prompt = strings('prompt');
  const imageValues = entries
    .filter(([key]) => key === 'image' || key === 'image[]')
    .map(([, value]) => value);
  if (
    model.length !== 1 || prompt.length !== 1 ||
    form.getAll('model').length !== 1 || form.getAll('prompt').length !== 1 ||
    imageValues.length < 1 || imageValues.length > maxImageEditInputs ||
    imageValues.some((value) => typeof value === 'string') ||
    form.has('image') && form.has('image[]')
  ) {
    throw new HttpError(400, 'INVALID_MODEL_REQUEST', 'Invalid image edit request');
  }
  const images: ImageEditInput[] = [];
  for (const value of imageValues) {
    const image = value as File;
    const mediaType = image.type.toLowerCase();
    if (!imageEditMediaTypes.has(mediaType) || image.size < 1 || image.size > maxImageEditBytes) {
      throw new HttpError(400, 'INVALID_MODEL_REQUEST', 'Invalid image edit request');
    }
    images.push({ bytes: Buffer.from(await image.arrayBuffer()), mediaType });
  }
  return { model: model[0] as string, prompt: prompt[0] as string, images };
}

function headerIdentifier(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  if (typeof value !== 'string' || !identifierPattern.test(value)) {
    throw new HttpError(400, 'INVALID_REQUEST_SCOPE', 'Invalid request scope');
  }
  return value;
}

function imageCorrelation(request: IncomingMessage): ImageCorrelation {
  const taskId = headerIdentifier(request, 'x-e-mate-task-id');
  const traceId = headerIdentifier(request, 'x-e-mate-trace-id');
  const clientRequestId = headerIdentifier(request, 'x-client-request-id');
  const sessionId = headerIdentifier(request, 'session_id');
  if (clientRequestId !== sessionId) {
    throw new HttpError(400, 'INVALID_REQUEST_SCOPE', 'Invalid request scope');
  }
  const rawBatchId = request.headers['x-e-mate-batch-id'];
  const rawOrdinal = request.headers['x-e-mate-batch-ordinal'];
  if (rawBatchId === undefined && rawOrdinal === undefined) {
    return { trace_id: traceId, client_request_id: clientRequestId, task_id: taskId };
  }
  if (typeof rawBatchId !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(rawBatchId)
    || typeof rawOrdinal !== 'string' || !/^[1-8]$/.test(rawOrdinal)
    || !/^sha256:[0-9a-f]{64}$/.test(taskId)
    || traceId !== `image-${taskId.slice('sha256:'.length)}`
    || clientRequestId !== traceId) {
    throw new HttpError(400, 'INVALID_REQUEST_SCOPE', 'Invalid request scope');
  }
  return {
    trace_id: traceId,
    client_request_id: clientRequestId,
    task_id: taskId,
    batch_id: rawBatchId,
    ordinal: Number(rawOrdinal),
  };
}

type ResponseRequestScope = {
  taskId?: string;
  sessionId: string;
  traceId?: string;
};

function responseRequestScope(request: IncomingMessage): ResponseRequestScope {
  const explicitHeaders = ['x-e-mate-task-id', 'x-e-mate-trace-id'] as const;
  if (explicitHeaders.some((name) => request.headers[name] !== undefined)) {
    const taskId = headerIdentifier(request, 'x-e-mate-task-id');
    const traceId = headerIdentifier(request, 'x-e-mate-trace-id');
    const sessionId = headerIdentifier(request, 'session_id');
    if (headerIdentifier(request, 'x-client-request-id') !== sessionId) {
      throw new HttpError(400, 'INVALID_REQUEST_SCOPE', 'Invalid request scope');
    }
    return { taskId, traceId, sessionId };
  }

  // The pinned Harness pi-ai Responses client natively sends session_id and
  // x-client-request-id. Derive a per-call id from its immutable request body
  // below instead of requiring a second e-Mate transport/header injector.
  if (request.headers.session_id !== undefined) {
    const sessionId = headerIdentifier(request, 'session_id');
    if (headerIdentifier(request, 'x-client-request-id') !== sessionId) {
      throw new HttpError(400, 'INVALID_REQUEST_SCOPE', 'Invalid request scope');
    }
    return { sessionId };
  }

  const metadataHeader = request.headers['x-codex-turn-metadata'];
  if (typeof metadataHeader !== 'string' || metadataHeader.length > 16_384) {
    throw new HttpError(400, 'INVALID_REQUEST_SCOPE', 'Invalid request scope');
  }
  let metadata: unknown;
  try {
    metadata = JSON.parse(metadataHeader);
  } catch {
    throw new HttpError(400, 'INVALID_REQUEST_SCOPE', 'Invalid request scope');
  }
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    throw new HttpError(400, 'INVALID_REQUEST_SCOPE', 'Invalid request scope');
  }
  const values = metadata as Record<string, unknown>;
  const taskId = values.turn_id;
  const sessionId = values.session_id;
  const threadId = values.thread_id;
  if (
    typeof taskId !== 'string' ||
    typeof sessionId !== 'string' ||
    typeof threadId !== 'string' ||
    !identifierPattern.test(taskId) ||
    !identifierPattern.test(sessionId) ||
    !identifierPattern.test(threadId) ||
    headerIdentifier(request, 'session-id') !== sessionId ||
    headerIdentifier(request, 'thread-id') !== threadId ||
    headerIdentifier(request, 'x-client-request-id') !== threadId
  ) {
    throw new HttpError(400, 'INVALID_REQUEST_SCOPE', 'Invalid request scope');
  }
  return { taskId, sessionId };
}

function codexTraceId(identity: ModelGatewayPrincipal, taskId: string, upstreamBody: string): string {
  const digest = createHash('sha256')
    .update(identity.tenantId)
    .update('\0')
    .update(identity.userId)
    .update('\0')
    .update(taskId)
    .update('\0')
    .update(upstreamBody)
    .digest('hex');
  return `codex-${digest.slice(0, 32)}`;
}

function validModelsQuery(url: URL): boolean {
  if (!url.search) return true;
  const entries = [...url.searchParams.entries()];
  if (new Set(entries.map(([key]) => key)).size !== entries.length) return false;
  return entries.every(([key, value]) =>
    key === 'client_version'
      ? url.pathname === '/v1/runtime-models' || /^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/.test(value)
      : key === 'capabilities' && url.pathname === '/v1/runtime-models' && value === 'responses-multimodal'
  );
}

function validateRoute(route: ModelGatewayRoute): void {
  const url = new URL(route.upstreamBaseUrl);
  const rate = (value: number): boolean => Number.isFinite(value) && value >= 0 && value <= 1_000_000;
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && route.allowInsecureHttpUpstream === true)) ||
    (route.allowInsecureHttpUpstream !== undefined && route.allowInsecureHttpUpstream !== true) ||
    (route.allowInsecureHttpUpstream === true && url.protocol !== 'http:') ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !identifierPattern.test(route.id) ||
    (route.apiMode !== undefined &&
      route.apiMode !== 'responses' &&
      route.apiMode !== 'chat-completions' &&
      route.apiMode !== 'images-generations') ||
    !identifierPattern.test(route.upstreamModelId) ||
    !identifierPattern.test(route.providerId) ||
    (route.id === deepSeekSearchCredentialRouteId &&
      (route.providerId !== deepSeekSearchProviderId ||
        route.upstreamBaseUrl !== deepSeekSearchBaseUrl ||
        route.upstreamModelId !== deepSeekSearchModelId)) ||
    route.upstreamApiKey.length < 20 ||
    /\s/.test(route.upstreamApiKey) ||
    !route.label ||
    route.label.length > 80 ||
    !route.buttonLabel ||
    route.buttonLabel.length > 80 ||
    !route.provider ||
    route.provider.length > 80 ||
    !route.providerMark ||
    route.providerMark.length > 8 ||
    typeof route.reasoning !== 'boolean' ||
    (route.id === 'gpt-5.6-luna' && route.reasoning !== true) ||
    (route.id === 'gpt-6-astra' &&
      (route.reasoning !== true || route.upstreamModelId !== 'gpt-6-astra' ||
        (route.apiMode !== undefined && route.apiMode !== 'responses'))) ||
    // The multimodal candidate uses the native Responses contract; legacy
    // Chat routes remain accepted for clients already on that protocol.
    (route.id === 'deepseek' && route.upstreamModelId === 'deepseek-v4-flash-vision-exp' &&
      (route.apiMode !== 'responses' || route.nativeChatCompletions !== true || route.reasoning !== true ||
        !route.input.includes('text') || !route.input.includes('image'))) ||
    (route.nativeChatCompletions !== undefined &&
      (route.nativeChatCompletions !== true || route.apiMode !== 'responses')) ||
    route.input.length < 1 ||
    route.input.length > 2 ||
    new Set(route.input).size !== route.input.length ||
    route.input.some((kind) => kind !== 'text' && kind !== 'image') ||
    !rate(route.cost.input) ||
    !rate(route.cost.output) ||
    !rate(route.cost.cacheRead) ||
    !rate(route.cost.cacheWrite) ||
    !Number.isSafeInteger(route.contextWindow) ||
    route.contextWindow < 1 ||
    route.contextWindow > 10_000_000 ||
    !Number.isSafeInteger(route.maxTokens) ||
    route.maxTokens < 1 ||
    route.maxTokens > 10_000_000 ||
    (route.remoteCompactionV2 !== undefined && typeof route.remoteCompactionV2 !== 'boolean') ||
    (route.remoteCompactionV2 === true &&
      (route.id !== 'gpt-5.6-sol' || route.apiMode === 'chat-completions' || route.apiMode === 'images-generations')) ||
    (route.apiMode === 'images-generations' &&
      (route.id !== 'gpt-image-2.5-flare' ||
        route.upstreamModelId !== 'gpt-image-2.5-flare' ||
        route.reasoning !== false ||
        route.input.length !== 1 ||
        route.input[0] !== 'text'))
  ) {
    throw new Error(`Invalid Model Gateway route: ${route.id}`);
  }
}

function fingerprintRoute(route: ModelGatewayRoute): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        id: route.id,
        apiMode: route.apiMode ?? 'responses',
        upstreamModelId: route.upstreamModelId,
        upstreamBaseUrl: route.upstreamBaseUrl.replace(/\/$/, ''),
        allowInsecureHttpUpstream: route.allowInsecureHttpUpstream === true,
        providerId: route.providerId,
        cost: route.cost,
        remoteCompactionV2: route.remoteCompactionV2 === true,
        ...(route.nativeChatCompletions === true ? { nativeChatCompletions: true } : {}),
      })
    )
    .digest('base64url');
}

function isRemoteCompactionRequest(body: Record<string, unknown>): boolean {
  if (!Array.isArray(body.input)) return false;
  const triggers = body.input.filter(
    (item) =>
      typeof item === 'object' &&
      item !== null &&
      !Array.isArray(item) &&
      (item as Record<string, unknown>).type === 'compaction_trigger'
  );
  if (triggers.length === 0) return false;
  const tail = body.input.at(-1);
  if (
    triggers.length !== 1 ||
    typeof tail !== 'object' ||
    tail === null ||
    Array.isArray(tail) ||
    JSON.stringify(Object.keys(tail).toSorted()) !== '["type"]'
  ) {
    throw new HttpError(400, 'INVALID_COMPACTION_REQUEST', 'Invalid compaction request');
  }
  return true;
}

export function parseCompletedUsage(event: unknown): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  providerResponseId: string;
} | null {
  if (typeof event !== 'object' || event === null || Array.isArray(event)) {
    return null;
  }
  const input = event as Record<string, unknown>;
  if (input.type !== 'response.completed') return null;
  const response =
    typeof input.response === 'object' && input.response !== null && !Array.isArray(input.response)
      ? (input.response as Record<string, unknown>)
      : {};
  if (response.status !== 'completed') {
    throw new Error('Invalid completed response status');
  }
  if (typeof response.id !== 'string' || !identifierPattern.test(response.id)) {
    throw new Error('Invalid provider response id');
  }
  const usage =
    typeof response.usage === 'object' && response.usage !== null && !Array.isArray(response.usage)
      ? (response.usage as Record<string, unknown>)
      : {};
  const inputDetails =
    typeof usage.input_tokens_details === 'object' &&
    usage.input_tokens_details !== null &&
    !Array.isArray(usage.input_tokens_details)
      ? (usage.input_tokens_details as Record<string, unknown>)
      : {};
  const count = (value: unknown, label: string): number => {
    if (!Number.isSafeInteger(value) || Number(value) < 0) {
      throw new Error(`Invalid ${label}`);
    }
    return Number(value);
  };
  const inputTokensRaw = count(usage.input_tokens, 'input tokens');
  const outputTokens = count(usage.output_tokens, 'output tokens');
  const totalTokens = count(usage.total_tokens, 'total tokens');
  const cacheReadTokens = count(inputDetails.cached_tokens ?? 0, 'cache read tokens');
  const cacheWriteTokens = count(inputDetails.cache_write_tokens ?? 0, 'cache write tokens');
  if (cacheReadTokens + cacheWriteTokens > inputTokensRaw || totalTokens !== inputTokensRaw + outputTokens) {
    throw new Error('Invalid token totals');
  }
  return {
    inputTokens: inputTokensRaw - cacheReadTokens - cacheWriteTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    providerResponseId: response.id,
  };
}

export function parseImageGenerationResponse(
  value: unknown,
  responseId: string
): {
  body: {
    id: string;
    data: Array<{ b64_json: string }>;
    usage: Record<string, unknown>;
  };
  usage: NonNullable<ReturnType<typeof parseCompletedUsage>>;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid image generation response');
  }
  const response = value as Record<string, unknown>;
  const usage =
    typeof response.usage === 'object' && response.usage !== null && !Array.isArray(response.usage)
      ? (response.usage as Record<string, unknown>)
      : null;
  const data = Array.isArray(response.data) ? response.data : [];
  if (!usage || data.length !== 1) {
    throw new Error('Invalid image generation response');
  }
  const image =
    typeof data[0] === 'object' && data[0] !== null && !Array.isArray(data[0])
      ? (data[0] as Record<string, unknown>)
      : {};
  const base64 = image.b64_json;
  if (
    typeof base64 !== 'string' ||
    base64.length < 4 ||
    base64.length > 48 * 1024 * 1024 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)
  ) {
    throw new Error('Invalid generated image');
  }
  const parsedUsage = parseCompletedUsage({
    type: 'response.completed',
    response: {
      id: responseId,
      status: 'completed',
      usage: {
        ...usage,
        input_tokens_details: {},
      },
    },
  });
  if (!parsedUsage) throw new Error('Image generation usage was unavailable');
  return {
    body: {
      id: responseId,
      data: [{ b64_json: base64 }],
      usage,
    },
    usage: parsedUsage,
  };
}

function parseProviderInvocationReceipt(
  value: unknown,
  expected: {
    invocationId: string;
    requestDigest: string;
    routeFingerprint: string;
  },
  route: ModelGatewayRoute
): {
  status: 'PENDING' | 'UNKNOWN' | 'NOT_ACCEPTED' | 'ACCOUNTED';
  usage?: NonNullable<ReturnType<typeof parseCompletedUsage>>;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid provider invocation receipt');
  }
  const receipt = value as Record<string, unknown>;
  const expectedKeys = (
    receipt.status === 'ACCOUNTED'
      ? ['invocationId', 'requestDigest', 'response', 'routeFingerprint', 'status']
      : ['invocationId', 'requestDigest', 'routeFingerprint', 'status']
  ).toSorted();
  if (
    JSON.stringify(Object.keys(receipt).toSorted()) !== JSON.stringify(expectedKeys) ||
    receipt.invocationId !== expected.invocationId ||
    receipt.requestDigest !== expected.requestDigest ||
    receipt.routeFingerprint !== expected.routeFingerprint ||
    !['PENDING', 'UNKNOWN', 'NOT_ACCEPTED', 'ACCOUNTED'].includes(String(receipt.status))
  ) {
    throw new Error('Provider invocation receipt mismatch');
  }
  const status = receipt.status as 'PENDING' | 'UNKNOWN' | 'NOT_ACCEPTED' | 'ACCOUNTED';
  if (status !== 'ACCOUNTED') return { status };
  if (typeof receipt.response !== 'object' || receipt.response === null || Array.isArray(receipt.response)) {
    throw new Error('Invalid accounted provider response');
  }
  const providerResponse = receipt.response as Record<string, unknown>;
  if (
    providerResponse.model !== route.upstreamModelId ||
    !['completed', 'failed', 'cancelled'].includes(String(providerResponse.status))
  ) {
    throw new Error('Accounted provider response mismatch');
  }
  const usage = parseCompletedUsage({
    type: 'response.completed',
    response: { ...providerResponse, status: 'completed' },
  });
  if (!usage) throw new Error('Accounted provider usage was unavailable');
  return { status, usage };
}

function usageCost(
  route: ModelGatewayRoute,
  usage: Pick<UsageFact, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>
): number {
  return (
    (usage.inputTokens * route.cost.input +
      usage.outputTokens * route.cost.output +
      usage.cacheReadTokens * route.cost.cacheRead +
      usage.cacheWriteTokens * route.cost.cacheWrite) /
    1_000_000
  );
}

export function inspectSseFrame(text: string, nativeChat = false): {
  done: boolean;
  terminal: boolean;
  usage?: NonNullable<ReturnType<typeof parseCompletedUsage>>;
} {
  const data = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
    .trim();
  if (data === '[DONE]') return { done: true, terminal: true };
  if (!data) return { done: false, terminal: false };
  const event = JSON.parse(data) as unknown;
  const usage = parseCompletedUsage(nativeChat ? chatCompletionUsageEvent(event) : event);
  return {
    done: false,
    terminal: Boolean(usage),
    ...(usage ? { usage } : {}),
  };
}

async function writeChunk(response: ServerResponse, value: Uint8Array | string): Promise<void> {
  if (response.destroyed || response.writableEnded) {
    throw new Error('Client disconnected');
  }
  if (response.write(value)) return;
  await Promise.race([
    once(response, 'drain'),
    once(response, 'close').then(() => {
      throw new Error('Client disconnected');
    }),
  ]);
}

async function withinDeadline<T>(value: Promise<T> | T, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(value),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Provider reconciliation timed out')), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function signedUsage(usage: FinalizedUsage, keyId: string, privateKey: KeyObject): unknown {
  const payload = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      receiptType: 'FINALIZED_USAGE',
      status: 'FINALIZED',
      usageId: usage.usageId,
      traceId: usage.traceId,
      providerId: usage.providerId,
      taskId: usage.taskId,
      modelId: usage.modelId,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      totalTokens: usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
      costUsd: usage.costUsd,
      occurredAt: usage.occurredAt,
    })
  );
  return {
    schemaVersion: 1,
    algorithm: 'ED25519',
    keyId,
    payload: payload.toString('base64url'),
    signature: sign(null, payload, privateKey).toString('base64url'),
  };
}

function method(response: ServerResponse, allow: string): void {
  json(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } }, { allow });
}

async function modelRouteEnabled(
  policy: TenantModelRoutePolicy | undefined,
  tenantId: string,
  routeId: string
): Promise<boolean> {
  if (isRetiredModelRoute(routeId)) return false;
  if (!policy) return isDefaultEnabledModelRoute(routeId);
  try {
    return await policy.isEnabled(tenantId, routeId);
  } catch {
    throw new HttpError(503, 'MODEL_POLICY_UNAVAILABLE', 'Model policy is temporarily unavailable');
  }
}

async function modelRouteUpstreamApiKey(
  policy: TenantModelRoutePolicy | undefined,
  tenantId: string,
  route: ModelGatewayRoute
): Promise<string> {
  try {
    const apiKey = (await policy?.upstreamApiKey?.(tenantId, route.id)) ?? route.upstreamApiKey;
    if (apiKey.length < 20 || apiKey.length > 8_192 || /\s/.test(apiKey)) {
      throw new Error('Invalid model route key');
    }
    return apiKey;
  } catch {
    throw new HttpError(503, 'MODEL_ROUTE_KEY_UNAVAILABLE', 'Model route key is temporarily unavailable');
  }
}

const definitelyRejectedStatuses = new Set([400, 401, 403, 404, 413, 415, 422, 429]);
const consentProtectedPaths = new Set([
  '/v1/models',
  '/v1/runtime-models',
  '/v1/responses',
  '/v1/chat/completions',
  '/v1/images/generations',
  '/v1/images/edits',
  '/v1/audit/usage',
  '/v1/audit/tasks',
  '/v1/usage/current',
  '/v1/usage/activity',
]);

function activityQuery(url: URL): UsageActivityQuery {
  const entries = [...url.searchParams.entries()];
  if (
    entries.length !== 3 ||
    new Set(entries.map(([key]) => key)).size !== 3 ||
    entries.some(([key]) => !['timezone', 'start_date', 'end_date'].includes(key))
  ) {
    throw new HttpError(400, 'INVALID_USAGE_ACTIVITY_QUERY', 'Invalid usage activity query');
  }
  try {
    return parseUsageActivityQuery({
      timezone: url.searchParams.get('timezone'),
      startDate: url.searchParams.get('start_date'),
      endDate: url.searchParams.get('end_date'),
    });
  } catch {
    throw new HttpError(400, 'INVALID_USAGE_ACTIVITY_QUERY', 'Invalid usage activity query');
  }
}

function activityEtag(activity: UsageActivity): string {
  const { calculatedAt: _calculatedAt, ...stable } = activity;
  return `W/"${createHash('sha256').update(JSON.stringify(stable)).digest('base64url')}"`;
}

async function requireAcceptedConsent(store: ConsentStore | undefined, identity: ModelGatewayPrincipal): Promise<void> {
  if (identity.roles?.some((role) => role === 'TENANT_ADMIN' || role === 'AUDIT_ADMIN')) return;
  if (!store) {
    throw new HttpError(503, 'CONSENT_STORE_UNAVAILABLE', 'Consent status temporarily unavailable');
  }
  try {
    if ((await store.status(identity)).required) {
      throw new HttpError(403, 'CONSENT_REQUIRED', 'Consent acceptance required');
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, 'CONSENT_STORE_UNAVAILABLE', 'Consent status temporarily unavailable');
  }
}

type ImageRequestObserver = {
  readonly submitted: boolean;
  readonly clientResponseObserved: boolean;
  emit(stage: ImageObservation['stage'], outcome: ImageObservation['outcome'], failure?: ImageFailureCode): void;
  markSubmitted(): void;
  markClientResponse(): void;
  setFailure(failure: ImageFailureCode): void;
  failure(cancelled: boolean): ImageFailureCode;
};

function createImageRequestObserver(
  callback: ModelGatewayOptions['imageObservation'],
  correlation: ImageCorrelation
): ImageRequestObserver | undefined {
  if (callback === undefined) return undefined;
  const requestStartedAt = performance.now();
  let lastStageAt = requestStartedAt;
  let submitted = false;
  let clientResponseObserved = false;
  let knownFailure: ImageFailureCode | undefined;
  return {
    get submitted() { return submitted; },
    get clientResponseObserved() { return clientResponseObserved; },
    emit(stage, outcome, failure) {
      const stageStartedAt = lastStageAt;
      const finishedAt = performance.now();
      const occurredAt = Date.now();
      lastStageAt = finishedAt;
      queueMicrotask(() => {
        try {
          callback(createImageObservation(
            correlation, stage, requestStartedAt, stageStartedAt, finishedAt, occurredAt, outcome, failure
          ));
        } catch { /* Observation construction and logging never own request success. */ }
      });
    },
    markSubmitted() { submitted = true; },
    markClientResponse() { clientResponseObserved = true; },
    setFailure(failure) { knownFailure = failure; },
    failure(cancelled) {
      return knownFailure ?? (submitted
        ? imageFailureCode({ phase: 'provider', providerSubmitted: true, cancelled })
        : imageFailureCode({ phase: 'preflight', cancelled }));
    },
  };
}

export function createModelGatewayHandler(options: ModelGatewayOptions) {
  if (
    options.routes.length < 1 ||
    options.routes.length > 20 ||
    new Set(options.routes.map(({ id }) => id)).size !== options.routes.length ||
    options.routes.some(({ id }) => id === 'e-mate-faux') ||
    !/^[A-Za-z0-9._-]{1,80}$/.test(options.usageKeyId) ||
    options.usagePrivateKey.asymmetricKeyType !== 'ed25519'
  ) {
    throw new Error('Invalid Model Gateway configuration');
  }
  options.routes.forEach(validateRoute);
  const routes = new Map(options.routes.map((route) => [route.id, route]));
  const gatewayFetch = options.fetchImplementation ?? fetch;
  let largeResponsesInFlight = 0;
  const timeoutMs = options.upstreamTimeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000) {
    throw new Error('Invalid Model Gateway timeout');
  }

  return async (request: IncomingMessage, response: ServerResponse) => {
    let imageObserver: ImageRequestObserver | undefined;
    let largeResponse = false;
    try {
      const url = new URL(request.url ?? '/', 'http://model-gateway.internal');
      if (url.hash || (
        url.pathname === '/v1/models' || url.pathname === '/v1/runtime-models'
          ? !validModelsQuery(url)
          : url.pathname === '/v1/usage/activity'
            ? false
            : Boolean(url.search)
      )) {
        throw new HttpError(400, 'INVALID_REQUEST', 'Query is not allowed');
      }
      const modelSessionToken = bearer(request);
      const identity = await principal(modelSessionToken, options.authenticate);
      if (url.pathname === '/v1/consents/current') {
        if (request.method !== 'GET') return method(response, 'GET');
        if (!options.consentStore) {
          throw new HttpError(503, 'CONSENT_STORE_UNAVAILABLE', 'Consent status temporarily unavailable');
        }
        try {
          json(response, 200, await options.consentStore.status(identity));
          return;
        } catch {
          throw new HttpError(503, 'CONSENT_STORE_UNAVAILABLE', 'Consent status temporarily unavailable');
        }
      }
      if (url.pathname === '/v1/consents/accept') {
        if (request.method !== 'POST') return method(response, 'POST');
        if (!options.consentStore) {
          throw new HttpError(503, 'CONSENT_STORE_UNAVAILABLE', 'Consent acceptance temporarily unavailable');
        }
        let input: ConsentAcceptanceInput;
        try {
          input = parseConsentAcceptanceInput(await readJson(request));
        } catch (error) {
          if (error instanceof HttpError) throw error;
          throw new HttpError(400, 'INVALID_CONSENT_ACCEPTANCE', 'Invalid consent acceptance');
        }
        try {
          json(response, 200, await options.consentStore.accept(identity, input));
          return;
        } catch (error) {
          if (error instanceof ConsentStoreError && error.code === 'POLICY_CHANGED') {
            throw new HttpError(409, 'CONSENT_POLICY_CHANGED', 'Consent policy changed');
          }
          throw new HttpError(503, 'CONSENT_STORE_UNAVAILABLE', 'Consent acceptance temporarily unavailable');
        }
      }
      if (consentProtectedPaths.has(url.pathname)) {
        await requireAcceptedConsent(options.consentStore, identity);
      }
      if (url.pathname === '/v1/models') {
        if (request.method !== 'GET') return method(response, 'GET');
        const clientVersion = url.searchParams.get('client_version') ?? request.headers['x-e-mate-client-version'];
        const availableRoutes = (
          await Promise.all(
            options.routes.map(async (route) =>
              modelSupportsClient(route.id, typeof clientVersion === 'string' ? clientVersion : undefined) &&
              principalAllowsRoute(identity, route.id) &&
              (await modelRouteEnabled(options.tenantModelRoutePolicy, identity.tenantId, route.id))
                ? route
                : null
            )
          )
        ).filter((route): route is ModelGatewayRoute => route !== null);
        if (availableRoutes.length === 0) {
          throw new HttpError(403, 'MODEL_ACCESS_DENIED', 'No model is available');
        }
        const catalog = availableRoutes.map(
          ({
            upstreamApiKey: _upstreamApiKey,
            upstreamBaseUrl: _upstreamBaseUrl,
            allowInsecureHttpUpstream: _allowInsecureHttpUpstream,
            upstreamModelId: _upstreamModelId,
            providerId: _providerId,
            remoteCompactionV2,
            ...route
          }) => {
            const imageGeneration = route.apiMode === 'images-generations';
            return {
              ...route,
              capabilities: {
                input: route.input,
                reasoning: route.reasoning,
                toolCalling: !imageGeneration,
                imageGeneration,
              },
              ...(remoteCompactionV2 === true ? { remoteCompactionV2: true } : {}),
            };
          }
        );
        const chatCatalog = catalog.filter(
          ({ apiMode, id }) => apiMode !== 'images-generations' && managedCodexModelIds.has(id)
        );
        const cliCatalog = url.searchParams.has('client_version')
          ? chatCatalog.map((route, index) => codexModelInfo(route, index + 1))
          : catalog;
        json(response, 200, {
          schemaVersion: 1,
          models: cliCatalog,
          data: chatCatalog.map(({ id, capabilities }) => ({ id, capabilities })),
        });
        return;
      }
      if (url.pathname === '/v1/runtime-models') {
        if (request.method !== 'GET') return method(response, 'GET');
        const clientVersion = url.searchParams.get('client_version');
        if (clientVersion !== null && !runtimeModelsClientVersions.has(clientVersion)) {
          throw new HttpError(400, 'UNSUPPORTED_CLIENT_VERSION', 'Unsupported runtime models client version');
        }
        const effectiveClientVersion = clientVersion ?? '2.0.12';
        const multimodalResponses = url.searchParams.get('capabilities') === 'responses-multimodal';
        const legacyClient = effectiveClientVersion !== '2.0.17' && effectiveClientVersion !== '2.0.18';
        if (legacyClient && (identity.sessionId === undefined || !modelSessionJwtPattern.test(modelSessionToken))) {
          throw new HttpError(403, 'MODEL_SESSION_REQUIRED', 'A model session is required');
        }
        const legacyGatewayRoute = legacyClient ? legacyRuntimeGatewayRoute(options.publicBaseUrl) : undefined;
        const searchGrantRequested = effectiveClientVersion !== '2.0.12';
        let searchGrantStatus: 'granted' | 'denied' | 'unavailable' = 'unavailable';
        let searchApiKey: string | undefined;
        if (searchGrantRequested) {
          const searchRoute = officialDeepSeekSearchCredentialRoute(routes);
          if (searchRoute && options.tenantModelRoutePolicy?.upstreamApiKey) {
            let enabled: boolean | undefined;
            try {
              enabled = await modelRouteEnabled(options.tenantModelRoutePolicy, identity.tenantId, searchRoute.id);
            } catch {
              enabled = undefined;
            }
            if (enabled === false) {
              searchGrantStatus = 'denied';
            } else if (enabled === true) {
              try {
                searchApiKey = (await options.tenantModelRoutePolicy.upstreamApiKey(
                  identity.tenantId,
                  searchRoute.id
                )) ?? '';
                if (searchApiKey.length < 20 || searchApiKey.length > 8_192 || /\s/.test(searchApiKey)) {
                  throw new Error('Invalid managed search route key');
                }
                searchGrantStatus = 'granted';
              } catch {
                searchApiKey = undefined;
              }
            }
          }
        }
        const availableRoutes = (
          await Promise.all(
            options.routes.map(async (route) =>
              managedCodexModelIds.has(route.id) &&
              modelSupportsClient(route.id, effectiveClientVersion) &&
              route.apiMode !== 'images-generations' &&
              principalAllowsRoute(identity, route.id) &&
              (await modelRouteEnabled(options.tenantModelRoutePolicy, identity.tenantId, route.id))
                ? {
                    id: route.id,
                    // Older clients validate this metadata contract literally. This
                    // view does not change the single execution route/model.
                    ...(route.id === 'deepseek' && route.upstreamModelId === 'deepseek-v4-flash-vision-exp' &&
                      route.nativeChatCompletions === true && !multimodalResponses
                      ? { apiMode: 'chat-completions' as const, upstreamModelId: 'deepseek-v4-flash', input: ['text'] as Array<'text' | 'image'> }
                      : { apiMode: runtimeApiMode(route), upstreamModelId: route.upstreamModelId, input: route.input }),
                    label: route.label,
                    reasoning: route.reasoning,
                    contextWindow: route.contextWindow,
                    maxTokens: route.maxTokens,
                    ...(legacyGatewayRoute ? { ...legacyGatewayRoute, upstreamApiKey: modelSessionToken } : {}),
                  }
                : null
            )
          )
        ).filter((route): route is NonNullable<typeof route> => route !== null);
        if (availableRoutes.length === 0) {
          throw new HttpError(403, 'MODEL_ACCESS_DENIED', 'No model is available');
        }
        json(response, 200, {
          schemaVersion: 1,
          models: availableRoutes,
          ...(searchGrantRequested ? { searchCredentialGrant: {
            schemaVersion: 1,
            status: searchGrantStatus,
            purpose: 'web-search',
            provider: 'deepseek-official',
            credentialRef: 'E_MATE_SEARCH_KEY_DEEPSEEK',
            ...(searchGrantStatus === 'granted' ? { upstreamApiKey: searchApiKey } : {}),
          } } : {}),
        });
        return;
      }
      if (url.pathname === '/v1/usage/current') {
        if (request.method !== 'GET') return method(response, 'GET');
        const usage = await options.usageStore.currentAccountUsage(identity);
        json(response, 200, { schemaVersion: 1, ...usage });
        return;
      }
      if (url.pathname === '/v1/usage/activity') {
        if (request.method !== 'GET') return method(response, 'GET');
        const query = activityQuery(url);
        let activity: UsageActivity;
        try {
          activity = await options.usageStore.accountUsageActivity(identity, query);
        } catch {
          throw new HttpError(503, 'USAGE_ACTIVITY_UNAVAILABLE', 'Usage activity temporarily unavailable');
        }
        const etag = activityEtag(activity);
        if (request.headers['if-none-match'] === etag) {
          response.writeHead(304, { 'cache-control': 'no-store', etag });
          response.end();
          return;
        }
        json(response, 200, activity, { etag });
        return;
      }
      if (url.pathname === '/v1/audit/usage') {
        if (request.method !== 'POST') return method(response, 'POST');
        const parsed = parseAuditUsageBatch(await readJson(request, maxAuditRequestBytes), identity, routes);
        for (const routeId of new Set(parsed.map(({ routeId }) => routeId))) {
          if (!(await modelRouteEnabled(options.tenantModelRoutePolicy, identity.tenantId, routeId))) {
            throw new HttpError(403, 'MODEL_ACCESS_DENIED', 'Model is not available');
          }
        }
        let receipts: AuditUsageReceipt[];
        try {
          receipts = await options.usageStore.ingestAuditUsage(parsed.map(({ record }) => record));
        } catch (error) {
          if (error instanceof AuditUsageConflictError) {
            throw new HttpError(409, 'AUDIT_USAGE_CONFLICT', 'Audit usage conflicts with the existing ledger');
          }
          throw error;
        }
        json(response, 200, {
          schema_version: 1,
          receipts: receipts.map((receipt) => ({
            fact_id: receipt.factId,
            payload_sha256: receipt.payloadSha256,
            receipt_id: receipt.receiptId,
            accepted_at: receipt.acceptedAt,
          })),
        });
        return;
      }
      if (url.pathname === '/v1/audit/tasks') {
        if (request.method !== 'POST') return method(response, 'POST');
        const records = parseAuditTaskBatch(await readJson(request, maxAuditRequestBytes), identity);
        let receipts: AuditTaskReceipt[];
        try {
          receipts = await options.usageStore.ingestAuditTasks(records);
        } catch (error) {
          if (error instanceof AuditTaskConflictError) {
            throw new HttpError(409, 'AUDIT_TASK_CONFLICT', 'Task audit conflicts with the existing ledger');
          }
          throw error;
        }
        json(response, 200, {
          schema_version: 1,
          receipts: receipts.map((receipt) => ({
            event_id: receipt.eventId,
            payload_sha256: receipt.payloadSha256,
            receipt_id: receipt.receiptId,
            accepted_at: receipt.acceptedAt,
          })),
        });
        return;
      }
      if (url.pathname === '/v1/responses' || url.pathname === '/v1/chat/completions') {
        const nativeChat = url.pathname === '/v1/chat/completions';
        if (request.method !== 'POST') return method(response, 'POST');
        const initialScope = responseRequestScope(request);
        const declared = request.headers['content-length'];
        if (typeof declared === 'string' && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSES_REQUEST_BYTES)) {
          throw new HttpError(413, 'REQUEST_TOO_LARGE', 'Model request exceeds the 48 MiB request limit');
        }
        // Authentication precedes body admission. No queue and no usage/provider work on refusal.
        if (declared === undefined || Number(declared) > maxRequestBytes) {
          if (largeResponsesInFlight >= maxLargeResponsesInFlight) {
            response.setHeader('retry-after', '1');
            throw new HttpError(429, 'REQUEST_BODY_BUSY', 'Large model request capacity is temporarily busy');
          }
          largeResponsesInFlight++;
          largeResponse = true;
        }
        const body = await readJson(request, MAX_RESPONSES_REQUEST_BYTES);
        const taskId =
          initialScope.taskId ??
          `h-${createHash('sha256')
            .update(initialScope.sessionId)
            .update('\0')
            .update(JSON.stringify(body))
            .digest('base64url')}`;
        const scope = { ...initialScope, taskId };
        const route = typeof body.model === 'string' ? routes.get(body.model) : undefined;
        if (!route || route.apiMode === 'images-generations' || (nativeChat && route.apiMode !== 'chat-completions' && route.nativeChatCompletions !== true) || !principalAllowsRoute(identity, route.id)) {
          throw new HttpError(403, 'MODEL_ACCESS_DENIED', 'Model is not available');
        }
        if (!(await modelRouteEnabled(options.tenantModelRoutePolicy, identity.tenantId, route.id))) {
          throw new HttpError(403, 'MODEL_ACCESS_DENIED', 'Model is not available');
        }
        if (body.stream !== true || (!nativeChat && body.store !== false)) {
          throw new HttpError(400, 'INVALID_MODEL_REQUEST', 'Invalid model request');
        }
        const requiredReasoningEffort =
          route.id === 'gpt-5.6-luna'
            ? 'high'
            : route.id === 'deepseek'
              ? 'max'
              : route.id === 'gpt-6-astra'
                ? 'low'
                : route.id === 'gpt-5.6-sol' ? 'medium' : undefined;
        const remoteCompaction = !nativeChat && isRemoteCompactionRequest(body);
        if (remoteCompaction && route.remoteCompactionV2 !== true) {
          throw new HttpError(403, 'REMOTE_COMPACTION_UNAVAILABLE', 'Remote compaction is not available');
        }
        const upstreamApiKey = await modelRouteUpstreamApiKey(options.tenantModelRoutePolicy, identity.tenantId, route);
        const requestedReasoning =
          typeof body.reasoning === 'object' && body.reasoning !== null && !Array.isArray(body.reasoning)
            ? (body.reasoning as Record<string, unknown>)
            : {};
        const { reasoning: _clientReasoning, ...bodyWithoutReasoning } = body;
        const managedBody: Record<string, unknown> = {
          ...bodyWithoutReasoning,
          ...(requiredReasoningEffort
            ? { reasoning: { ...requestedReasoning, effort: requiredReasoningEffort } }
            : {}),
        };
        // Astra has no enterprise fast-mode grant yet; client priority never enables it.
        if (route.id === 'gpt-6-astra') delete managedBody.service_tier;
        let chatRequest: ReturnType<typeof responsesToChatCompletionsRequest> | undefined;
        try {
          chatRequest =
            nativeChat
              ? nativeChatCompletionsRequest(body, route.upstreamModelId, route.maxTokens, route.input.includes('image'), requiredReasoningEffort)
              : route.apiMode === 'chat-completions'
              ? responsesToChatCompletionsRequest(
                  managedBody,
                  route.upstreamModelId,
                  route.maxTokens,
                  route.input.includes('image')
                )
              : undefined;
        } catch {
          throw new HttpError(400, 'INVALID_MODEL_REQUEST', 'Invalid model request');
        }
        const upstreamBody =
          chatRequest?.body ??
          JSON.stringify({
            ...managedBody,
            model: route.upstreamModelId,
          });
        const traceId = scope.traceId ?? codexTraceId(identity, taskId, upstreamBody);
        const routeFingerprint = fingerprintRoute(route);
        const invocationFact: InvocationFact = {
          tenantId: identity.tenantId,
          userId: identity.userId,
          taskId,
          traceId,
          modelId: route.id,
          providerId: route.providerId,
          requestDigest: createHash('sha256').update(upstreamBody).digest('base64url'),
          routeFingerprint,
        };
        let prepared = await options.usageStore.prepare(invocationFact);
        if (prepared.status === 'PENDING') {
          if (!options.reconcileProviderInvocation) {
            throw new HttpError(
              409,
              'INVOCATION_RECONCILIATION_REQUIRED',
              'A previous model invocation has an unknown result'
            );
          }
          const claimed = await options.usageStore.claimReconciliation(
            identity,
            taskId,
            prepared.invocationId,
            routeFingerprint
          );
          if (!claimed) {
            throw new HttpError(
              409,
              'INVOCATION_RECONCILIATION_REQUIRED',
              'A previous model invocation is still being reconciled'
            );
          }
          let receipt: ReturnType<typeof parseProviderInvocationReceipt> | undefined;
          try {
            const reconciliationTimeoutMs = Math.min(timeoutMs, 30_000);
            receipt = parseProviderInvocationReceipt(
              await withinDeadline(
                options.reconcileProviderInvocation({
                  invocationId: prepared.invocationId,
                  requestDigest: claimed.fact.requestDigest,
                  routeFingerprint,
                  providerId: route.providerId,
                  modelId: route.id,
                  upstreamModelId: route.upstreamModelId,
                  upstreamBaseUrl: route.upstreamBaseUrl,
                  upstreamApiKey,
                  signal: AbortSignal.timeout(reconciliationTimeoutMs),
                }),
                reconciliationTimeoutMs
              ),
              {
                invocationId: prepared.invocationId,
                requestDigest: claimed.fact.requestDigest,
                routeFingerprint,
              },
              route
            );
          } catch {
            throw new HttpError(
              409,
              'INVOCATION_RECONCILIATION_REQUIRED',
              'The previous model invocation could not be reconciled'
            );
          }
          if (receipt.status === 'ACCOUNTED' && receipt.usage) {
            await options.usageStore.completeReconciliation(prepared.invocationId, claimed.leaseToken, {
              tenantId: identity.tenantId,
              userId: identity.userId,
              taskId,
              traceId,
              modelId: route.id,
              providerId: route.providerId,
              ...receipt.usage,
              costUsd: usageCost(route, receipt.usage),
            });
            throw new HttpError(
              409,
              'INVOCATION_RESULT_ALREADY_RECORDED',
              'This model invocation was already recorded'
            );
          }
          if (receipt.status === 'PENDING') {
            const renewed = await options.usageStore.renewReconciliation(
              identity,
              taskId,
              prepared.invocationId,
              claimed.leaseToken
            );
            if (!renewed) {
              throw new HttpError(
                409,
                'INVOCATION_RECONCILIATION_REQUIRED',
                'The previous model invocation changed while reconciling'
              );
            }
          }
          if (receipt.status !== 'NOT_ACCEPTED') {
            throw new HttpError(
              409,
              'INVOCATION_RECONCILIATION_REQUIRED',
              'A previous model invocation still has an unknown result'
            );
          }
          await options.usageStore.rejectReconciliation(identity, taskId, prepared.invocationId, claimed.leaseToken);
          prepared = await options.usageStore.prepare(invocationFact);
          if (prepared.status !== 'STARTED') {
            throw new HttpError(
              409,
              'INVOCATION_RECONCILIATION_REQUIRED',
              'The previous model invocation could not be retried safely'
            );
          }
        }
        if (prepared.status === 'RECORDED') {
          throw new HttpError(409, 'INVOCATION_RESULT_ALREADY_RECORDED', 'This model invocation was already recorded');
        }
        const clientAbort = new AbortController();
        request.once('aborted', () => clientAbort.abort());
        response.once('close', () => clientAbort.abort());
        const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), clientAbort.signal]);
        let upstream: Response;
        try {
          upstream = await gatewayFetch(
            `${route.upstreamBaseUrl.replace(/\/$/, '')}/${chatRequest ? 'chat/completions' : 'responses'}`,
            {
              method: 'POST',
              headers: {
                accept: 'text/event-stream',
                authorization: `Bearer ${upstreamApiKey}`,
                'content-type': 'application/json',
                'idempotency-key': prepared.invocationId,
                ...(remoteCompaction
                  ? {
                      'x-codex-beta-features': 'remote_compaction_v2',
                    }
                  : {}),
              },
              body: upstreamBody,
              redirect: 'error',
              signal,
            }
          );
        } catch (error) {
          throw new HttpError(
            error instanceof DOMException && error.name === 'TimeoutError' ? 504 : 502,
            error instanceof DOMException && error.name === 'TimeoutError'
              ? 'UPSTREAM_TIMEOUT'
              : 'UPSTREAM_UNAVAILABLE',
            'Model provider temporarily unavailable'
          );
        }
        const observeRejection = (reason: UpstreamRejectionObservation['reason']) => observeUpstreamRejection(
          options.upstreamRejectionObservation, upstream,
          { invocation_id: prepared.invocationId, task_id: taskId, trace_id: traceId,
            route_id: route.id, provider_id: route.providerId, endpoint: chatRequest ? 'chat_completions' : 'responses' }, reason
        );
        if (!upstream.ok) {
          observeRejection('http_non_2xx');
          if (definitelyRejectedStatuses.has(upstream.status)) {
            await options.usageStore.reject(identity, taskId, prepared.invocationId);
          }
          if (upstream.status === 413) {
            throw new HttpError(413, 'UPSTREAM_REQUEST_TOO_LARGE', 'Model provider rejected the request size');
          }
          throw new HttpError(502, 'UPSTREAM_REJECTED', 'Model provider rejected the request');
        }
        if (!(upstream.headers.get('content-type') ?? '').includes('text/event-stream') || !upstream.body) {
          observeRejection(!(upstream.headers.get('content-type') ?? '').includes('text/event-stream') ? 'unexpected_content_type' : 'missing_body');
          throw new HttpError(502, 'UPSTREAM_REJECTED', 'Model provider rejected the request');
        }
        if (chatRequest && !nativeChat) {
          upstream = chatCompletionsToResponsesStream(upstream, {
            responseId: `chat-${prepared.invocationId}`,
            tools: chatRequest.tools,
          });
        }
        const upstreamBodyStream = upstream.body;
        if (!upstreamBodyStream) throw new Error('Model stream was unavailable');
        response.writeHead(200, {
          'cache-control': 'no-store',
          'content-type': 'text/event-stream; charset=utf-8',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        const reader = upstreamBodyStream.getReader();
        const decoder = new TextDecoder();
        let pending = '';
        let completed: NonNullable<ReturnType<typeof parseCompletedUsage>> | undefined;
        let terminalFrame = '';
        let doneFrame = '';
        let sawTerminal = false;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true });
          const frames = pending.split(/\r?\n\r?\n/);
          pending = frames.pop() ?? '';
          for (const frame of frames) {
            const inspected = inspectSseFrame(frame, nativeChat);
            if (inspected.usage) {
              if (sawTerminal) throw new Error('Duplicate completed response');
              sawTerminal = true;
              completed = inspected.usage;
              terminalFrame = `${frame}\n\n`;
            } else if (inspected.done) {
              if (!sawTerminal || doneFrame) {
                throw new Error('Invalid terminal stream order');
              }
              doneFrame = `${frame}\n\n`;
            } else {
              if (sawTerminal) throw new Error('Invalid terminal stream order');
              await writeChunk(response, `${frame}\n\n`);
            }
          }
        }
        pending += decoder.decode();
        if (pending.trim()) {
          if (nativeChat) throw new Error('Truncated native Chat SSE frame');
          const inspected = inspectSseFrame(pending, nativeChat);
          if (inspected.usage) {
            if (sawTerminal) throw new Error('Duplicate completed response');
            sawTerminal = true;
            completed = inspected.usage;
            terminalFrame = `${pending}\n\n`;
          } else if (inspected.done) {
            if (!sawTerminal || doneFrame) {
              throw new Error('Invalid terminal stream order');
            }
            doneFrame = `${pending}\n\n`;
          } else {
            if (sawTerminal) throw new Error('Invalid terminal stream order');
            await writeChunk(response, pending);
          }
        }
        if (!completed || !terminalFrame || (nativeChat && !doneFrame)) {
          throw new Error('Completed usage was unavailable');
        }
        await options.usageStore.complete(prepared.invocationId, {
          tenantId: identity.tenantId,
          userId: identity.userId,
          taskId,
          traceId,
          modelId: route.id,
          providerId: route.providerId,
          ...completed,
          costUsd: usageCost(route, completed),
        });
        await writeChunk(response, terminalFrame);
        if (doneFrame) await writeChunk(response, doneFrame);
        response.end();
        return;
      }
      if (url.pathname === '/v1/images/generations' || url.pathname === '/v1/images/edits') {
        if (request.method !== 'POST') return method(response, 'POST');
        const edit = url.pathname === '/v1/images/edits';
        const correlation = imageCorrelation(request);
        imageObserver = createImageRequestObserver(options.imageObservation, correlation);
        const taskId = correlation.task_id;
        const traceId = correlation.trace_id;
        const editBody = edit ? await readImageEdit(request) : undefined;
        const body: Record<string, unknown> = editBody === undefined
          ? await readJson(request)
          : { model: editBody.model, prompt: editBody.prompt, images: editBody.images };
        const route = typeof body.model === 'string' ? routes.get(body.model) : undefined;
        if (!route || route.apiMode !== 'images-generations' || !principalAllowsRoute(identity, route.id)) {
          throw new HttpError(403, 'MODEL_ACCESS_DENIED', 'Model is not available');
        }
        if (!(await modelRouteEnabled(options.tenantModelRoutePolicy, identity.tenantId, route.id))) {
          throw new HttpError(403, 'MODEL_ACCESS_DENIED', 'Model is not available');
        }
        const allowedBodyKeys = new Set(['model', 'prompt', ...(edit ? ['images'] : ['size'])]);
        if (
          Object.keys(body).some((key) => !allowedBodyKeys.has(key)) ||
          typeof body.prompt !== 'string' ||
          body.prompt.length < 1 ||
          body.prompt.length > 32_000 ||
          body.prompt.includes('\0') ||
          (body.size !== undefined && !['auto', '1024x1024', '1024x1536', '1536x1024'].includes(String(body.size)))
        ) {
          throw new HttpError(400, 'INVALID_MODEL_REQUEST', `Invalid image ${edit ? 'edit' : 'generation'} request`);
        }
        const upstreamApiKey = await modelRouteUpstreamApiKey(options.tenantModelRoutePolicy, identity.tenantId, route);
        const generationBody = JSON.stringify({
          model: route.upstreamModelId,
          prompt: body.prompt,
          ...(body.size === undefined ? {} : { size: body.size }),
          n: 1,
          response_format: 'b64_json',
        });
        const editForm = (): FormData => {
          const form = new FormData();
          form.set('model', route.upstreamModelId);
          form.set('prompt', body.prompt as string);
          form.set('n', '1');
          form.set('response_format', 'b64_json');
          const images = editBody?.images ?? [];
          const field = images.length === 1 ? 'image' : 'image[]';
          images.forEach((image, index) => {
            const extension = image.mediaType === 'image/png' ? 'png' : image.mediaType === 'image/jpeg' ? 'jpg' : 'webp';
            form.append(
              field,
              new Blob([new Uint8Array(image.bytes)], { type: image.mediaType }),
              `image-${index + 1}.${extension}`
            );
          });
          return form;
        };
        const requestDigest = createHash('sha256')
          .update(
            edit
              ? JSON.stringify({ model: route.upstreamModelId, prompt: body.prompt, operation: 'edit' })
              : generationBody
          );
        for (const image of editBody?.images ?? []) {
          requestDigest
            .update('\0')
            .update(image.mediaType)
            .update('\0')
            .update(String(image.bytes.byteLength))
            .update('\0')
            .update(createHash('sha256').update(image.bytes).digest());
        }
        const routeFingerprint = fingerprintRoute(route);
        const invocationFact: InvocationFact = {
          tenantId: identity.tenantId,
          userId: identity.userId,
          taskId,
          traceId,
          modelId: route.id,
          providerId: route.providerId,
          requestDigest: requestDigest.digest('base64url'),
          routeFingerprint,
          imageTraffic: correlation.batch_id === undefined ? 'single' : 'batch',
        };
        let prepared: PreparedInvocation;
        try {
          prepared = await options.usageStore.prepare(invocationFact);
        } catch (error) {
          const failure = error instanceof InvocationAdmissionError
            ? imageFailureCode({ phase: 'admission' })
            : imageFailureCode({ phase: 'preflight' });
          imageObserver?.setFailure(failure);
          imageObserver?.emit('admission_decision', 'failed', failure);
          throw error;
        }
        if (prepared.status === 'PENDING') {
          const failure = imageFailureCode({ phase: 'preflight' });
          imageObserver?.setFailure(failure);
          imageObserver?.emit('admission_decision', 'failed', failure);
          throw new HttpError(
            409,
            'INVOCATION_RECONCILIATION_REQUIRED',
            'A previous image invocation has an unknown result'
          );
        }
        if (prepared.status === 'RECORDED') {
          const failure = imageFailureCode({ phase: 'preflight' });
          imageObserver?.setFailure(failure);
          imageObserver?.emit('admission_decision', 'failed', failure);
          if (!(await options.usageStore.finalize(identity, taskId))) throw new Error('Image usage finalization failed');
          throw new HttpError(409, 'INVOCATION_RESULT_ALREADY_RECORDED', 'This image invocation was already recorded');
        }
        if (prepared.status !== 'STARTED') {
          const failure = imageFailureCode({ phase: 'preflight' });
          imageObserver?.setFailure(failure);
          imageObserver?.emit('admission_decision', 'failed', failure);
          throw new Error('Invalid image invocation admission state');
        }
        imageObserver?.emit('admission_decision', 'admitted');
        const clientAbort = new AbortController();
        request.once('aborted', () => clientAbort.abort());
        response.once('close', () => clientAbort.abort());
        const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), clientAbort.signal]);
        let upstream: Response;
        imageObserver?.markSubmitted();
        imageObserver?.emit('provider_submit', 'submitted');
        try {
          upstream = await gatewayFetch(`${route.upstreamBaseUrl.replace(/\/$/, '')}/images/${edit ? 'edits' : 'generations'}`, {
            method: 'POST',
            headers: {
              accept: 'application/json',
              authorization: `Bearer ${upstreamApiKey}`,
              ...(edit ? {} : { 'content-type': 'application/json' }),
              'idempotency-key': prepared.invocationId,
            },
            body: edit ? editForm() : generationBody,
            redirect: 'error',
            signal,
          });
        } catch (error) {
          const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
          const failure = imageFailureCode({
            phase: 'provider',
            providerSubmitted: true,
            cancelled: clientAbort.signal.aborted,
            timedOut,
            definitelyNotAccepted: (error as { definitelyNotSubmitted?: unknown })?.definitelyNotSubmitted === true,
          });
          imageObserver?.setFailure(failure);
          imageObserver?.emit('provider_outcome', 'failed', failure);
          throw new HttpError(
            timedOut ? 504 : 502,
            timedOut ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNAVAILABLE',
            'Image provider temporarily unavailable'
          );
        }
        const observeRejection = (reason: UpstreamRejectionObservation['reason']) => observeUpstreamRejection(
          options.upstreamRejectionObservation, upstream,
          { invocation_id: prepared.invocationId, task_id: taskId, trace_id: traceId,
            route_id: route.id, provider_id: route.providerId, endpoint: edit ? 'image_edits' : 'image_generations' }, reason
        );
        if (!upstream.ok) {
          observeRejection('http_non_2xx');
          const definitelyRejected = definitelyRejectedStatuses.has(upstream.status);
          const failure = imageFailureCode({ phase: 'provider', providerSubmitted: true, definitelyRejected });
          imageObserver?.setFailure(failure);
          imageObserver?.emit('provider_outcome', 'failed', failure);
          if (definitelyRejected) {
            await options.usageStore.reject(identity, taskId, prepared.invocationId);
          }
          throw new HttpError(502, 'UPSTREAM_REJECTED', 'Image provider rejected the request');
        }
        if (!(upstream.headers.get('content-type') ?? '').includes('application/json')) {
          observeRejection('unexpected_content_type');
          const failure = imageFailureCode({ phase: 'provider', providerSubmitted: true });
          imageObserver?.setFailure(failure);
          imageObserver?.emit('provider_outcome', 'failed', failure);
          throw new HttpError(502, 'UPSTREAM_REJECTED', 'Image provider rejected the request');
        }
        const responseId = `image-${prepared.invocationId}`;
        let completed: ReturnType<typeof parseImageGenerationResponse>;
        try {
          completed = parseImageGenerationResponse(await upstream.json(), responseId);
        } catch (error) {
          observeRejection(upstream.body === null ? 'missing_body' : 'invalid_payload');
          const failure = imageFailureCode({ phase: 'provider', providerSubmitted: true });
          imageObserver?.setFailure(failure);
          imageObserver?.emit('provider_outcome', 'failed', failure);
          throw error;
        }
        imageObserver?.emit('provider_outcome', 'succeeded');
        await options.usageStore.complete(prepared.invocationId, {
          tenantId: identity.tenantId,
          userId: identity.userId,
          taskId,
          traceId,
          modelId: route.id,
          providerId: route.providerId,
          ...completed.usage,
          costUsd: usageCost(route, completed.usage),
        });
        if (!(await options.usageStore.finalize(identity, taskId))) throw new Error('Image usage finalization failed');
        json(response, 200, completed.body);
        imageObserver?.emit('client_response', 'succeeded');
        imageObserver?.markClientResponse();
        return;
      }
      const usageMatch = url.pathname.match(/^\/v1\/usage\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/);
      if (usageMatch) {
        if (request.method !== 'GET') return method(response, 'GET');
        const usage = await options.usageStore.finalize(identity, usageMatch[1] as string);
        if (!usage || !principalAllowsRoute(identity, usage.modelId)) {
          throw new HttpError(404, 'USAGE_NOT_FOUND', 'Usage was not found');
        }
        json(response, 200, signedUsage(usage, options.usageKeyId, options.usagePrivateKey));
        return;
      }
      throw new HttpError(404, 'NOT_FOUND', 'Not found');
    } catch (error) {
      if (imageObserver !== undefined && !imageObserver.clientResponseObserved) {
        const failure = imageObserver.failure(request.destroyed);
        imageObserver.emit('client_response', 'failed', failure);
        imageObserver.markClientResponse();
      }
      if (response.headersSent) {
        if (!response.writableEnded && !response.destroyed) {
          response.write(
            `event: error\ndata: ${JSON.stringify({
              type: 'error',
              code: 'UPSTREAM_STREAM_FAILED',
              message: 'Model stream interrupted',
            })}\n\n`
          );
          response.end();
        }
        return;
      }
      if (error instanceof InvocationRequestConflictError) {
        json(response, 409, {
          error: {
            code: 'INVOCATION_REQUEST_CONFLICT',
            message: 'The task identity is already bound to a different request',
          },
        });
        return;
      }
      if (error instanceof InvocationAdmissionError) {
        json(
          response,
          429,
          {
            error: {
              code: error.code,
              message: error.message,
              retryAfterMs: error.retryAfterMs,
            },
          },
          { 'retry-after': String(Math.ceil(error.retryAfterMs / 1_000)) }
        );
        return;
      }
      const known = error instanceof HttpError;
      json(response, known ? error.status : 503, {
        error: {
          code: known ? error.code : 'MODEL_GATEWAY_UNAVAILABLE',
          message: known ? error.message : 'Model Gateway temporarily unavailable',
        },
      });
    } finally {
      if (largeResponse) largeResponsesInFlight--;
    }
  };
}

export function createModelGatewayServer(options: ModelGatewayOptions): Server {
  const handler = createModelGatewayHandler(options);
  return createServer((request, response) => {
    void handler(request, response);
  });
}
