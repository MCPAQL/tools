import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  setupGitHubBenchmarkFixtures,
  teardownGitHubBenchmarkFixtures,
  type GitHubFixtureClient,
} from "../src/github-llm-fixtures.js";
import { runGitHubLlmBenchmark } from "../src/github-llm-benchmark.js";

test("GitHub fixture setup emits exact per-task config run allocations consumed by the runner", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "github-llm-fixtures-"));
  const manifestPath = path.join(root, "manifest.json");
  const artifactRoot = path.join(root, "artifacts", "github-llm-benchmark");
  const setupPath = path.join(artifactRoot, "fixtures", "setup.json");
  const teardownPath = path.join(artifactRoot, "fixtures", "teardown.json");
  const metricsPath = path.join(artifactRoot, "metrics-input.json");
  await writeManifest(manifestPath);

  const setup = await setupGitHubBenchmarkFixtures({
    manifestPath,
    outputPath: setupPath,
    artifactRoot,
    runsPerConfiguration: 2,
    dryRun: true,
    owner: "MCPAQL",
    repo: "fixture-benchmark",
    assignee: "benchmark-assignee",
    reviewer: "benchmark-reviewer",
  });

  assert.equal(setup.allocations.length, 12);
  assert.equal(setup.allocations.every((allocation) => allocation.status === "ready"), true);
  assert.equal(setup.allocations.every((allocation) => allocation.taskId && allocation.configId && allocation.runIndex !== undefined), true);
  assert.equal(setup.allocations.every((allocation) => allocation.completionVerifier), true);
  assert.equal(setup.allocations.every((allocation) => allocation.rawDataPaths.fixtures.includes(setupPath)), true);

  const issueNumbers = setup.allocations
    .filter((allocation) => allocation.taskId === "issue-close")
    .map((allocation) => allocation.variables.FIXTURE_ISSUE_NUMBER);
  assert.equal(new Set(issueNumbers).size, 4);

  const pullBranches = setup.allocations
    .filter((allocation) => allocation.taskId === "pull-create")
    .map((allocation) => allocation.variables.FIXTURE_BRANCH);
  assert.equal(new Set(pullBranches).size, 4);
  await stat(setupPath);

  const input = await runGitHubLlmBenchmark({
    manifestPath,
    outputPath: metricsPath,
    artifactRoot,
    fixtureInputPath: setupPath,
    dryRun: true,
    runsPerConfiguration: 2,
    model: "mock-claude",
  });
  assert.equal(input.taskResults.length, 12);
  assert.equal(input.taskResults.every((result) => result.outcome === "completed"), true);

  const teardown = await teardownGitHubBenchmarkFixtures({
    setupPath,
    outputPath: teardownPath,
    dryRun: true,
  });
  assert.equal(teardown.errors.length, 0);
  assert.equal(teardown.results.length, setup.createdResources.length);
  await stat(teardownPath);
});

test("GitHub benchmark marks failed fixture allocations as task errors", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "github-llm-fixtures-error-"));
  const manifestPath = path.join(root, "manifest.json");
  const artifactRoot = path.join(root, "artifacts", "github-llm-benchmark");
  const setupPath = path.join(artifactRoot, "fixtures", "setup.json");
  const metricsPath = path.join(artifactRoot, "metrics-input.json");
  await writeManifest(manifestPath, ["issue-close"]);

  const setup = await setupGitHubBenchmarkFixtures({
    manifestPath,
    outputPath: setupPath,
    artifactRoot,
    runsPerConfiguration: 1,
    configIds: ["raw_mcp"],
    dryRun: true,
    owner: "MCPAQL",
    repo: "fixture-benchmark",
    assignee: "benchmark-assignee",
    reviewer: "benchmark-reviewer",
    continueOnError: true,
    client: new FailingIssueClient(),
  });
  assert.equal(setup.allocations.length, 1);
  assert.equal(setup.allocations[0].status, "error");

  const input = await runGitHubLlmBenchmark({
    manifestPath,
    outputPath: metricsPath,
    artifactRoot,
    fixtureInputPath: setupPath,
    dryRun: true,
    runsPerConfiguration: 1,
    configIds: ["raw_mcp"],
    model: "mock-claude",
  });
  assert.equal(input.taskResults.length, 1);
  assert.equal(input.taskResults[0].outcome, "error");
  assert.match(input.taskResults[0].notes ?? "", /Fixture setup failed/);

  const writtenSetup = JSON.parse(await readFile(setupPath, "utf8")) as { errors: unknown[] };
  assert.equal(writtenSetup.errors.length, 1);
});

async function writeManifest(manifestPath: string, taskIds?: string[]): Promise<void> {
  const tasks = [
    {
      id: "issue-close",
      taskType: "issue_update",
      prompt: "Close issue ${FIXTURE_ISSUE_NUMBER} as completed.",
      expectedFirstTool: {
        rawMcp: "update_issue_state",
        mcpaqlAdapted: "mcp_aql_update",
      },
      expectedOperation: "issue_write",
      requiresFixture: ["open_issue"],
      mutation: true,
      inducedError: { enabled: false },
      expectedRawMethod: null,
      expectedAdaptedMethod: "update",
    },
    {
      id: "pull-create",
      taskType: "pull_request_create",
      prompt: "Open a pull request from ${FIXTURE_BRANCH} into ${FIXTURE_BASE_BRANCH} titled 'Benchmark PR ${RUN_ID}'.",
      expectedFirstTool: {
        rawMcp: "create_pull_request",
        mcpaqlAdapted: "mcp_aql_create",
      },
      expectedOperation: "create_pull_request",
      requiresFixture: ["branch"],
      mutation: true,
      inducedError: { enabled: false },
      expectedRawMethod: null,
    },
    {
      id: "release-create-draft",
      taskType: "release_read",
      prompt: "Get the release for tag ${FIXTURE_TAG}.",
      expectedFirstTool: {
        rawMcp: "get_release_by_tag",
        mcpaqlAdapted: "mcp_aql_read",
      },
      expectedOperation: "get_release_by_tag",
      requiresFixture: ["release"],
      mutation: false,
      inducedError: { enabled: false },
      expectedRawMethod: null,
    },
  ].filter((task) => !taskIds || taskIds.includes(task.id));

  await writeFile(manifestPath, JSON.stringify({
    suite: "github-mcp",
    runCountPerConfiguration: 1,
    tasks,
  }, null, 2), "utf8");
}

class FailingIssueClient implements GitHubFixtureClient {
  async getRepository(): Promise<{ defaultBranch: string }> {
    return { defaultBranch: "main" };
  }

  async getBranchHead(): Promise<{ sha: string }> {
    return { sha: "base-sha" };
  }

  async ensureLabel(): Promise<void> {}

  async createIssue(): Promise<{ number: number }> {
    throw new Error("fixture issue provisioning failed");
  }

  async updateIssue(): Promise<void> {}

  async createBranch(): Promise<void> {}

  async deleteBranch(): Promise<void> {}

  async createOrUpdateFile(input: { filePath: string }): Promise<{ path: string; sha: string }> {
    return { path: input.filePath, sha: "sha" };
  }

  async deleteFile(): Promise<void> {}

  async getFile(): Promise<{ sha: string } | undefined> {
    return { sha: "sha" };
  }

  async createPullRequest(): Promise<{ number: number }> {
    return { number: 1 };
  }

  async closePullRequest(): Promise<void> {}

  async findPullRequest(): Promise<{ number: number } | undefined> {
    return undefined;
  }

  async createPendingReview(): Promise<{ id: number }> {
    return { id: 1 };
  }

  async createRelease(input: { tag: string }): Promise<{ id: number; tagName: string }> {
    return { id: 1, tagName: input.tag };
  }

  async deleteRelease(): Promise<void> {}

  async deleteTag(): Promise<void> {}

  async findIssue(): Promise<{ number: number } | undefined> {
    return undefined;
  }
}
