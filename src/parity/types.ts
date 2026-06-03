export type Endpoint = "read" | "create" | "update" | "delete" | "execute";

export type Category =
  | "PURE_READ"
  | "PUBLIC_READ"
  | "TEST_REPO_READ"
  | "PAIRED_WRITE"
  | "ONESHOT_WRITE"
  | "ORG_READ"
  | "COPILOT"
  | "SKIP";

export type ParityClass =
  | "IDENTICAL"
  | "STRUCTURAL_PARITY"
  | "UNVERIFIED_WRITE"
  | "DIVERGENT"
  | "OFFICIAL_ERROR"
  | "MCPAQL_ERROR"
  | "HARNESS_ERROR"
  | "BOTH_ERROR"
  | "SKIPPED";

export type ArgBuilder<F> = (
  fixtures: F,
  variant: "official" | "mcpaql",
) => Record<string, unknown> | null;

export type VerifyExpectation = "success" | "error";

export interface VerifyCallResult {
  ok: boolean;
  raw: unknown;
  payload: unknown;
  error?: string;
}

export interface VerifySpec<F> {
  name: string;
  args: ArgBuilder<F>;
  /** Expected official-side verify call outcome. Defaults to "success". */
  expect?: VerifyExpectation;
  /** Optional predicate for verification semantics that cannot be expressed as success/error. */
  isExpected?: (result: VerifyCallResult, fixtures: F) => boolean;
}

export interface OperationSpec<F> {
  /** The operation name as it appears in the adapter's schema. */
  name: string;
  /** Category drives the dual-call strategy and response comparison. */
  category: Category;
  /** Build arguments for the given variant; return null to skip this variant. */
  args: ArgBuilder<F>;
  /** For ONESHOT_WRITE: an op to call afterward to verify the mutation took effect. */
  verify?: VerifySpec<F>;
  /** Human-readable note explaining a SKIP or unusual semantic. */
  note?: string;
}

export interface Suite<F> {
  /** A human-readable identifier for this suite (e.g., "github-mcp"). */
  name: string;
  /** Upstream MCP server URL. */
  upstreamUrl: string;
  /** Optional extra headers to send on every upstream request (e.g., toolset selectors). */
  upstreamHeaders?: Record<string, string>;
  /** Env var name holding the bearer token. */
  tokenEnv: string;
  /** Operations declared by the suite. */
  operations: Array<OperationSpec<F>>;
  /** Create fixtures (test repos, paired records, etc.) before the run. */
  setupFixtures(): Promise<F>;
  /** Clean up after the run. */
  teardownFixtures(fixtures: F): Promise<void>;
}

export interface RunOptions<F = Record<string, unknown>> {
  adapterServerJs: string;
  /** Optional override for the adapter's bundled schema.json path. Defaults to the server file's directory. */
  schemaPath?: string;
  /** Optional override for provenance.json. Defaults to the server file's directory. */
  provenancePath?: string;
  /** Optional override for adapter process cwd. Defaults to adapter root when server is under dist/. */
  adapterCwd?: string;
  reportPath: string;
  /** If set, label written into the report; useful when running the same suite twice. */
  label?: string;
  /** Per-operation call timeout. Defaults to 30 seconds. Set <= 0 to disable. */
  timeoutMs?: number;
  /** If set, skip teardown; useful for debugging. Caller is responsible for cleanup. */
  skipTeardown?: boolean;
  /** If set, reuse these fixtures instead of calling setupFixtures (object or path to JSON file). */
  reuseFixtures?: F | string;
}

export interface OpResult {
  name: string;
  endpoint: string;
  category: Category | string;
  cls: ParityClass;
  detail?: string;
  ms: number;
  officialOk?: boolean;
  mcpaqlOk?: boolean;
  note?: string;
}

export interface RunReport {
  suite: string;
  startedAt: string;
  finishedAt: string;
  adapterPath: string;
  label?: string;
  upstreamUrl: string;
  totals: Record<string, number>;
  ops: OpResult[];
}

export interface AdapterSchema {
  operations: Record<string, Array<{ name: string }>>;
  headers?: Record<string, string>;
}

export interface AdapterProvenance {
  operations: Array<{
    operation_name: string;
    source_tool_name?: string;
    param_mappings?: Record<string, string>;
  }>;
}

export interface ResolvedAdapterPaths {
  adapterServerJs: string;
  schemaPath: string;
  provenancePath: string;
  adapterCwd: string;
}

export interface AdapterOperation {
  name: string;
  endpoint: Endpoint;
}

export interface AdapterMetadata {
  schema: AdapterSchema;
  adapterOps: AdapterOperation[];
  paramMappings: Record<string, Record<string, string>>;
  upstreamToolNames: Record<string, string>;
}
