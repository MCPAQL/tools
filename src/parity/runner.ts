import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { resolveHeaderEnv, writeJsonFile } from "../shared.js";
import { DEFAULT_TIMEOUT_MS, loadAdapterMetadata, resolveAdapterPaths } from "./metadata.js";
import { runOperation } from "./operation.js";
import type { OpResult, ParityClients, RunOptions, RunReport, StdioUpstream, Suite } from "./types.js";

type UntimedOpResult = Omit<OpResult, "ms">;
type ClosableClient = Pick<Client, "close">;

export async function runParitySuite<F>(
  suite: Suite<F>,
  options: RunOptions<F>,
): Promise<RunReport> {
  const upstream = resolveUpstream(suite);
  const token = suite.tokenEnv ? process.env[suite.tokenEnv] : undefined;
  if (upstream.transport === "http" && !token) throw new Error(`Token env var "${suite.tokenEnv ?? "<tokenEnv>"}" not set.`);
  const timeouts = { timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxTotalTimeoutMs: options.maxTotalTimeoutMs };
  const adapterPaths = resolveAdapterPaths(options);
  const { schema, adapterOps, paramMappings, upstreamToolNames } = await loadAdapterMetadata(adapterPaths);

  const officialExtraHeaders = upstream.transport === "http"
    ? mergeOfficialExtraHeaders(suite.name, suite.tokenEnv ?? "", suite.upstreamHeaders ?? {}, schema.headers ?? {})
    : {};

  const opSpecs = new Map(suite.operations.map((o) => [o.name, o]));

  console.log(`[${suite.name}] adapter exposes ${adapterOps.length} ops; suite has builders for ${opSpecs.size}`);
  if (Object.keys(officialExtraHeaders).length > 0) console.log(`[${suite.name}] forwarding extra headers to official:`, Object.keys(officialExtraHeaders).join(", "));

  let fixtures: F;
  if (options.reuseFixtures && typeof options.reuseFixtures === "string") {
    fixtures = JSON.parse(await readFile(options.reuseFixtures, "utf8")) as F;
    console.log(`[${suite.name}] reusing fixtures from ${options.reuseFixtures}`);
  } else if (options.reuseFixtures) {
    fixtures = options.reuseFixtures as F;
  } else {
    fixtures = await suite.setupFixtures();
  }

  const official = new Client({ name: "parity-official", version: "0.1.0" });
  const mcpaql = new Client({ name: "parity-mcpaql", version: "0.1.0" });

  const ops: OpResult[] = [];
  const totals: Record<string, number> = { TOTAL: 0 };
  const startedAt = new Date().toISOString();

  const clients: ParityClients = { official, mcpaql };
  let sessionsOpen = false;

  try {
    const officialTransport = upstream.transport === "http"
      ? new StreamableHTTPClientTransport(new URL(upstream.url), {
        requestInit: { headers: { ...officialExtraHeaders, Authorization: `Bearer ${token}` } },
      })
      : new StdioClientTransport({
        command: upstream.stdio.command,
        args: upstream.stdio.args ?? [],
        cwd: upstream.stdio.cwd,
        env: harnessEnvironment(upstream.stdio),
        stderr: "inherit",
      });
    const mcpaqlTransport = new StdioClientTransport({
      command: "node",
      args: [adapterPaths.adapterServerJs],
      cwd: adapterPaths.adapterCwd,
      env: {
        ...harnessEnvironment(upstream.transport === "stdio" ? upstream.stdio : undefined),
        ...(suite.tokenEnv && token ? { [suite.tokenEnv]: token } : {}),
      },
      stderr: "inherit",
    });

    await official.connect(officialTransport);
    await mcpaql.connect(mcpaqlTransport);

    if (suite.openSessions) {
      // Marked open first, so closeSessions also runs when opening fails partway.
      sessionsOpen = true;
      fixtures = await suite.openSessions(fixtures, clients);
    }

    for (const adapterOp of adapterOps) {
      const t0 = Date.now();
      const spec = opSpecs.get(adapterOp.name);
      let result: UntimedOpResult;
      if (!spec) {
        result = { name: adapterOp.name, endpoint: adapterOp.endpoint, category: "SKIP", cls: "SKIPPED", detail: "no suite arg builder" };
      } else {
        try {
          result = await runOperation(spec, adapterOp.endpoint, fixtures, official, mcpaql, upstreamToolNames, paramMappings[spec.name], paramMappings, timeouts, suite.normalize);
        } catch (e) {
          result = { name: spec.name, endpoint: adapterOp.endpoint, category: spec.category, cls: "HARNESS_ERROR", detail: `harness exception: ${(e as Error).message}` };
        }
        if (spec.note) result.note = spec.note;
      }
      const timedResult: OpResult = { ...result, ms: Date.now() - t0 };
      ops.push(timedResult);
      totals[timedResult.cls] = (totals[timedResult.cls] ?? 0) + 1;
      totals.TOTAL++;
      console.log(`  ${pad(adapterOp.name, 44)} ${pad(timedResult.category, 18)} -> ${timedResult.cls}${timedResult.detail ? " :: " + timedResult.detail.slice(0, 80) : ""}`);
    }
  } finally {
    if (sessionsOpen && suite.closeSessions) {
      try { await suite.closeSessions(fixtures, clients); } catch (e) { console.error(`[${suite.name}] closing sessions failed:`, (e as Error).message); }
    }
    await closeParityClients(official, mcpaql);
    if (!options.skipTeardown && !options.reuseFixtures) {
      try { await suite.teardownFixtures(fixtures); } catch (e) { console.error(`[${suite.name}] teardown failed:`, (e as Error).message); }
    }
  }

  const report: RunReport = {
    suite: suite.name,
    startedAt,
    finishedAt: new Date().toISOString(),
    adapterPath: adapterPaths.adapterServerJs,
    label: options.label,
    upstreamUrl: upstream.transport === "http" ? upstream.url : `stdio:${upstream.stdio.command}`,
    upstreamTransport: upstream.transport,
    totals,
    ops,
  };
  await writeRunReport(options.reportPath, report);
  console.log(`[${suite.name}] report:`, options.reportPath);
  console.log(`[${suite.name}] totals:`, totals);
  return report;
}

type ResolvedUpstream =
  | { transport: "http"; url: string }
  | { transport: "stdio"; stdio: StdioUpstream };

export function resolveUpstream(suite: Pick<Suite<unknown>, "name" | "upstreamUrl" | "upstreamStdio">): ResolvedUpstream {
  if (suite.upstreamUrl && suite.upstreamStdio) {
    throw new Error(`Suite "${suite.name}" sets both upstreamUrl and upstreamStdio; set one.`);
  }
  if (suite.upstreamStdio) {
    if (typeof suite.upstreamStdio.command !== "string" || suite.upstreamStdio.command === "") {
      throw new Error(`Suite "${suite.name}" upstreamStdio needs a command.`);
    }
    return { transport: "stdio", stdio: suite.upstreamStdio };
  }
  if (suite.upstreamUrl) return { transport: "http", url: suite.upstreamUrl };
  throw new Error(`Suite "${suite.name}" needs upstreamUrl or upstreamStdio.`);
}

// Both arms start from the same environment, so a stdio upstream sees the same variables
// whether the harness launches it directly or the adapter does.
function harnessEnvironment(stdio: StdioUpstream | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  return { ...env, ...(stdio?.env ?? {}) };
}

export async function writeRunReport(reportPath: string, report: RunReport): Promise<void> {
  await writeJsonFile(reportPath, report);
}

export async function closeParityClients(
  official: ClosableClient,
  mcpaql: ClosableClient,
): Promise<void> {
  await Promise.allSettled([
    official.close(),
    mcpaql.close(),
  ]);
}

export function mergeOfficialExtraHeaders(
  suiteName: string,
  tokenEnv: string,
  suiteHeaders: Record<string, string>,
  schemaHeaders: Record<string, string>,
): Record<string, string> {
  const mergedHeaders = mergeHeadersCaseInsensitive(suiteHeaders, schemaHeaders);
  warnOnHeaderOverrides(suiteName, suiteHeaders, schemaHeaders);
  return resolveHeaderEnv(stripAuthorizationHeaders(suiteName, tokenEnv, mergedHeaders));
}

function mergeHeadersCaseInsensitive(
  suiteHeaders: Record<string, string>,
  schemaHeaders: Record<string, string>,
): Record<string, string> {
  const mergedHeaders = { ...suiteHeaders };
  const mergedKeysByLowercase = new Map(Object.keys(mergedHeaders).map((key) => [key.toLowerCase(), key]));

  for (const [schemaKey, schemaValue] of Object.entries(schemaHeaders)) {
    const existingKey = mergedKeysByLowercase.get(schemaKey.toLowerCase());
    if (existingKey && existingKey !== schemaKey) {
      delete mergedHeaders[existingKey];
    }
    mergedHeaders[schemaKey] = schemaValue;
    mergedKeysByLowercase.set(schemaKey.toLowerCase(), schemaKey);
  }

  return mergedHeaders;
}

function warnOnHeaderOverrides(
  suiteName: string,
  suiteHeaders: Record<string, string>,
  schemaHeaders: Record<string, string>,
): void {
  const suiteHeaderKeys = new Map(Object.keys(suiteHeaders).map((key) => [key.toLowerCase(), key]));
  for (const schemaKey of Object.keys(schemaHeaders)) {
    const suiteKey = suiteHeaderKeys.get(schemaKey.toLowerCase());
    if (suiteKey) {
      console.warn(`[${suiteName}] schema header overrides suite header: ${suiteKey}`);
    }
  }
}

function stripAuthorizationHeaders(
  suiteName: string,
  tokenEnv: string,
  headers: Record<string, string>,
): Record<string, string> {
  const sanitizedHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "authorization") {
      console.warn(`[${suiteName}] ignoring extra header "${key}" so Authorization is derived from ${tokenEnv}`);
    } else {
      sanitizedHeaders[key] = value;
    }
  }
  return sanitizedHeaders;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}
