// Product storage ports shared by the Worker bindings and the on-host adapters.
export interface HubStatement {
  bind(...values: unknown[]): HubStatement
  first(): Promise<Record<string, unknown> | null>
  all(): Promise<{ results: Record<string, unknown>[] }>
  run(): Promise<{ meta: { changes: number } }>
}
export interface HubDatabase {
  prepare(sql: string): HubStatement
  batch(statements: HubStatement[]): Promise<Array<{ meta: { changes: number } }>>
}
export type PackageMetadata = {
  key: string
  size: number
  customMetadata?: Record<string, string>
  httpMetadata?: { contentType?: string; cacheControl?: string }
}
export interface HubPackages {
  head(key: string): Promise<PackageMetadata | null>
  get(key: string): Promise<(PackageMetadata & { body: ReadableStream<Uint8Array> }) | null>
  put(key: string, bytes: Uint8Array, options: Omit<PackageMetadata, 'key' | 'size'>): Promise<PackageMetadata>
  list(options?: { limit?: number }): Promise<{ objects: PackageMetadata[]; truncated: boolean }>
}
export type HubBindings = {
  AUTHOR_KEY: string
  MODEL_SESSION_VALIDATION_URL: string
  INTERNAL_VALIDATION?: true
  DB: HubDatabase
  PACKAGES: HubPackages
}
