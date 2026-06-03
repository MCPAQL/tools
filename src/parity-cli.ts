// CLI: mcpaql-parity — run a parity suite against an MCPAQL adapter.
//
// Usage:
//   mcpaql-parity --suite ./path/to/suite.js --adapter ./path/to/adapter/dist/server.js \
//                 --report parity.json [--label X] [--timeout-ms 30000] [--no-teardown] \
//                 [--reuse-fixtures ./fixtures.json]

import {
  buildLlmMetricsReport,
  loadLlmMetricsInput,
  runParitySuite,
  writeLlmMetricsMarkdownSummary,
  writeLlmMetricsReport,
  type Suite,
} from "./parity-runner.js";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const USAGE = `Usage:
  mcpaql-parity --suite <module> --adapter <server.js> [options]

Options:
  --report <path>           Write report JSON here. Default: parity-report.json
  --label <text>            Label written into the report
  --schema <path>           Override adapter schema.json path
  --provenance <path>       Override adapter provenance.json path
  --adapter-cwd <path>      Override adapter process working directory
  --timeout-ms <number>     Per-operation timeout. Default: 30000. Use 0 to disable
  --reuse-fixtures <json>   Reuse fixture JSON instead of running setupFixtures()
  --llm-metrics-input <json>
                            Normalize captured LLM task metrics from this JSON file
  --llm-metrics-report <path>
                            Write normalized LLM metrics JSON here
  --llm-summary <path>      Write markdown summary for the LLM metrics report
  --no-teardown             Leave newly-created fixtures in place for debugging
  --help                    Show this help
`;

function arg(name: string): string | undefined {
  const p = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (p) return p.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return undefined;
}

function parseNumberArg(name: string): number | undefined {
  const value = arg(name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`--${name} must be a finite number.`);
  return parsed;
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(USAGE);
    return;
  }

  const suitePath = arg("suite");
  const adapter = arg("adapter");
  const report = arg("report") ?? "parity-report.json";
  const label = arg("label");
  const schemaPath = arg("schema");
  const provenancePath = arg("provenance");
  const adapterCwd = arg("adapter-cwd");
  const timeoutMs = parseNumberArg("timeout-ms");
  const reuseFixtures = arg("reuse-fixtures");
  const llmMetricsInputPath = arg("llm-metrics-input");
  const llmMetricsReportPath = arg("llm-metrics-report");
  const llmSummaryPath = arg("llm-summary");
  const skipTeardown = process.argv.includes("--no-teardown");

  if ((llmMetricsReportPath || llmSummaryPath) && !llmMetricsInputPath) {
    console.error("--llm-metrics-report and --llm-summary require --llm-metrics-input.");
    process.exitCode = 2;
    return;
  }

  if ((!suitePath || !adapter) && !llmMetricsInputPath) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }

  if (llmMetricsInputPath && !suitePath && !adapter) {
    await writeLlmMetricsArtifacts({
      inputPath: resolve(llmMetricsInputPath),
      reportPath: llmMetricsReportPath ? resolve(llmMetricsReportPath) : undefined,
      summaryPath: llmSummaryPath ? resolve(llmSummaryPath) : undefined,
    });
    return;
  }

  if (!suitePath || !adapter) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }

  const suiteModule = await import(pathToFileURL(resolve(suitePath)).href) as { suite?: Suite<unknown>; default?: Suite<unknown> };
  const suite = suiteModule.suite ?? suiteModule.default;
  if (!suite) {
    console.error(`Suite module ${suitePath} must export 'suite' or default.`);
    process.exitCode = 2;
    return;
  }

  await runParitySuite(suite, {
    adapterServerJs: resolve(adapter),
    schemaPath: schemaPath ? resolve(schemaPath) : undefined,
    provenancePath: provenancePath ? resolve(provenancePath) : undefined,
    adapterCwd: adapterCwd ? resolve(adapterCwd) : undefined,
    reportPath: resolve(report),
    label,
    timeoutMs,
    skipTeardown,
    reuseFixtures,
  });

  if (llmMetricsInputPath) {
    await writeLlmMetricsArtifacts({
      inputPath: resolve(llmMetricsInputPath),
      reportPath: llmMetricsReportPath ? resolve(llmMetricsReportPath) : undefined,
      summaryPath: llmSummaryPath ? resolve(llmSummaryPath) : undefined,
      parityReportPath: resolve(report),
    });
  }
}

async function writeLlmMetricsArtifacts(options: {
  inputPath: string;
  reportPath?: string;
  summaryPath?: string;
  parityReportPath?: string;
}): Promise<void> {
  const input = await loadLlmMetricsInput(options.inputPath);
  const reportInput = {
    ...input,
    parityReportPath: options.parityReportPath ?? input.parityReportPath,
  };
  const report = options.reportPath
    ? await writeLlmMetricsReport(options.reportPath, reportInput)
    : buildLlmMetricsReport(reportInput);

  if (options.summaryPath) {
    await writeLlmMetricsMarkdownSummary(options.summaryPath, report);
  }

  console.log("[llm-metrics] input:", options.inputPath);
  if (options.reportPath) console.log("[llm-metrics] report:", options.reportPath);
  if (options.summaryPath) console.log("[llm-metrics] summary:", options.summaryPath);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
