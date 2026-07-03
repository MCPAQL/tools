// CLI: mcpaql-github-llm-fixtures - setup/teardown disposable GitHub benchmark fixtures.

import { resolve } from "node:path";
import {
  setupGitHubBenchmarkFixtures,
  teardownGitHubBenchmarkFixtures,
} from "./github-llm-fixtures.js";
import type { LlmMetricConfigId } from "./parity/llm-metrics.js";

const USAGE = `Usage:
  mcpaql-github-llm-fixtures setup [options]
  mcpaql-github-llm-fixtures teardown [options]

Setup options:
  --manifest <json>         Task manifest. Default: fixtures/github-llm-benchmark-tasks.json
  --output <json>           Setup JSON. Default: artifacts/github-llm-benchmark/fixtures/setup.json
  --artifact-root <dir>     Artifact root. Default: artifacts/github-llm-benchmark
  --runs <number>           Runs per task/configuration. Default: manifest runCountPerConfiguration
  --config <id|both>        raw_mcp, mcpaql_adapted, or both. Default: both
  --owner <name>            Benchmark repository owner. Default: GITHUB_BENCHMARK_OWNER
  --repo <name>             Benchmark repository name. Default: GITHUB_BENCHMARK_REPO
  --assignee <login>        Issue assignee fixture login. Default: GITHUB_BENCHMARK_ASSIGNEE
  --reviewer <login>        Pull request reviewer fixture login. Default: GITHUB_BENCHMARK_REVIEWER
  --base-branch <name>      Override repository default branch
  --continue-on-error       Write failed allocation records instead of stopping at first setup error

Teardown options:
  --setup <json>            Setup JSON. Default: artifacts/github-llm-benchmark/fixtures/setup.json
  --output <json>           Teardown JSON. Default: artifacts/github-llm-benchmark/fixtures/teardown.json
  --continue-on-error       Continue teardown after individual resource cleanup errors

Shared options:
  --dry-run                 Use synthetic fixture identifiers; no GitHub API calls
  --help                    Show this help
`;

function arg(name: string): string | undefined {
  const p = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (p) return p.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return undefined;
}

function parsePositiveIntegerArg(name: string): number | undefined {
  const value = arg(name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`--${name} must be a positive integer.`);
  return parsed;
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
  const command = process.argv[2];
  const dryRunRequested = process.argv.includes("--dry-run");
  const continueOnError = process.argv.includes("--continue-on-error");

  if (command === "setup") {
    const outputPath = resolve(arg("output") ?? "artifacts/github-llm-benchmark/fixtures/setup.json");
    const setup = await setupGitHubBenchmarkFixtures({
      manifestPath: resolve(arg("manifest") ?? "fixtures/github-llm-benchmark-tasks.json"),
      outputPath,
      artifactRoot: arg("artifact-root") ?? "artifacts/github-llm-benchmark",
      runsPerConfiguration: parsePositiveIntegerArg("runs"),
      configIds: parseConfigIds(),
      dryRun: dryRunRequested,
      owner: arg("owner"),
      repo: arg("repo"),
      assignee: arg("assignee"),
      reviewer: arg("reviewer"),
      baseBranch: arg("base-branch"),
      continueOnError,
    });
    console.log("[github-llm-fixtures] setup:", outputPath);
    console.log("[github-llm-fixtures] allocations:", setup.allocations.length);
    console.log("[github-llm-fixtures] created resources:", setup.createdResources.length);
    if (dryRunRequested) console.log("[github-llm-fixtures] dry run: synthetic fixture data only; not benchmark evidence");
    if (setup.errors.length > 0) {
      console.log("[github-llm-fixtures] setup errors:", setup.errors.length);
      process.exitCode = 1;
    }
    return;
  }

  if (command === "teardown") {
    const outputPath = resolve(arg("output") ?? "artifacts/github-llm-benchmark/fixtures/teardown.json");
    const teardown = await teardownGitHubBenchmarkFixtures({
      setupPath: resolve(arg("setup") ?? "artifacts/github-llm-benchmark/fixtures/setup.json"),
      outputPath,
      dryRun: dryRunRequested ? true : undefined,
      continueOnError,
    });
    console.log("[github-llm-fixtures] teardown:", outputPath);
    console.log("[github-llm-fixtures] resources:", teardown.results.length);
    if (teardown.mode === "dry-run") console.log("[github-llm-fixtures] dry run: no GitHub resources were changed");
    if (teardown.errors.length > 0) {
      console.log("[github-llm-fixtures] teardown errors:", teardown.errors.length);
      process.exitCode = 1;
    }
    return;
  }

  throw new Error("Expected command setup or teardown. Use --help for usage.");
}

main().catch((error) => {
  console.error("FATAL:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
