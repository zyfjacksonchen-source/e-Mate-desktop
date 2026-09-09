export const ADMIN_USER_ROLES = ['TENANT_ADMIN', 'AUDIT_ADMIN', 'MEMBER'] as const;
export function isRetiredModelRoute(modelId: string): boolean {
  return modelId === 'doubao-seed-2-0-pro-260215' || modelId === 'gpt-image-2-pro' || modelId === 'gpt-image-2';
}
export const ASTRA_MODEL_ID = 'gpt-6-astra';
export function modelSupportsClient(modelId: string, clientVersion?: string): boolean {
  return !isRetiredModelRoute(modelId) && (modelId !== ASTRA_MODEL_ID || clientVersion === '2.0.18');
}
export const ADMIN_USER_STATUSES = ['PENDING_APPROVAL', 'ACTIVE', 'SUSPENDED', 'DELETED'] as const;
export const ADMIN_API_KEY_SCOPES = ['task-events:write', 'models:invoke'] as const;
export const ADMIN_API_KEY_PRINCIPAL_TYPES = ['USER', 'DEVICE'] as const;
export const DEFAULT_ENABLED_MODEL_ROUTE_IDS = [
  'gpt-5.6-luna',
  'gpt-5.6-sol',
  'deepseek',
  'gpt-image2.5-flare',
] as const;

const ADMIN_USER_UPDATE_STATUSES = ['PENDING_APPROVAL', 'ACTIVE', 'SUSPENDED'] as const;

export type AdminUserRole = (typeof ADMIN_USER_ROLES)[number];
export type AdminUserStatus = (typeof ADMIN_USER_STATUSES)[number];
export type AdminApiKeyScope = (typeof ADMIN_API_KEY_SCOPES)[number];
export type AdminApiKeyPrincipalType = (typeof ADMIN_API_KEY_PRINCIPAL_TYPES)[number];

export type TenantUser = {
  schemaVersion: 1;
  userId: string;
  displayName: string;
  roles: AdminUserRole[];
  status: AdminUserStatus;
  tokenLimit: number | null;
  allowedModelIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type TenantUserCreate = {
  schemaVersion: 1;
  userId: string;
  displayName: string;
  roles: AdminUserRole[];
  tokenLimit: number | null;
  allowedModelIds: string[];
  initialPassword: string;
};

export type TenantUserUpdate = {
  schemaVersion: 1;
  displayName: string;
  roles: AdminUserRole[];
  status: Exclude<AdminUserStatus, 'DELETED'>;
  tokenLimit: number | null;
  allowedModelIds: string[];
  expectedUpdatedAt: string;
};

export type TenantUserDelete = {
  schemaVersion: 1;
  expectedUpdatedAt: string;
};

export type AdminPasswordReset = {
  schemaVersion: 1;
  password: string;
};

export type AdminApiKeyMetadata = {
  schemaVersion: 1;
  keyId: string;
  label: string;
  principalType: AdminApiKeyPrincipalType;
  principalId: string;
  userId: string;
  scopes: AdminApiKeyScope[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

export type AdminApiKeyCreate = {
  schemaVersion: 1;
  label: string;
  principalType: AdminApiKeyPrincipalType;
  principalId: string;
  userId: string;
  scopes: AdminApiKeyScope[];
};

export type AdminApiKeyCreationResult = {
  schemaVersion: 1;
  key: AdminApiKeyMetadata;
  secret: string;
};

export type AdminModelRoute = {
  schemaVersion: 1;
  routeId: string;
  label: string;
  provider: string;
  published: boolean;
  enabled: boolean;
  updatedAt: string | null;
  keyConfigured: boolean;
  keyUpdatedAt: string | null;
};

export type AdminModelRouteUpdate = {
  schemaVersion: 1;
  enabled: boolean;
};

export const GPT_FAST_MODEL_IDS = ['gpt-5.6-luna', 'gpt-5.6-sol'] as const;
export type GptFastModelId = (typeof GPT_FAST_MODEL_IDS)[number];
export type AdminModelFastMode = {
  schemaVersion: 1;
  revision: string;
  enabledModelIds: GptFastModelId[];
};
export type AdminModelFastModeUpdate = {
  schemaVersion: 1;
  expectedRevision: string;
  modelIds: GptFastModelId[];
  enabled: boolean;
};

function fastModelIds(value: unknown): GptFastModelId[] {
  if (!Array.isArray(value) || value.length > GPT_FAST_MODEL_IDS.length ||
      new Set(value).size !== value.length ||
      value.some((id) => !(GPT_FAST_MODEL_IDS as readonly unknown[]).includes(id))) {
    throw new Error('Invalid GPT fast mode models');
  }
  return value as GptFastModelId[];
}

function fastModeRevision(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error('Invalid GPT fast mode revision');
  }
  return value;
}

export function parseAdminModelFastMode(value: unknown): AdminModelFastMode {
  const input = record(value, 'GPT fast mode');
  exact(input, ['schemaVersion', 'revision', 'enabledModelIds'], 'GPT fast mode');
  if (input.schemaVersion !== 1) throw new Error('Invalid GPT fast mode version');
  return { schemaVersion: 1, revision: fastModeRevision(input.revision), enabledModelIds: fastModelIds(input.enabledModelIds) };
}

export function parseAdminModelFastModeUpdate(value: unknown): AdminModelFastModeUpdate {
  const input = record(value, 'GPT fast mode update');
  exact(input, ['schemaVersion', 'expectedRevision', 'modelIds', 'enabled'], 'GPT fast mode update');
  const modelIds = fastModelIds(input.modelIds);
  if (input.schemaVersion !== 1 || typeof input.enabled !== 'boolean' || !modelIds.length) {
    throw new Error('Invalid GPT fast mode update');
  }
  return { schemaVersion: 1, expectedRevision: fastModeRevision(input.expectedRevision), modelIds, enabled: input.enabled };
}

export type AdminModelRoutePublication = {
  schemaVersion: 1;
  published: boolean;
};

export type AdminModelRouteKeyUpdate = {
  schemaVersion: 1;
  apiKey: string;
};

export type ConsentPolicy = {
  schemaVersion: 1;
  agreementId: string;
  agreementVersion: string;
  disclaimerVersion: string;
  contentHash: string;
};

export type ConsentAcceptanceInput = ConsentPolicy & {
  termsAccepted: true;
  policyRead: true;
  lawfulUseConfirmed: true;
  clientVersion: string;
  locale: string;
};

export type ConsentAcceptance = ConsentPolicy & {
  acceptanceId: string;
  userId: string;
  acceptedAt: string;
  clientVersion: string;
  locale: string;
};

export type ConsentStatus = {
  schemaVersion: 1;
  policy: ConsentPolicy;
  required: boolean;
  acceptance: ConsentAcceptance | null;
};

export type AdminConsentQuery = {
  userId?: string;
  agreementVersion?: string;
  disclaimerVersion?: string;
  acceptedFrom?: string;
  acceptedTo?: string;
  limit: number;
};

export type AdminConsentList = { schemaVersion: 1; acceptances: ConsentAcceptance[] };

export function isDefaultEnabledModelRoute(routeId: string): boolean {
  return (DEFAULT_ENABLED_MODEL_ROUTE_IDS as readonly string[]).includes(routeId);
}

export type TenantUserList = { schemaVersion: 1; users: TenantUser[] };
export type AdminApiKeyList = { schemaVersion: 1; keys: AdminApiKeyMetadata[] };
export type AdminModelRouteList = { schemaVersion: 1; routes: AdminModelRoute[] };

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function exact(input: Record<string, unknown>, expected: string[], label: string): void {
  const actual = Object.keys(input);
  const allowed = new Set(expected);
  if (actual.length !== expected.length || actual.some((key) => !allowed.has(key))) {
    throw new Error(`Invalid ${label} fields`);
  }
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function text(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    value.length < 1 ||
    value.length > maximum ||
    /\p{Cc}/u.test(value)
  ) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid ${label}`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function nullableTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : timestamp(value, label);
}

function tokenLimit(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error('Invalid token limit');
  }
  return value as number;
}

function modelRouteIds(value: unknown, allowEmpty: boolean): string[] {
  if (!Array.isArray(value) || value.length > 20 || (!allowEmpty && value.length === 0)) {
    throw new Error('Invalid allowed model ids');
  }
  const values = value.map((item) => identifier(item, 'allowed model id'));
  if (values.includes('e-mate-faux') || new Set(values).size !== values.length) {
    throw new Error('Invalid allowed model ids');
  }
  return values;
}

function password(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length < 12 || value.length > 1_024 || /\p{Cc}/u.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function contentHash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error('Invalid consent content hash');
  }
  return value;
}

function locale(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(value) || value.length > 35) {
    throw new Error('Invalid consent locale');
  }
  return value;
}

function consentVersion(value: unknown, label: string): string {
  return text(value, label, 64);
}

export function parseConsentPolicy(value: unknown): ConsentPolicy {
  const input = record(value, 'consent policy');
  exact(
    input,
    ['schemaVersion', 'agreementId', 'agreementVersion', 'disclaimerVersion', 'contentHash'],
    'consent policy'
  );
  if (input.schemaVersion !== 1) throw new Error('Invalid consent policy schema');
  return {
    schemaVersion: 1,
    agreementId: identifier(input.agreementId, 'consent agreement id'),
    agreementVersion: consentVersion(input.agreementVersion, 'consent agreement version'),
    disclaimerVersion: consentVersion(input.disclaimerVersion, 'consent disclaimer version'),
    contentHash: contentHash(input.contentHash),
  };
}

export function parseConsentAcceptanceInput(value: unknown): ConsentAcceptanceInput {
  const input = record(value, 'consent acceptance');
  exact(
    input,
    [
      'schemaVersion',
      'agreementId',
      'agreementVersion',
      'disclaimerVersion',
      'contentHash',
      'termsAccepted',
      'policyRead',
      'lawfulUseConfirmed',
      'clientVersion',
      'locale',
    ],
    'consent acceptance'
  );
  if (input.termsAccepted !== true || input.policyRead !== true || input.lawfulUseConfirmed !== true) {
    throw new Error('Invalid consent confirmations');
  }
  return {
    ...parseConsentPolicy({
      schemaVersion: input.schemaVersion,
      agreementId: input.agreementId,
      agreementVersion: input.agreementVersion,
      disclaimerVersion: input.disclaimerVersion,
      contentHash: input.contentHash,
    }),
    termsAccepted: true,
    policyRead: true,
    lawfulUseConfirmed: true,
    clientVersion: text(input.clientVersion, 'consent client version', 64),
    locale: locale(input.locale),
  };
}

function parseConsentAcceptanceValue(value: unknown): ConsentAcceptance {
  const input = record(value, 'consent acceptance record');
  exact(
    input,
    [
      'schemaVersion',
      'agreementId',
      'agreementVersion',
      'disclaimerVersion',
      'contentHash',
      'acceptanceId',
      'userId',
      'acceptedAt',
      'clientVersion',
      'locale',
    ],
    'consent acceptance record'
  );
  return {
    ...parseConsentPolicy({
      schemaVersion: input.schemaVersion,
      agreementId: input.agreementId,
      agreementVersion: input.agreementVersion,
      disclaimerVersion: input.disclaimerVersion,
      contentHash: input.contentHash,
    }),
    acceptanceId: identifier(input.acceptanceId, 'consent acceptance id'),
    userId: identifier(input.userId, 'consent user id'),
    acceptedAt: timestamp(input.acceptedAt, 'consent accepted time'),
    clientVersion: text(input.clientVersion, 'consent client version', 64),
    locale: locale(input.locale),
  };
}

export function parseConsentAcceptance(value: unknown): ConsentAcceptance {
  return parseConsentAcceptanceValue(value);
}

export function parseConsentStatus(value: unknown): ConsentStatus {
  const input = record(value, 'consent status');
  exact(input, ['schemaVersion', 'policy', 'required', 'acceptance'], 'consent status');
  if (input.schemaVersion !== 1 || typeof input.required !== 'boolean') {
    throw new Error('Invalid consent status');
  }
  const policy = parseConsentPolicy(input.policy);
  const acceptance = input.acceptance === null ? null : parseConsentAcceptanceValue(input.acceptance);
  if (input.required !== (acceptance === null)) throw new Error('Invalid consent status state');
  if (
    acceptance &&
    (acceptance.agreementId !== policy.agreementId ||
      acceptance.agreementVersion !== policy.agreementVersion ||
      acceptance.disclaimerVersion !== policy.disclaimerVersion ||
      acceptance.contentHash !== policy.contentHash)
  ) {
    throw new Error('Invalid consent status policy');
  }
  return { schemaVersion: 1, policy, required: input.required, acceptance };
}

export function parseAdminConsentQuery(value: unknown): AdminConsentQuery {
  const input = record(value, 'admin consent query');
  const allowed = new Set(['userId', 'agreementVersion', 'disclaimerVersion', 'acceptedFrom', 'acceptedTo', 'limit']);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new Error('Invalid admin consent query fields');
  const acceptedFrom = input.acceptedFrom === undefined ? undefined : timestamp(input.acceptedFrom, 'accepted from');
  const acceptedTo = input.acceptedTo === undefined ? undefined : timestamp(input.acceptedTo, 'accepted to');
  const limit = input.limit === undefined ? 100 : input.limit;
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 200) {
    throw new Error('Invalid admin consent query limit');
  }
  if (acceptedFrom && acceptedTo && acceptedFrom > acceptedTo) {
    throw new Error('Invalid admin consent query range');
  }
  return {
    ...(input.userId === undefined ? {} : { userId: identifier(input.userId, 'consent user id') }),
    ...(input.agreementVersion === undefined
      ? {}
      : { agreementVersion: consentVersion(input.agreementVersion, 'consent agreement version') }),
    ...(input.disclaimerVersion === undefined
      ? {}
      : { disclaimerVersion: consentVersion(input.disclaimerVersion, 'consent disclaimer version') }),
    ...(acceptedFrom ? { acceptedFrom } : {}),
    ...(acceptedTo ? { acceptedTo } : {}),
    limit: limit as number,
  };
}

export function parseAdminConsentList(value: unknown): AdminConsentList {
  const input = record(value, 'admin consent list');
  exact(input, ['schemaVersion', 'acceptances'], 'admin consent list');
  if (input.schemaVersion !== 1 || !Array.isArray(input.acceptances) || input.acceptances.length > 200) {
    throw new Error('Invalid admin consent list');
  }
  return { schemaVersion: 1, acceptances: input.acceptances.map(parseConsentAcceptanceValue) };
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`Invalid ${label}`);
  }
  return value as T;
}

function uniqueValues<T extends string>(value: unknown, allowed: readonly T[], label: string): T[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > allowed.length) {
    throw new Error(`Invalid ${label}`);
  }
  const values = value.map((item) => oneOf(item, allowed, label));
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}`);
  return values;
}

function apiKeyScopes(value: unknown): AdminApiKeyScope[] {
  const scopes = uniqueValues(value, ADMIN_API_KEY_SCOPES, 'key scopes');
  return ADMIN_API_KEY_SCOPES.filter((scope) => scopes.includes(scope));
}

function parseTenantUserValue(value: unknown): TenantUser {
  const input = record(value, 'tenant user');
  exact(
    input,
    [
      'schemaVersion',
      'userId',
      'displayName',
      'roles',
      'status',
      'tokenLimit',
      'allowedModelIds',
      'createdAt',
      'updatedAt',
    ],
    'tenant user'
  );
  if (input.schemaVersion !== 1) throw new Error('Invalid tenant user schema');
  return {
    schemaVersion: 1,
    userId: identifier(input.userId, 'user id'),
    displayName: text(input.displayName, 'display name', 120),
    roles: uniqueValues(input.roles, ADMIN_USER_ROLES, 'user roles'),
    status: oneOf(input.status, ADMIN_USER_STATUSES, 'user status'),
    tokenLimit: tokenLimit(input.tokenLimit),
    allowedModelIds: modelRouteIds(input.allowedModelIds, true),
    createdAt: timestamp(input.createdAt, 'user created time'),
    updatedAt: timestamp(input.updatedAt, 'user updated time'),
  };
}

export function parseTenantUser(value: unknown): TenantUser {
  return parseTenantUserValue(value);
}

export function parseTenantUserCreate(value: unknown): TenantUserCreate {
  const input = record(value, 'tenant user creation');
  exact(
    input,
    ['schemaVersion', 'userId', 'displayName', 'roles', 'tokenLimit', 'allowedModelIds', 'initialPassword'],
    'tenant user creation'
  );
  if (input.schemaVersion !== 1) throw new Error('Invalid tenant user creation schema');
  const limit = tokenLimit(input.tokenLimit);
  const allowedModelIds = modelRouteIds(input.allowedModelIds, false);
  return {
    schemaVersion: 1,
    userId: identifier(input.userId, 'user id'),
    displayName: text(input.displayName, 'display name', 120),
    roles: uniqueValues(input.roles, ADMIN_USER_ROLES, 'user roles'),
    tokenLimit: limit,
    allowedModelIds,
    initialPassword: password(input.initialPassword, 'initial password'),
  };
}

export function parseTenantUserUpdate(value: unknown): TenantUserUpdate {
  const input = record(value, 'tenant user update');
  exact(
    input,
    ['schemaVersion', 'displayName', 'roles', 'status', 'tokenLimit', 'allowedModelIds', 'expectedUpdatedAt'],
    'tenant user update'
  );
  if (input.schemaVersion !== 1) throw new Error('Invalid tenant user update schema');
  const status = oneOf(input.status, ADMIN_USER_UPDATE_STATUSES, 'user status');
  const limit = tokenLimit(input.tokenLimit);
  const allowedModelIds = modelRouteIds(input.allowedModelIds, status !== 'ACTIVE');
  return {
    schemaVersion: 1,
    displayName: text(input.displayName, 'display name', 120),
    roles: uniqueValues(input.roles, ADMIN_USER_ROLES, 'user roles'),
    status,
    tokenLimit: limit,
    allowedModelIds,
    expectedUpdatedAt: timestamp(input.expectedUpdatedAt, 'expected user update time'),
  };
}

export function parseTenantUserDelete(value: unknown): TenantUserDelete {
  const input = record(value, 'tenant user deletion');
  exact(input, ['schemaVersion', 'expectedUpdatedAt'], 'tenant user deletion');
  if (input.schemaVersion !== 1) throw new Error('Invalid tenant user deletion schema');
  return {
    schemaVersion: 1,
    expectedUpdatedAt: timestamp(input.expectedUpdatedAt, 'expected user deletion time'),
  };
}

export function parseAdminPasswordReset(value: unknown): AdminPasswordReset {
  const input = record(value, 'admin password reset');
  exact(input, ['schemaVersion', 'password'], 'admin password reset');
  if (input.schemaVersion !== 1) throw new Error('Invalid admin password reset schema');
  return { schemaVersion: 1, password: password(input.password, 'replacement password') };
}

function parseAdminApiKeyMetadataValue(value: unknown): AdminApiKeyMetadata {
  const input = record(value, 'admin API key');
  exact(
    input,
    [
      'schemaVersion',
      'keyId',
      'label',
      'principalType',
      'principalId',
      'userId',
      'scopes',
      'createdAt',
      'lastUsedAt',
      'revokedAt',
    ],
    'admin API key'
  );
  if (input.schemaVersion !== 1) throw new Error('Invalid admin API key schema');
  const metadata: AdminApiKeyMetadata = {
    schemaVersion: 1,
    keyId: identifier(input.keyId, 'key id'),
    label: text(input.label, 'key label', 120),
    principalType: oneOf(input.principalType, ADMIN_API_KEY_PRINCIPAL_TYPES, 'key principal type'),
    principalId: identifier(input.principalId, 'key principal id'),
    userId: identifier(input.userId, 'key user id'),
    scopes: apiKeyScopes(input.scopes),
    createdAt: timestamp(input.createdAt, 'key created time'),
    lastUsedAt: nullableTimestamp(input.lastUsedAt, 'key last used time'),
    revokedAt: nullableTimestamp(input.revokedAt, 'key revoked time'),
  };
  if (metadata.scopes.includes('models:invoke') && metadata.principalType !== 'USER') {
    throw new Error('Model access key must be user-bound');
  }
  if (metadata.scopes.includes('task-events:write') && metadata.revokedAt === null) {
    throw new Error('Legacy task credential must be revoked');
  }
  return metadata;
}

export function parseAdminApiKeyCreate(value: unknown): AdminApiKeyCreate {
  const input = record(value, 'admin API key creation');
  exact(
    input,
    ['schemaVersion', 'label', 'principalType', 'principalId', 'userId', 'scopes'],
    'admin API key creation'
  );
  if (input.schemaVersion !== 1) throw new Error('Invalid admin API key creation schema');
  const principalType = oneOf(input.principalType, ADMIN_API_KEY_PRINCIPAL_TYPES, 'key principal type');
  const principalId = identifier(input.principalId, 'key principal id');
  const userId = identifier(input.userId, 'key user id');
  if (principalType === 'USER' && principalId !== userId) {
    throw new Error('User key principal must match its user');
  }
  const scopes = apiKeyScopes(input.scopes);
  if (scopes.length !== 1 || scopes[0] !== 'models:invoke') {
    throw new Error('Invalid key scopes');
  }
  if (scopes.includes('models:invoke') && principalType !== 'USER') {
    throw new Error('Model access key must be user-bound');
  }
  return {
    schemaVersion: 1,
    label: text(input.label, 'key label', 120),
    principalType,
    principalId,
    userId,
    scopes,
  };
}

export function parseAdminApiKeyCreationResult(value: unknown): AdminApiKeyCreationResult {
  const input = record(value, 'admin API key creation result');
  exact(input, ['schemaVersion', 'key', 'secret'], 'admin API key creation result');
  if (
    input.schemaVersion !== 1 ||
    typeof input.secret !== 'string' ||
    !/^emate_twe_[A-Za-z0-9_-]{43}$/.test(input.secret)
  ) {
    throw new Error('Invalid admin API key creation result');
  }
  return {
    schemaVersion: 1,
    key: parseAdminApiKeyMetadataValue(input.key),
    secret: input.secret,
  };
}

export function parseAdminModelRouteUpdate(value: unknown): AdminModelRouteUpdate {
  const input = record(value, 'admin model route update');
  exact(input, ['schemaVersion', 'enabled'], 'admin model route update');
  if (input.schemaVersion !== 1 || typeof input.enabled !== 'boolean') {
    throw new Error('Invalid admin model route update');
  }
  return { schemaVersion: 1, enabled: input.enabled };
}

export function parseAdminModelRoutePublication(value: unknown): AdminModelRoutePublication {
  const input = record(value, 'admin model route publication');
  exact(input, ['schemaVersion', 'published'], 'admin model route publication');
  if (input.schemaVersion !== 1 || typeof input.published !== 'boolean') {
    throw new Error('Invalid admin model route publication');
  }
  return { schemaVersion: 1, published: input.published };
}

export function parseAdminModelRouteKeyUpdate(value: unknown): AdminModelRouteKeyUpdate {
  const input = record(value, 'admin model route key update');
  exact(input, ['schemaVersion', 'apiKey'], 'admin model route key update');
  if (
    input.schemaVersion !== 1 ||
    typeof input.apiKey !== 'string' ||
    input.apiKey.length < 20 ||
    input.apiKey.length > 8_192 ||
    /\s/.test(input.apiKey)
  ) {
    throw new Error('Invalid admin model route key update');
  }
  return { schemaVersion: 1, apiKey: input.apiKey };
}

function parseAdminModelRouteValue(value: unknown): AdminModelRoute {
  const input = record(value, 'admin model route');
  exact(
    input,
    [
      'schemaVersion',
      'routeId',
      'label',
      'provider',
      'published',
      'enabled',
      'updatedAt',
      'keyConfigured',
      'keyUpdatedAt',
    ],
    'admin model route'
  );
  if (
    input.schemaVersion !== 1 ||
    typeof input.published !== 'boolean' ||
    typeof input.enabled !== 'boolean' ||
    typeof input.keyConfigured !== 'boolean'
  ) {
    throw new Error('Invalid admin model route');
  }
  const keyUpdatedAt = nullableTimestamp(input.keyUpdatedAt, 'route key updated time');
  if (input.keyConfigured !== (keyUpdatedAt !== null)) {
    throw new Error('Invalid admin model route key state');
  }
  return {
    schemaVersion: 1,
    routeId: identifier(input.routeId, 'route id'),
    label: text(input.label, 'route label', 120),
    provider: text(input.provider, 'route provider', 120),
    published: input.published,
    enabled: input.enabled,
    updatedAt: nullableTimestamp(input.updatedAt, 'route updated time'),
    keyConfigured: input.keyConfigured,
    keyUpdatedAt,
  };
}

export function parseTenantUserList(value: unknown): TenantUserList {
  const input = record(value, 'tenant user list');
  exact(input, ['schemaVersion', 'users'], 'tenant user list');
  if (input.schemaVersion !== 1 || !Array.isArray(input.users) || input.users.length > 10_000) {
    throw new Error('Invalid tenant user list');
  }
  return { schemaVersion: 1, users: input.users.map(parseTenantUserValue) };
}

export function parseAdminApiKeyList(value: unknown): AdminApiKeyList {
  const input = record(value, 'admin API key list');
  exact(input, ['schemaVersion', 'keys'], 'admin API key list');
  if (input.schemaVersion !== 1 || !Array.isArray(input.keys) || input.keys.length > 10_000) {
    throw new Error('Invalid admin API key list');
  }
  return { schemaVersion: 1, keys: input.keys.map(parseAdminApiKeyMetadataValue) };
}

export function parseAdminModelRouteList(value: unknown): AdminModelRouteList {
  const input = record(value, 'admin model route list');
  exact(input, ['schemaVersion', 'routes'], 'admin model route list');
  if (input.schemaVersion !== 1 || !Array.isArray(input.routes) || input.routes.length > 100) {
    throw new Error('Invalid admin model route list');
  }
  return { schemaVersion: 1, routes: input.routes.map(parseAdminModelRouteValue) };
}
