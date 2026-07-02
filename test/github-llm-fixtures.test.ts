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
  await writeManifest(manifestPath, ["issue-close", "pull-create", "release-create-draft"]);

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

test("GitHub fixture setup seeds branch fixtures, isolates file reads, and includes verifier identifiers", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "github-llm-fixtures-review-"));
  const manifestPath = path.join(root, "manifest.json");
  const artifactRoot = path.join(root, "artifacts", "github-llm-benchmark");
  const setupPath = path.join(artifactRoot, "fixtures", "setup.json");
  await writeManifest(manifestPath, [
    "pull-create",
    "repo-file-read",
    "issue-comment",
    "issue-assign",
    "issue-label-add",
    "issue-label-remove",
    "error-pr-reviewer-invalid",
    "error-label-add-invalid",
  ]);

  const setup = await setupGitHubBenchmarkFixtures({
    manifestPath,
    outputPath: setupPath,
    artifactRoot,
    runsPerConfiguration: 1,
    dryRun: true,
    owner: "MCPAQL",
    repo: "fixture-benchmark",
    assignee: "benchmark-assignee",
    reviewer: "benchmark-reviewer",
  });

  const pullCreate = mustFindAllocation(setup.allocations, "pull-create", "raw_mcp");
  const pullBranch = String(pullCreate.variables.FIXTURE_BRANCH);
  const pullResources = setup.createdResources.filter((resource) => pullCreate.createdResourceIds.includes(resource.id));
  assert.ok(pullResources.some((resource) => resource.type === "branch" && resource.metadata.branch === pullBranch));
  assert.ok(pullResources.some((resource) => resource.type === "file" && resource.metadata.branch === pullBranch));

  const fileRead = mustFindAllocation(setup.allocations, "repo-file-read", "raw_mcp");
  assert.equal(fileRead.variables.FIXTURE_README_PATH, fileRead.variables.FIXTURE_FILE_PATH);

  for (const configId of ["raw_mcp", "mcpaql_adapted"] as const) {
    const reviewer = mustFindAllocation(setup.allocations, "error-pr-reviewer-invalid", configId);
    assert.equal(verifierParams(reviewer).pull_number, reviewer.variables.FIXTURE_PULL_NUMBER);

    const label = mustFindAllocation(setup.allocations, "error-label-add-invalid", configId);
    assert.equal(verifierParams(label).issue_number, label.variables.FIXTURE_ISSUE_NUMBER);

    const comment = mustFindAllocation(setup.allocations, "issue-comment", configId);
    assert.equal(verifierOperation(comment), "search_issues");
    assert.match(String(verifierParams(comment).q), /in:comments/);
    assert.match(String(verifierExpected(comment, "expectedTextIncludes")), /issue-comment/);

    const assign = mustFindAllocation(setup.allocations, "issue-assign", configId);
    assert.equal(verifierParams(assign).issue_number, assign.variables.FIXTURE_ISSUE_NUMBER);
    assert.equal(verifierExpected(assign, "expectedTextIncludes"), assign.variables.GITHUB_BENCHMARK_ASSIGNEE);

    const labelAdd = mustFindAllocation(setup.allocations, "issue-label-add", configId);
    assert.equal(verifierParams(labelAdd).issue_number, labelAdd.variables.FIXTURE_ISSUE_NUMBER);
    assert.equal(verifierExpected(labelAdd, "expectedTextIncludes"), "benchmark");

    const labelRemove = mustFindAllocation(setup.allocations, "issue-label-remove", configId);
    assert.equal(verifierParams(labelRemove).issue_number, labelRemove.variables.FIXTURE_ISSUE_NUMBER);
    assert.equal(verifierExpected(labelRemove, "expectedTextExcludes"), "needs-review");
  }
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
      id: "issue-comment",
      taskType: "issue_update",
      prompt: "Add a comment to issue ${FIXTURE_ISSUE_NUMBER} saying this is a benchmark comment for ${RUN_ID}.",
      expectedFirstTool: {
        rawMcp: "add_issue_comment",
        mcpaqlAdapted: "mcp_aql_create",
      },
      expectedOperation: "add_issue_comment",
      requiresFixture: ["issue"],
      mutation: true,
      inducedError: { enabled: false },
      expectedRawMethod: null,
    },
    {
      id: "issue-assign",
      taskType: "issue_update",
      prompt: "Assign issue ${FIXTURE_ISSUE_NUMBER} to ${GITHUB_BENCHMARK_ASSIGNEE}.",
      expectedFirstTool: {
        rawMcp: "update_issue_assignees",
        mcpaqlAdapted: "mcp_aql_update",
      },
      expectedOperation: "issue_write",
      requiresFixture: ["issue", "assignee"],
      mutation: true,
      inducedError: { enabled: false },
      expectedRawMethod: null,
      expectedAdaptedMethod: "update",
    },
    {
      id: "issue-label-add",
      taskType: "issue_update",
      prompt: "Add the benchmark label to issue ${FIXTURE_ISSUE_NUMBER}.",
      expectedFirstTool: {
        rawMcp: "update_issue_labels",
        mcpaqlAdapted: "mcp_aql_update",
      },
      expectedOperation: "issue_write",
      requiresFixture: ["issue", "label"],
      mutation: true,
      inducedError: { enabled: false },
      expectedRawMethod: null,
      expectedAdaptedMethod: "update",
    },
    {
      id: "issue-label-remove",
      taskType: "issue_update",
      prompt: "Remove the needs-review label from issue ${FIXTURE_ISSUE_NUMBER}.",
      expectedFirstTool: {
        rawMcp: "update_issue_labels",
        mcpaqlAdapted: "mcp_aql_update",
      },
      expectedOperation: "issue_write",
      requiresFixture: ["labeled_issue"],
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
    {
      id: "repo-file-read",
      taskType: "content_read",
      prompt: "Read ${FIXTURE_README_PATH}.",
      expectedFirstTool: {
        rawMcp: "get_file_contents",
        mcpaqlAdapted: "mcp_aql_read",
      },
      expectedOperation: "get_file_contents",
      requiresFixture: ["file"],
      mutation: false,
      inducedError: { enabled: false },
      expectedRawMethod: null,
    },
    {
      id: "error-pr-reviewer-invalid",
      taskType: "recovery_pull_request_update",
      prompt: "Request review from ${GITHUB_BENCHMARK_REVIEWER} on pull request ${FIXTURE_PULL_NUMBER}.",
      expectedFirstTool: {
        rawMcp: "update_pull_request",
        mcpaqlAdapted: "mcp_aql_update",
      },
      expectedOperation: "update_pull_request",
      requiresFixture: ["pull_request", "reviewer"],
      mutation: true,
      inducedError: {
        enabled: true,
        errorCode: "INVALID_REVIEWER",
      },
      expectedRawMethod: null,
    },
    {
      id: "error-label-add-invalid",
      taskType: "recovery_issue_update",
      prompt: "Add the benchmark label to issue ${FIXTURE_ISSUE_NUMBER}.",
      expectedFirstTool: {
        rawMcp: "update_issue_labels",
        mcpaqlAdapted: "mcp_aql_update",
      },
      expectedOperation: "issue_write",
      requiresFixture: ["issue", "label"],
      mutation: true,
      inducedError: {
        enabled: true,
        errorCode: "INVALID_LABEL",
      },
      expectedRawMethod: null,
      expectedAdaptedMethod: "update",
    },
  ].filter((task) => !taskIds || taskIds.includes(task.id));

  await writeFile(manifestPath, JSON.stringify({
    suite: "github-mcp",
    runCountPerConfiguration: 1,
    tasks,
  }, null, 2), "utf8");
}

function mustFindAllocation(
  allocations: Array<{
    taskId: string;
    configId: string;
    variables: Record<string, string | number | boolean>;
    createdResourceIds: string[];
    completionVerifier?: unknown;
  }>,
  taskId: string,
  configId: string,
): {
  taskId: string;
  configId: string;
  variables: Record<string, string | number | boolean>;
  createdResourceIds: string[];
  completionVerifier?: unknown;
} {
  const allocation = allocations.find((entry) => entry.taskId === taskId && entry.configId === configId);
  assert.ok(allocation, `missing allocation ${taskId} ${configId}`);
  return allocation;
}

function verifierParams(allocation: { completionVerifier?: unknown }): Record<string, unknown> {
  assert.ok(allocation.completionVerifier && typeof allocation.completionVerifier === "object");
  const verifier = allocation.completionVerifier as { arguments?: unknown };
  assert.ok(verifier.arguments && typeof verifier.arguments === "object");
  const args = verifier.arguments as { params?: unknown };
  if (args.params && typeof args.params === "object") return args.params as Record<string, unknown>;
  return verifier.arguments as Record<string, unknown>;
}

function verifierOperation(allocation: { completionVerifier?: unknown }): string | undefined {
  assert.ok(allocation.completionVerifier && typeof allocation.completionVerifier === "object");
  const verifier = allocation.completionVerifier as { arguments?: unknown; toolName?: unknown };
  if (!verifier.arguments || typeof verifier.arguments !== "object") return typeof verifier.toolName === "string" ? verifier.toolName : undefined;
  const args = verifier.arguments as { operation?: unknown };
  return typeof args.operation === "string" ? args.operation : typeof verifier.toolName === "string" ? verifier.toolName : undefined;
}

function verifierExpected(
  allocation: { completionVerifier?: unknown },
  key: "expectedTextIncludes" | "expectedTextExcludes",
): unknown {
  assert.ok(allocation.completionVerifier && typeof allocation.completionVerifier === "object");
  const verifier = allocation.completionVerifier as Record<string, unknown>;
  return verifier[key];
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
