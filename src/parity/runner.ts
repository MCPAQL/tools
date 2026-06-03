import { readFile, writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DEFAULT_TIMEOUT_MS, loadAdapterMetadata, resolveAdapterPaths } from "./metadata.js";
import { runOperation } from "./operation.js";
import type { OpResult, RunOptions, RunReport, Suite } from "./types.js";

export async function runParitySuite<F>(
  suite: Suite<F>,
  options: RunOptions<F>,
): Promise<RunReport> {
  const token = process.env[suite.tokenEnv];
  if (!token) throw new Error(`Token env var "${suite.tokenEnv}" not set.`);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const adapterPaths = resolveAdapterPaths(options);
  const { schema, adapterOps, paramMappings, upstreamToolNames } = await loadAdapterMetadata(adapterPaths);

  const officialExtraHeaders: Record<string, string> = {
    ...(suite.upstreamHeaders ?? {}),
    ...(schema.headers ?? {}),
  };
  warnOnHeaderOverrides(suite.name, suite.tokenEnv, suite.upstreamHeaders ?? {}, schema.headers ?? {}, officialExtraHeaders);

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

  const officialTransport = new StreamableHTTPClientTransport(new URL(suite.upstreamUrl), {
    requestInit: { headers: { Authorization: `Bearer ${token}`, ...officialExtraHeaders } },
  });
  const official = new Client({ name: "parity-official", version: "0.1.0" });

  const mcpaqlTransport = new StdioClientTransport({
    command: "node",
    args: [adapterPaths.adapterServerJs],
    cwd: adapterPaths.adapterCwd,
    env: { ...process.env, [suite.tokenEnv]: token } as Record<string, string>,
    stderr: "inherit",
  });
  const mcpaql = new Client({ name: "parity-mcpaql", version: "0.1.0" });

  const ops: OpResult[] = [];
  const totals: Record<string, number> = { TOTAL: 0 };
  const startedAt = new Date().toISOString();
  let officialConnected = false;
  let mcpaqlConnected = false;

  try {
    await official.connect(officialTransport);
    officialConnected = true;
    await mcpaql.connect(mcpaqlTransport);
    mcpaqlConnected = true;

    for (const adapterOp of adapterOps) {
      const t0 = Date.now();
      const spec = opSpecs.get(adapterOp.name);
      let result: OpResult;
      if (!spec) {
        result = { name: adapterOp.name, endpoint: adapterOp.endpoint, category: "SKIP", cls: "SKIPPED", detail: "no suite arg builder", ms: 0 };
      } else {
        try {
          result = await runOperation(spec, adapterOp.endpoint, fixtures, official, mcpaql, upstreamToolNames, paramMappings[spec.name], paramMappings, timeoutMs);
        } catch (e) {
          result = { name: spec.name, endpoint: adapterOp.endpoint, category: spec.category, cls: "HARNESS_ERROR", detail: `harness exception: ${(e as Error).message}`, ms: 0 };
        }
        if (spec.note) result.note = spec.note;
      }
      result.ms = Date.now() - t0;
      ops.push(result);
      totals[result.cls] = (totals[result.cls] ?? 0) + 1;
      totals.TOTAL++;
      console.log(`  ${pad(adapterOp.name, 44)} ${pad(result.category, 18)} -> ${result.cls}${result.detail ? " :: " + result.detail.slice(0, 80) : ""}`);
    }
  } finally {
    await Promise.allSettled([
      officialConnected ? official.close() : Promise.resolve(),
      mcpaqlConnected ? mcpaql.close() : Promise.resolve(),
    ]);
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
    upstreamUrl: suite.upstreamUrl,
    totals,
    ops,
  };
  await writeFile(options.reportPath, JSON.stringify(report, null, 2));
  console.log(`[${suite.name}] report:`, options.reportPath);
  console.log(`[${suite.name}] totals:`, totals);
  return report;
}

function warnOnHeaderOverrides(
  suiteName: string,
  tokenEnv: string,
  suiteHeaders: Record<string, string>,
  schemaHeaders: Record<string, string>,
  mergedHeaders: Record<string, string>,
): void {
  const suiteHeaderKeys = new Map(Object.keys(suiteHeaders).map((key) => [key.toLowerCase(), key]));
  for (const schemaKey of Object.keys(schemaHeaders)) {
    const suiteKey = suiteHeaderKeys.get(schemaKey.toLowerCase());
    if (suiteKey) {
      console.warn(`[${suiteName}] schema header overrides suite header: ${suiteKey}`);
    }
  }
  const authOverride = Object.keys(mergedHeaders).find((key) => key.toLowerCase() === "authorization");
  if (authOverride) {
    console.warn(`[${suiteName}] extra header "${authOverride}" overrides the Authorization header derived from ${tokenEnv}`);
  }
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}
