// CLI: mcpaql-github-llm-benchmark — capture GitHub MCP LLM benchmark metrics input.

import { resolve } from "node:path";
import { runGitHubLlmBenchmark } from "./github-llm-benchmark.js";
import type { LlmMetricConfigId } from "./parity/llm-metrics.js";

const USAGE = `Usage:
  mcpaql-github-llm-benchmark [options]

Options:
  --manifest <json>         Task manifest. Default: fixtures/github-llm-benchmark-tasks.json
  --output <json>           Metrics input JSON. Default: artifacts/github-llm-benchmark/metrics-input.json
  --artifact-root <dir>     Raw artifact root. Default: artifacts/github-llm-benchmark
  --fixtures <json>         Optional fixture allocation/setup JSON from mcpaql-github-llm-fixtures
  --runs <number>           Runs per task/configuration. Default: manifest runCountPerConfiguration
  --tasks <ids>             Comma-separated task ids to run
  --task-limit <number>     Run only the first N selected tasks
  --config <id|both>        raw_mcp, mcpaql_adapted, or both. Default: both
  --model <name>            Claude model name. Default: ANTHROPIC_MODEL
  --model-version <text>    Model version metadata. Default: ANTHROPIC_MODEL_VERSION or model
  --anthropic-version <v>   Anthropic API version. Default: ANTHROPIC_VERSION or 2023-06-01
  --temperature <number>    Model temperature. Default: 0
  --max-tokens <number>     Max output tokens per model call. Default: 1024
  --max-turns <number>      Max model turns per task run. Default: 6
  --label <text>            Label written into metrics input
  --dry-run                 Use mocked model and MCP clients; writes synthetic shape-validation data only
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

function parsePositiveIntegerArg(name: string): number | undefined {
  const value = parseNumberArg(name);
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer.`);
  return value;
}

function parseConfigIds(): LlmMetricConfigId[] | undefined {
  const value = arg("config");
  if (!value || value === "both") return undefined;
  if (value !== "raw_mcp" && value !== "mcpaql_adapted") {
    throw new Error("--config must be raw_mcp, mcpaql_adapted, or both.");
  }
  return [value];
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(USAGE);
    return;
  }

  const manifestPath = resolve(arg("manifest") ?? "fixtures/github-llm-benchmark-tasks.json");
  const outputPath = resolve(arg("output") ?? "artifacts/github-llm-benchmark/metrics-input.json");
  const artifactRoot = arg("artifact-root") ?? "artifacts/github-llm-benchmark";
  const fixtureInputPath = arg("fixtures");
  const tasks = arg("tasks");
  const dryRun = process.argv.includes("--dry-run");

  const report = await runGitHubLlmBenchmark({
    manifestPath,
    outputPath,
    artifactRoot,
    fixtureInputPath: fixtureInputPath ? resolve(fixtureInputPath) : undefined,
    dryRun,
    runsPerConfiguration: parsePositiveIntegerArg("runs"),
    taskIds: tasks ? tasks.split(",").map((task) => task.trim()).filter(Boolean) : undefined,
    taskLimit: parsePositiveIntegerArg("task-limit"),
    configIds: parseConfigIds(),
    model: arg("model"),
    modelVersion: arg("model-version"),
    anthropicVersion: arg("anthropic-version"),
    temperature: parseNumberArg("temperature"),
    maxTokens: parsePositiveIntegerArg("max-tokens"),
    maxTurns: parsePositiveIntegerArg("max-turns"),
    label: arg("label"),
  });

  console.log("[github-llm-benchmark] metrics input:", outputPath);
  console.log("[github-llm-benchmark] task results:", report.taskResults.length);
  if (dryRun) {
    console.log("[github-llm-benchmark] dry run: synthetic shape-validation data only; not benchmark evidence");
  }
}

main().catch((error) => {
  console.error("FATAL:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
