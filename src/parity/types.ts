import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { NormalizeOptions } from "./comparison.js";

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
  /** Both arms failed, and the adapter passed through the same upstream error the official arm returned. */
  | "SAME_ERROR"
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

/** A local upstream MCP server the harness launches over stdio. */
export interface StdioUpstream {
  command: string;
  args?: string[];
  cwd?: string;
  /** Added to the harness's own environment, which both the upstream and the adapter inherit. */
  env?: Record<string, string>;
}

/** The two connected clients, for suites whose fixtures live in an upstream session. */
export interface ParityClients {
  official: Client;
  mcpaql: Client;
}

export interface Suite<F> {
  /** A human-readable identifier for this suite (e.g., "github-mcp"). */
  name: string;
  /** Upstream MCP server URL (Streamable HTTP). Set this or upstreamStdio. */
  upstreamUrl?: string;
  /** Upstream MCP server launched over stdio. Set this or upstreamUrl. */
  upstreamStdio?: StdioUpstream;
  /** Optional extra headers to send on every upstream request (e.g., toolset selectors). HTTP only. */
  upstreamHeaders?: Record<string, string>;
  /** Env var name holding the bearer token. Required for HTTP; optional for stdio. */
  tokenEnv?: string;
  /** Operations declared by the suite. */
  operations: Array<OperationSpec<F>>;
  /**
   * Optional: extra keys to treat as volatile when comparing, for upstream fields that differ
   * between any two server processes (a process id, a temp path).
   */
  normalize?: NormalizeOptions;
  /** Create fixtures (test repos, paired records, etc.) before the run. */
  setupFixtures(): Promise<F>;
  /** Clean up after the run. */
  teardownFixtures(fixtures: F): Promise<void>;
  /**
   * Optional: open upstream sessions once both clients are connected, for upstreams whose
   * state lives in the server process (an opened file, a session id). Each arm has its own
   * upstream, so a session is opened on each; the returned fixtures replace the originals.
   * If it throws, closeSessions still runs with the fixtures it was given, so a suite that opens
   * several sessions should record each one on that object as it goes.
   */
  openSessions?(fixtures: F, clients: ParityClients): Promise<F>;
  /** Optional: close what openSessions opened, before the clients disconnect. */
  closeSessions?(fixtures: F, clients: ParityClients): Promise<void>;
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
  /** Per-operation call timeout, reset by each progress notification. Defaults to 30 seconds. Set <= 0 to disable. */
  timeoutMs?: number;
  /** Hard cap per call regardless of progress; the call is cancelled when it is reached. */
  maxTotalTimeoutMs?: number;
  /** If set, skip teardown; useful for debugging. Caller is responsible for cleanup. */
  skipTeardown?: boolean;
  /** If set, reuse these fixtures instead of calling setupFixtures (object or path to JSON file). */
  reuseFixtures?: F | string;
}

export interface CallTimeouts {
  /** Per-call timeout, reset by each progress notification; <= 0 disables it. */
  timeoutMs: number;
  /** Hard cap per call regardless of progress. */
  maxTotalTimeoutMs?: number;
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
  /** The upstream URL, or "stdio:<command>" for a stdio upstream. */
  upstreamUrl: string;
  upstreamTransport: "http" | "stdio";
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
