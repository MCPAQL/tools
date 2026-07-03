import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { deepRedact, writeJsonFile } from "./shared.js";
import type { LlmMetricConfigId } from "./parity/llm-metrics.js";

export const RAW_CONFIG_ID = "raw_mcp" satisfies LlmMetricConfigId;
export const ADAPTED_CONFIG_ID = "mcpaql_adapted" satisfies LlmMetricConfigId;
export const GITHUB_FIXTURE_SCHEMA_VERSION = "mcpaql.github-llm-benchmark-fixtures.v1";

const CONFIG_IDS = [RAW_CONFIG_ID, ADAPTED_CONFIG_ID] as const;
const DEFAULT_ARTIFACT_ROOT = "artifacts/github-llm-benchmark";
const DEFAULT_SETUP_PATH = path.join(DEFAULT_ARTIFACT_ROOT, "fixtures", "setup.json");
const DEFAULT_TEARDOWN_PATH = path.join(DEFAULT_ARTIFACT_ROOT, "fixtures", "teardown.json");

export interface GitHubFixtureSetupOptions {
  manifestPath: string;
  outputPath?: string;
  artifactRoot?: string;
  runsPerConfiguration?: number;
  configIds?: LlmMetricConfigId[];
  dryRun?: boolean;
  owner?: string;
  repo?: string;
  assignee?: string;
  reviewer?: string;
  baseBranch?: string;
  token?: string;
  continueOnError?: boolean;
  startedAt?: string;
  client?: GitHubFixtureClient;
}

export interface GitHubFixtureTeardownOptions {
  setupPath?: string;
  outputPath?: string;
  dryRun?: boolean;
  token?: string;
  continueOnError?: boolean;
  startedAt?: string;
  client?: GitHubFixtureClient;
}

interface GitHubBenchmarkManifest {
  suite: string;
  runCountPerConfiguration?: number;
  tasks: GitHubBenchmarkTask[];
}

interface GitHubBenchmarkTask {
  id: string;
  taskType?: string;
  prompt: string;
  expectedFirstTool: {
    rawMcp: string;
    mcpaqlAdapted: string;
  };
  expectedOperation: string;
  expectedRawMethod?: string | null;
  expectedAdaptedMethod?: string | null;
  requiresFixture?: string[];
  mutation?: boolean;
  inducedError?: {
    enabled?: boolean;
    errorCode?: string;
    policy?: string;
  };
}

export interface GitHubBenchmarkFixtureSetup {
  schemaVersion: typeof GITHUB_FIXTURE_SCHEMA_VERSION;
  suite: string;
  generatedAt: string;
  owner: string;
  repo: string;
  mode: "dry-run" | "live";
  manifestPath: string;
  artifactRoot: string;
  runCountPerConfiguration: number;
  configurations: LlmMetricConfigId[];
  variables: Record<string, string | number | boolean>;
  allocations: FixtureAllocation[];
  createdResources: FixtureResource[];
  errors: FixtureSetupError[];
  notes: string;
}

export interface FixtureAllocation {
  taskId: string;
  configId: LlmMetricConfigId;
  runIndex: number;
  status: "ready" | "error";
  variables: Record<string, string | number | boolean>;
  completionVerifier?: FixtureCompletionVerifier | Partial<Record<LlmMetricConfigId, FixtureCompletionVerifier>>;
  rawDataPaths: {
    fixtures: string[];
  };
  createdResourceIds: string[];
  error?: string;
}

interface FixtureCompletionVerifier {
  toolName: string;
  arguments?: Record<string, unknown>;
  expectError?: boolean;
  retry?: {
    attempts: number;
    delayMs: number;
  };
  expectedTextIncludes?: string;
  expectedTextExcludes?: string;
  expectedJsonMatches?: Array<{
    path: string;
    value: unknown;
  }>;
}

const SEARCH_COMPLETION_RETRY = {
  attempts: 6,
  delayMs: 5_000,
};

export interface FixtureResource {
  id: string;
  type:
    | "issue"
    | "pull_request"
    | "branch"
    | "file"
    | "pull_request_review_comment"
    | "release"
    | "tag"
    | "pending_review"
    | "expected_issue"
    | "expected_pull_request"
    | "expected_branch"
    | "expected_file";
  owner: string;
  repo: string;
  taskId?: string;
  configId?: LlmMetricConfigId;
  runIndex?: number;
  createdAt: string;
  teardown?: "close" | "delete" | "archive" | "none";
  metadata: Record<string, string | number | boolean>;
}

export interface FixtureSetupError {
  taskId: string;
  configId: LlmMetricConfigId;
  runIndex: number;
  message: string;
}

export interface GitHubBenchmarkFixtureTeardown {
  schemaVersion: typeof GITHUB_FIXTURE_SCHEMA_VERSION;
  generatedAt: string;
  setupPath: string;
  owner: string;
  repo: string;
  mode: "dry-run" | "live";
  results: FixtureTeardownResult[];
  errors: Array<{ resourceId: string; message: string }>;
  notes: string;
}

export interface FixtureTeardownResult {
  resourceId: string;
  type: FixtureResource["type"];
  action: string;
  status: "ok" | "skipped" | "error";
  message?: string;
}

export interface GitHubFixtureClient {
  getRepository(owner: string, repo: string): Promise<{ defaultBranch: string }>;
  getBranchHead(owner: string, repo: string, branch: string): Promise<{ sha: string }>;
  ensureLabel(owner: string, repo: string, name: string, color: string, description: string): Promise<void>;
  createIssue(input: CreateIssueInput): Promise<{ number: number; url?: string }>;
  updateIssue(input: UpdateIssueInput): Promise<void>;
  createBranch(input: CreateBranchInput): Promise<void>;
  deleteBranch(owner: string, repo: string, branch: string): Promise<void>;
  createOrUpdateFile(input: CreateFileInput): Promise<{ path: string; sha: string }>;
  deleteFile(input: DeleteFileInput): Promise<void>;
  getFile(owner: string, repo: string, filePath: string, ref?: string): Promise<{ sha: string } | undefined>;
  createPullRequest(input: CreatePullRequestInput): Promise<{ number: number; url?: string }>;
  closePullRequest(owner: string, repo: string, pullNumber: number): Promise<void>;
  findPullRequest(owner: string, repo: string, query: { head?: string; title?: string }): Promise<{ number: number } | undefined>;
  createPullRequestReviewComment(input: CreatePullRequestReviewCommentInput): Promise<{ id: number }>;
  deletePullRequestReviewComment(owner: string, repo: string, commentId: number): Promise<void>;
  createPendingReview(input: CreatePendingReviewInput): Promise<{ id: number }>;
  getPullRequestReview(owner: string, repo: string, pullNumber: number, reviewId: number): Promise<{ state: string } | undefined>;
  deletePendingReview(owner: string, repo: string, pullNumber: number, reviewId: number): Promise<void>;
  createRelease(input: CreateReleaseInput): Promise<{ id: number; tagName: string }>;
  deleteRelease(owner: string, repo: string, releaseId: number): Promise<void>;
  deleteTag(owner: string, repo: string, tag: string): Promise<void>;
  findIssue(owner: string, repo: string, query: { title: string }): Promise<{ number: number } | undefined>;
}

interface CreateIssueInput {
  owner: string;
  repo: string;
  title: string;
  body?: string;
  labels?: string[];
  assignees?: string[];
}

interface UpdateIssueInput {
  owner: string;
  repo: string;
  number: number;
  title?: string;
  state?: "open" | "closed";
  labels?: string[];
  assignees?: string[];
}

interface CreateBranchInput {
  owner: string;
  repo: string;
  branch: string;
  sha: string;
}

interface CreateFileInput {
  owner: string;
  repo: string;
  filePath: string;
  branch: string;
  content: string;
  message: string;
}

interface DeleteFileInput {
  owner: string;
  repo: string;
  filePath: string;
  branch: string;
  message: string;
}

interface CreatePullRequestInput {
  owner: string;
  repo: string;
  title: string;
  head: string;
  base: string;
  body?: string;
}

interface CreatePullRequestReviewCommentInput {
  owner: string;
  repo: string;
  pullNumber: number;
  body: string;
  commitId: string;
  path: string;
  line: number;
  side: "RIGHT";
}

interface CreatePendingReviewInput {
  owner: string;
  repo: string;
  pullNumber: number;
  body?: string;
}

interface CreateReleaseInput {
  owner: string;
  repo: string;
  tag: string;
  name: string;
  body?: string;
  draft?: boolean;
}

interface AllocationBuilderContext {
  manifest: GitHubBenchmarkManifest;
  task: GitHubBenchmarkTask;
  configId: LlmMetricConfigId;
  runIndex: number;
  runId: string;
  owner: string;
  repo: string;
  assignee: string;
  reviewer: string;
  baseBranch: string;
  baseSha: string;
  outputPath: string;
  dryRun: boolean;
  client: GitHubFixtureClient;
  createdAt: string;
  scratchResources: FixtureResource[];
}

export async function setupGitHubBenchmarkFixtures(options: GitHubFixtureSetupOptions): Promise<GitHubBenchmarkFixtureSetup> {
  const manifest = await loadManifest(options.manifestPath);
  const outputPath = options.outputPath ?? DEFAULT_SETUP_PATH;
  const artifactRoot = options.artifactRoot ?? DEFAULT_ARTIFACT_ROOT;
  const dryRun = options.dryRun === true;
  const owner = options.owner ?? process.env.GITHUB_BENCHMARK_OWNER ?? (dryRun ? "DRY_RUN_OWNER" : "");
  const repo = options.repo ?? process.env.GITHUB_BENCHMARK_REPO ?? (dryRun ? "DRY_RUN_REPO" : "");
  const assignee = options.assignee ?? process.env.GITHUB_BENCHMARK_ASSIGNEE ?? (dryRun ? "dry-run-assignee" : "");
  const reviewer = options.reviewer ?? process.env.GITHUB_BENCHMARK_REVIEWER ?? (dryRun ? "dry-run-reviewer" : "");
  if (!owner || !repo || !assignee || !reviewer) {
    throw new Error("Fixture setup requires owner, repo, assignee, and reviewer via options or GITHUB_BENCHMARK_* environment variables.");
  }
  const client = options.client ?? (dryRun ? new DryRunGitHubFixtureClient() : new RestGitHubFixtureClient(options.token ?? requireEnv("GITHUB_PERSONAL_ACCESS_TOKEN")));
  const repository = await client.getRepository(owner, repo);
  const baseBranch = options.baseBranch ?? repository.defaultBranch;
  const baseHead = await client.getBranchHead(owner, repo, baseBranch);
  const runsPerConfiguration = options.runsPerConfiguration ?? manifest.runCountPerConfiguration ?? 1;
  const configIds = options.configIds ?? [...CONFIG_IDS];
  const generatedAt = options.startedAt ?? new Date().toISOString();
  const allocations: FixtureAllocation[] = [];
  const createdResources: FixtureResource[] = [];
  const errors: FixtureSetupError[] = [];

  await ensureFixtureDirectory(outputPath);
  await ensureBaselineLabels(client, owner, repo);

  for (const configId of configIds) {
    for (const task of manifest.tasks) {
      for (let runIndex = 0; runIndex < runsPerConfiguration; runIndex += 1) {
        const runId = `${task.id}-${configId}-${runIndex}`;
        const scratchResources: FixtureResource[] = [];
        const context: AllocationBuilderContext = {
          manifest,
          task,
          configId,
          runIndex,
          runId,
          owner,
          repo,
          assignee,
          reviewer,
          baseBranch,
          baseSha: baseHead.sha,
          outputPath,
          dryRun,
          client,
          createdAt: new Date().toISOString(),
          scratchResources,
        };
        try {
          const allocation = await buildAllocation(context);
          allocations.push(allocation);
          createdResources.push(...scratchResources);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          errors.push({ taskId: task.id, configId, runIndex, message });
          createdResources.push(...scratchResources);
          allocations.push({
            taskId: task.id,
            configId,
            runIndex,
            status: "error",
            variables: baseVariables(context),
            rawDataPaths: { fixtures: [outputPath] },
            createdResourceIds: scratchResources.map((resource) => resource.id),
            error: message,
          });
          if (!options.continueOnError) {
            const setup = buildSetupDocument({
              manifest,
              generatedAt,
              owner,
              repo,
              mode: dryRun ? "dry-run" : "live",
              manifestPath: options.manifestPath,
              artifactRoot,
              runsPerConfiguration,
              configIds,
              allocations,
              createdResources,
              errors,
              outputPath,
            });
            await writeJsonFile(outputPath, deepRedact(setup));
            throw new Error(`Fixture setup failed for ${task.id} ${configId} run ${runIndex}: ${message}`);
          }
        }
      }
    }
  }

  const setup = buildSetupDocument({
    manifest,
    generatedAt,
    owner,
    repo,
    mode: dryRun ? "dry-run" : "live",
    manifestPath: options.manifestPath,
    artifactRoot,
    runsPerConfiguration,
    configIds,
    allocations,
    createdResources,
    errors,
    outputPath,
  });
  await writeJsonFile(outputPath, deepRedact(setup));
  if (errors.length > 0 && !options.continueOnError) {
    throw new Error(`Fixture setup failed with ${errors.length} error(s).`);
  }
  return setup;
}

function buildSetupDocument(input: {
  manifest: GitHubBenchmarkManifest;
  generatedAt: string;
  owner: string;
  repo: string;
  mode: "dry-run" | "live";
  manifestPath: string;
  artifactRoot: string;
  runsPerConfiguration: number;
  configIds: LlmMetricConfigId[];
  allocations: FixtureAllocation[];
  createdResources: FixtureResource[];
  errors: FixtureSetupError[];
  outputPath: string;
}): GitHubBenchmarkFixtureSetup {
  return {
    schemaVersion: GITHUB_FIXTURE_SCHEMA_VERSION,
    suite: input.manifest.suite,
    generatedAt: input.generatedAt,
    owner: input.owner,
    repo: input.repo,
    mode: input.mode,
    manifestPath: input.manifestPath,
    artifactRoot: input.artifactRoot,
    runCountPerConfiguration: input.runsPerConfiguration,
    configurations: input.configIds,
    variables: {
      GITHUB_BENCHMARK_OWNER: input.owner,
      GITHUB_BENCHMARK_REPO: input.repo,
    },
    allocations: input.allocations,
    createdResources: input.createdResources,
    errors: input.errors,
    notes: input.mode === "dry-run"
      ? "Dry-run fixture allocation only. Resource identifiers are synthetic and are not benchmark evidence."
      : `Fixture allocation for live GitHub LLM benchmark runs. Consume with --fixtures ${input.outputPath}; run teardown after report generation.`,
  };
}

async function buildAllocation(context: AllocationBuilderContext): Promise<FixtureAllocation> {
  const variables = baseVariables(context);
  const createdResourceIds: string[] = [];
  const required = new Set(context.task.requiresFixture ?? []);

  if (required.has("labels") || required.has("label")) {
    variables.FIXTURE_LABEL = "benchmark";
  }
  if (required.has("assigned_issue")) {
    const issue = await createIssueFixture(context, "assigned", { assignees: [context.assignee] });
    variables.FIXTURE_ISSUE_NUMBER = issue.number;
    createdResourceIds.push(issue.resourceId);
  }
  if (required.has("labeled_issue")) {
    const issue = await createIssueFixture(context, "labeled", { labels: ["benchmark", "needs-review"] });
    variables.FIXTURE_ISSUE_NUMBER = issue.number;
    createdResourceIds.push(issue.resourceId);
  }
  if (required.has("open_issue")) {
    const issue = await createIssueFixture(context, "open", {});
    variables.FIXTURE_ISSUE_NUMBER = issue.number;
    createdResourceIds.push(issue.resourceId);
  }
  if (required.has("closed_issue")) {
    const issue = await createIssueFixture(context, "closed", {});
    await context.client.updateIssue({ owner: context.owner, repo: context.repo, number: issue.number, state: "closed" });
    variables.FIXTURE_CLOSED_ISSUE_NUMBER = issue.number;
    variables.FIXTURE_ISSUE_NUMBER = issue.number;
    createdResourceIds.push(issue.resourceId);
  }
  if (required.has("issue") && variables.FIXTURE_ISSUE_NUMBER === undefined) {
    const issue = await createIssueFixture(context, "issue", {});
    variables.FIXTURE_ISSUE_NUMBER = issue.number;
    createdResourceIds.push(issue.resourceId);
  }
  if (required.has("file")) {
    const file = await createFileFixture(context, "file");
    variables.FIXTURE_FILE_PATH = file.filePath;
    if (context.task.id === "repo-file-read") {
      variables.FIXTURE_README_PATH = file.filePath;
    }
    createdResourceIds.push(file.resourceId);
  }
  if (required.has("deletable_file")) {
    const file = await createFileFixture(context, "delete");
    variables.FIXTURE_DELETE_FILE_PATH = file.filePath;
    createdResourceIds.push(file.resourceId);
  }
  if (required.has("branch")) {
    const branch = await createSeededBranchFixture(context, "source");
    variables.FIXTURE_BRANCH = branch.branch;
    variables.FIXTURE_CHANGED_FILE = branch.changedFile;
    createdResourceIds.push(...branch.resourceIds);
  }
  if (context.task.id === "error-branch-create-existing") {
    const branch = await createExistingBranchFixture(context);
    createdResourceIds.push(branch.resourceId);
  }
  if (required.has("pull_request") || required.has("pull_request_review_comment")) {
    const pull = await createPullRequestFixture(context, "pull-request");
    variables.FIXTURE_PULL_NUMBER = pull.pullNumber;
    variables.FIXTURE_BRANCH = pull.branch;
    variables.FIXTURE_CHANGED_FILE = pull.changedFile;
    if (pull.baseUpdateFile) variables.FIXTURE_BASE_UPDATE_FILE = pull.baseUpdateFile;
    createdResourceIds.push(...pull.resourceIds);
    if (required.has("pull_request_review_comment")) {
      const reviewComment = await createPullRequestReviewCommentFixture(context, pull.pullNumber, pull.branch, pull.changedFile);
      createdResourceIds.push(reviewComment.resourceId);
    }
  }
  if (required.has("mergeable_pull_request")) {
    const pull = await createPullRequestFixture(context, "mergeable");
    variables.FIXTURE_MERGEABLE_PULL_NUMBER = pull.pullNumber;
    variables.FIXTURE_PULL_NUMBER = pull.pullNumber;
    variables.FIXTURE_BRANCH = pull.branch;
    variables.FIXTURE_CHANGED_FILE = pull.changedFile;
    if (pull.baseUpdateFile) variables.FIXTURE_BASE_UPDATE_FILE = pull.baseUpdateFile;
    createdResourceIds.push(...pull.resourceIds);
  }
  if (required.has("pending_review")) {
    const pull = variables.FIXTURE_PULL_NUMBER === undefined
      ? await createPullRequestFixture(context, "pending-review")
      : undefined;
    if (pull) {
      variables.FIXTURE_PULL_NUMBER = pull.pullNumber;
      variables.FIXTURE_BRANCH = pull.branch;
      variables.FIXTURE_CHANGED_FILE = pull.changedFile;
      if (pull.baseUpdateFile) variables.FIXTURE_BASE_UPDATE_FILE = pull.baseUpdateFile;
      createdResourceIds.push(...pull.resourceIds);
    }
    const review = await createPendingReviewFixture(context, Number(variables.FIXTURE_PULL_NUMBER));
    createdResourceIds.push(review.resourceId);
  }
  if (required.has("changed_file") && variables.FIXTURE_CHANGED_FILE === undefined) {
    const pull = await createPullRequestFixture(context, "changed-file");
    variables.FIXTURE_PULL_NUMBER = pull.pullNumber;
    variables.FIXTURE_BRANCH = pull.branch;
    variables.FIXTURE_CHANGED_FILE = pull.changedFile;
    if (pull.baseUpdateFile) variables.FIXTURE_BASE_UPDATE_FILE = pull.baseUpdateFile;
    createdResourceIds.push(...pull.resourceIds);
  }
  if (required.has("release")) {
    const release = await createReleaseFixture(context);
    variables.FIXTURE_TAG = release.tag;
    createdResourceIds.push(...release.resourceIds);
  }

  registerExpectedModelResources(context, variables, createdResourceIds);

  return {
    taskId: context.task.id,
    configId: context.configId,
    runIndex: context.runIndex,
    status: "ready",
    variables,
    completionVerifier: buildCompletionVerifier(context.task, context.configId, variables, context.owner, context.repo),
    rawDataPaths: { fixtures: [context.outputPath] },
    createdResourceIds,
  };
}

function baseVariables(context: AllocationBuilderContext): Record<string, string | number | boolean> {
  return {
    GITHUB_BENCHMARK_OWNER: context.owner,
    GITHUB_BENCHMARK_REPO: context.repo,
    GITHUB_BENCHMARK_ASSIGNEE: context.assignee,
    GITHUB_BENCHMARK_REVIEWER: context.reviewer,
    FIXTURE_BASE_BRANCH: context.baseBranch,
    FIXTURE_COMMIT_SHA: context.baseSha,
    FIXTURE_README_PATH: "README.md",
    RUN_ID: context.runId,
    TASK_ID: context.task.id,
    CONFIG_ID: context.configId,
    RUN_INDEX: context.runIndex,
  };
}

async function ensureBaselineLabels(client: GitHubFixtureClient, owner: string, repo: string): Promise<void> {
  await Promise.all([
    client.ensureLabel(owner, repo, "benchmark", "0E8A16", "MCPAQL benchmark fixture"),
    client.ensureLabel(owner, repo, "bug", "D73A4A", "MCPAQL benchmark fixture"),
    client.ensureLabel(owner, repo, "documentation", "0075CA", "MCPAQL benchmark fixture"),
    client.ensureLabel(owner, repo, "needs-review", "FBCA04", "MCPAQL benchmark fixture"),
  ]);
}

async function createIssueFixture(
  context: AllocationBuilderContext,
  kind: string,
  options: { labels?: string[]; assignees?: string[] },
): Promise<{ number: number; resourceId: string }> {
  const isTitleMutationFixture = context.task.id === "issue-update-title";
  const issue = await context.client.createIssue({
    owner: context.owner,
    repo: context.repo,
    title: isTitleMutationFixture
      ? `Benchmark fixture ${kind} title seed ${context.configId} ${context.runIndex}`
      : `Benchmark fixture ${kind} ${context.runId}`,
    body: isTitleMutationFixture
      ? `Disposable benchmark fixture for ${context.task.id} before title mutation.`
      : `Disposable benchmark fixture for ${context.task.id} ${context.configId} run ${context.runIndex}.`,
    labels: options.labels,
    assignees: options.assignees,
  });
  const resource = registerResource(context, "issue", "close", {
    number: issue.number,
    url: issue.url ?? "",
  });
  return { number: issue.number, resourceId: resource.id };
}

async function createBranchFixture(context: AllocationBuilderContext, kind: string): Promise<{ branch: string; resourceId: string }> {
  const branch = sanitizeRef(`benchmark/${context.runId}/${kind}`);
  await context.client.createBranch({ owner: context.owner, repo: context.repo, branch, sha: context.baseSha });
  const resource = registerResource(context, "branch", "delete", { branch });
  return { branch, resourceId: resource.id };
}

async function createSeededBranchFixture(
  context: AllocationBuilderContext,
  kind: string,
): Promise<{ branch: string; changedFile: string; resourceIds: string[] }> {
  const branch = await createBranchFixture(context, kind);
  const changedFile = `benchmark/${context.runId}-${kind}.md`;
  const file = await context.client.createOrUpdateFile({
    owner: context.owner,
    repo: context.repo,
    filePath: changedFile,
    branch: branch.branch,
    message: `Seed benchmark branch ${context.runId}`,
    content: `# Benchmark branch fixture\n\nTask: ${context.task.id}\nRun: ${context.runId}\n`,
  });
  const fileResource = registerResource(context, "file", "none", { path: file.path, branch: branch.branch, sha: file.sha });
  return { branch: branch.branch, changedFile, resourceIds: [branch.resourceId, fileResource.id] };
}

async function createFileFixture(context: AllocationBuilderContext, kind: string): Promise<{ filePath: string; resourceId: string }> {
  const filePath = `benchmark/${context.runId}-${kind}.md`;
  await context.client.createOrUpdateFile({
    owner: context.owner,
    repo: context.repo,
    filePath,
    branch: context.baseBranch,
    message: `Create benchmark fixture ${context.runId}`,
    content: `# Benchmark fixture\n\nTask: ${context.task.id}\nRun: ${context.runId}\n`,
  });
  const resource = registerResource(context, "file", "delete", { path: filePath, branch: context.baseBranch });
  return { filePath, resourceId: resource.id };
}

async function createPullRequestFixture(
  context: AllocationBuilderContext,
  kind: string,
): Promise<{ pullNumber: number; branch: string; changedFile: string; baseUpdateFile?: string; resourceIds: string[] }> {
  const branch = await createBranchFixture(context, kind);
  const changedFile = `benchmark/${context.runId}-${kind}.md`;
  const file = await context.client.createOrUpdateFile({
    owner: context.owner,
    repo: context.repo,
    filePath: changedFile,
    branch: branch.branch,
    message: `Create PR fixture ${context.runId}`,
    content: `# Pull request fixture\n\nTask: ${context.task.id}\nRun: ${context.runId}\n`,
  });
  const fileResource = registerResource(context, "file", "none", { path: file.path, branch: branch.branch, sha: file.sha });
  const pull = await context.client.createPullRequest({
    owner: context.owner,
    repo: context.repo,
    title: `Benchmark PR fixture ${context.runId}`,
    head: branch.branch,
    base: context.baseBranch,
    body: `Disposable benchmark PR fixture for ${context.task.id}.`,
  });
  const pullResource = registerResource(context, "pull_request", "close", {
    number: pull.number,
    branch: branch.branch,
    url: pull.url ?? "",
  });
  const resourceIds = [branch.resourceId, fileResource.id, pullResource.id];
  let baseUpdateFile: string | undefined;
  if (context.task.id === "pull-update-branch") {
    const baseUpdate = await createBaseUpdateFixture(context);
    baseUpdateFile = baseUpdate.filePath;
    resourceIds.push(baseUpdate.resourceId);
  }
  return {
    pullNumber: pull.number,
    branch: branch.branch,
    changedFile,
    baseUpdateFile,
    resourceIds,
  };
}

async function createBaseUpdateFixture(context: AllocationBuilderContext): Promise<{ filePath: string; resourceId: string }> {
  const filePath = `benchmark/${context.runId}-base-update.md`;
  const file = await context.client.createOrUpdateFile({
    owner: context.owner,
    repo: context.repo,
    filePath,
    branch: context.baseBranch,
    message: `Advance benchmark base ${context.runId}`,
    content: `# Benchmark base update\n\nTask: ${context.task.id}\nRun: ${context.runId}\n`,
  });
  const resource = registerResource(context, "file", "delete", { path: file.path, branch: context.baseBranch, sha: file.sha });
  return { filePath: file.path, resourceId: resource.id };
}

async function createExistingBranchFixture(context: AllocationBuilderContext): Promise<{ branch: string; resourceId: string }> {
  const branch = `benchmark-${context.runId}`;
  await context.client.createBranch({ owner: context.owner, repo: context.repo, branch, sha: context.baseSha });
  const resource = registerResource(context, "branch", "delete", { branch });
  return { branch, resourceId: resource.id };
}

async function createPullRequestReviewCommentFixture(
  context: AllocationBuilderContext,
  pullNumber: number,
  branch: string,
  changedFile: string,
): Promise<{ resourceId: string }> {
  const head = await context.client.getBranchHead(context.owner, context.repo, branch);
  const comment = await context.client.createPullRequestReviewComment({
    owner: context.owner,
    repo: context.repo,
    pullNumber,
    body: expectedReviewComment(context.runId),
    commitId: head.sha,
    path: changedFile,
    line: 1,
    side: "RIGHT",
  });
  const resource = registerResource(context, "pull_request_review_comment", "delete", {
    pullNumber,
    commentId: comment.id,
    path: changedFile,
  });
  return { resourceId: resource.id };
}

async function createPendingReviewFixture(context: AllocationBuilderContext, pullNumber: number): Promise<{ resourceId: string }> {
  const review = await context.client.createPendingReview({
    owner: context.owner,
    repo: context.repo,
    pullNumber,
    body: `Pending benchmark review for ${context.runId}.`,
  });
  const resource = registerResource(context, "pending_review", "delete", { pullNumber, reviewId: review.id });
  return { resourceId: resource.id };
}

async function createReleaseFixture(context: AllocationBuilderContext): Promise<{ tag: string; resourceIds: string[] }> {
  const tag = sanitizeRef(`benchmark-${context.runId}`);
  const release = await context.client.createRelease({
    owner: context.owner,
    repo: context.repo,
    tag,
    name: `Benchmark release ${context.runId}`,
    body: `Disposable benchmark release fixture for ${context.task.id}.`,
    draft: false,
  });
  const releaseResource = registerResource(context, "release", "delete", { releaseId: release.id, tag: release.tagName });
  const tagResource = registerResource(context, "tag", "delete", { tag });
  return { tag, resourceIds: [releaseResource.id, tagResource.id] };
}

function registerExpectedModelResources(
  context: AllocationBuilderContext,
  variables: Record<string, string | number | boolean>,
  resourceIds: string[],
): void {
  if (context.task.id.startsWith("issue-create") || context.task.id === "error-issue-create-missing-title") {
    resourceIds.push(registerResource(context, "expected_issue", "close", { title: expectedCreatedIssueTitle(context.task.id, context.runId) }).id);
  }
  if (context.task.id === "pull-create") {
    resourceIds.push(registerResource(context, "expected_pull_request", "close", {
      title: `Benchmark PR ${context.runId}`,
      head: String(variables.FIXTURE_BRANCH),
    }).id);
  }
  if (context.task.id === "pull-merge" && typeof variables.FIXTURE_CHANGED_FILE === "string") {
    resourceIds.push(registerResource(context, "expected_file", "delete", {
      path: variables.FIXTURE_CHANGED_FILE,
      branch: context.baseBranch,
    }).id);
  }
  if (context.task.id === "branch-create") {
    resourceIds.push(registerResource(context, "expected_branch", "delete", { branch: `benchmark-${context.runId}` }).id);
  }
  if (context.task.id === "repo-file-create") {
    resourceIds.push(registerResource(context, "expected_file", "delete", {
      path: `benchmark/${context.runId}.md`,
      branch: context.baseBranch,
    }).id);
  }
}

function registerResource(
  context: AllocationBuilderContext,
  type: FixtureResource["type"],
  teardown: FixtureResource["teardown"],
  metadata: FixtureResource["metadata"],
): FixtureResource {
  const id = `${type}:${context.task.id}:${context.configId}:${context.runIndex}:${context.scratchResources.length}`;
  const resource: FixtureResource = {
    id,
    type,
    owner: context.owner,
    repo: context.repo,
    taskId: context.task.id,
    configId: context.configId,
    runIndex: context.runIndex,
    createdAt: context.createdAt,
    teardown,
    metadata,
  };
  context.scratchResources.push(resource);
  return resource;
}

function buildCompletionVerifier(
  task: GitHubBenchmarkTask,
  configId: LlmMetricConfigId,
  variables: Record<string, string | number | boolean>,
  owner: string,
  repo: string,
): FixtureCompletionVerifier {
  const raw = (toolName: string, args: Record<string, unknown>, extra: Partial<FixtureCompletionVerifier> = {}): FixtureCompletionVerifier => ({
    toolName,
    arguments: args,
    ...extra,
  });
  const adapted = (operation: string, params: Record<string, unknown>, extra: Partial<FixtureCompletionVerifier> = {}): FixtureCompletionVerifier => ({
    toolName: endpointForOperation(task, operation),
    arguments: { operation, params },
    ...extra,
  });
  const common = { owner, repo };
  const issueNumber = Number(variables.FIXTURE_ISSUE_NUMBER ?? variables.FIXTURE_CLOSED_ISSUE_NUMBER);
  const pullNumber = Number(variables.FIXTURE_PULL_NUMBER ?? variables.FIXTURE_MERGEABLE_PULL_NUMBER);
  const filePath = String(variables.FIXTURE_FILE_PATH ?? variables.FIXTURE_DELETE_FILE_PATH ?? `benchmark/${variables.RUN_ID ?? ""}.md`);
  const branch = String(variables.FIXTURE_BRANCH ?? `benchmark-${variables.RUN_ID ?? ""}`);
  const baseUpdateFile = String(variables.FIXTURE_BASE_UPDATE_FILE ?? `benchmark/${variables.RUN_ID ?? ""}-base-update.md`);
  const tag = String(variables.FIXTURE_TAG ?? "");

  let operation = task.expectedOperation;
  let params: Record<string, unknown> = { ...common };
  let verifierExtra: Partial<FixtureCompletionVerifier> = {};
  let rawTool = task.expectedFirstTool.rawMcp;
  let rawArgs: Record<string, unknown> = { ...common };
  const specificVerifier = taskSpecificVerifier(task, variables, owner, repo);

  if (specificVerifier) {
    operation = specificVerifier.operation;
    params = specificVerifier.params;
    rawTool = specificVerifier.rawTool;
    rawArgs = specificVerifier.rawArgs;
    verifierExtra = specificVerifier.extra ?? {};
  } else if (task.id.startsWith("issue-create") || task.id === "error-issue-create-missing-title") {
    operation = "search_issues";
    rawTool = "search_issues";
    params = {
      ...common,
      query: expectedCreatedIssueQuery(task.id, String(variables.RUN_ID ?? ""), owner, repo),
    };
    rawArgs = params;
    verifierExtra = {
      expectedTextIncludes: expectedCreatedIssueTitle(task.id, String(variables.RUN_ID ?? "")),
      retry: SEARCH_COMPLETION_RETRY,
    };
  } else if (task.id.includes("issue") && Number.isFinite(issueNumber)) {
    operation = "issue_read";
    rawTool = "issue_read";
    params = { ...common, method: "get", issue_number: issueNumber };
    rawArgs = { ...common, method: "get", issueNumber };
    if (task.id === "issue-close") verifierExtra = { expectedJsonMatches: [{ path: "state", value: "closed" }] };
    if (task.id === "issue-reopen") verifierExtra = { expectedJsonMatches: [{ path: "state", value: "open" }] };
    if (task.id === "issue-update-title") verifierExtra = { expectedTextIncludes: expectedUpdatedIssueTitle(String(variables.RUN_ID ?? "")) };
  } else if (task.id === "pull-create") {
    operation = "list_pull_requests";
    rawTool = "list_pull_requests";
    params = { ...common, state: "open", head: pullHeadFilter(owner, branch) };
    rawArgs = params;
    verifierExtra = { expectedTextIncludes: String(variables.RUN_ID ?? "") };
  } else if (task.id === "pull-update-branch") {
    operation = "get_file_contents";
    rawTool = "get_file_contents";
    params = { ...common, path: baseUpdateFile, branch };
    rawArgs = params;
    verifierExtra = { expectedTextIncludes: "Benchmark base update" };
  } else if (task.id.includes("pull") && Number.isFinite(pullNumber)) {
    const pullReadMethod = task.expectedRawMethod ?? task.expectedAdaptedMethod ?? (task.id === "pull-comments" ? "get_review_comments" : "get");
    operation = "pull_request_read";
    rawTool = "pull_request_read";
    params = {
      ...common,
      method: pullReadMethod,
      pull_number: pullNumber,
    };
    rawArgs = { ...common, method: pullReadMethod, pullNumber };
    if (task.id === "pull-comments") verifierExtra = { expectedTextIncludes: expectedReviewComment(String(variables.RUN_ID ?? "")) };
    if (task.id === "pull-merge") verifierExtra = { expectedJsonMatches: [{ path: "merged", value: true }] };
  } else if (task.id === "branch-create" || task.id === "error-branch-create-existing") {
    operation = "list_branches";
    rawTool = "list_branches";
    params = { ...common };
    rawArgs = params;
    verifierExtra = { expectedTextIncludes: `benchmark-${variables.RUN_ID ?? ""}` };
  } else if (task.id.includes("file")) {
    operation = "get_file_contents";
    rawTool = "get_file_contents";
    const targetPath = task.id === "repo-file-create" ? `benchmark/${variables.RUN_ID ?? ""}.md` : filePath;
    params = { ...common, path: targetPath };
    rawArgs = params;
    if (task.id === "repo-file-delete") verifierExtra = { expectError: true };
    if (task.id === "repo-file-update") verifierExtra = { expectedTextIncludes: expectedFileUpdateLine(String(variables.RUN_ID ?? "")) };
    if (task.id === "error-file-update-stale-sha") verifierExtra = { expectedTextIncludes: expectedFileRecoveryLine(String(variables.RUN_ID ?? "")) };
  } else if (task.id.includes("release") && tag) {
    operation = "get_release_by_tag";
    rawTool = "get_release_by_tag";
    params = { ...common, tag };
    rawArgs = params;
  } else if (task.expectedRawMethod) {
    rawArgs = { ...common, method: task.expectedRawMethod };
    params = task.expectedAdaptedMethod ? { ...common, method: task.expectedAdaptedMethod } : { ...common };
  }

  return configId === RAW_CONFIG_ID
    ? raw(rawTool, rawArgs, verifierExtra)
    : adapted(operation, params, verifierExtra);
}

function taskSpecificVerifier(
  task: GitHubBenchmarkTask,
  variables: Record<string, string | number | boolean>,
  owner: string,
  repo: string,
): {
  operation: string;
  params: Record<string, unknown>;
  rawTool: string;
  rawArgs: Record<string, unknown>;
  extra?: Partial<FixtureCompletionVerifier>;
} | undefined {
  const common = { owner, repo };
  const method = task.expectedAdaptedMethod ?? task.expectedRawMethod ?? undefined;
  const methodParams = method ? { method } : {};
  switch (task.id) {
    case "issue-list-open":
      return args("list_issues", "list_issues", { ...common, state: "open" });
    case "issue-list-assigned":
      return args("list_issues", "list_issues", { ...common, assignee: String(variables.GITHUB_BENCHMARK_ASSIGNEE) }, {
        expectedTextIncludes: String(variables.GITHUB_BENCHMARK_ASSIGNEE),
      });
    case "issue-search-label":
      return args("search_issues", "search_issues", { ...common, query: `repo:${owner}/${repo} label:benchmark` });
    case "issue-comment":
    case "error-issue-comment-wrong-number":
      return args("search_issues", "search_issues", {
        ...common,
        query: task.id === "issue-comment"
          ? `repo:${owner}/${repo} "benchmark comment" "${String(variables.RUN_ID)}" in:comments`
          : `repo:${owner}/${repo} "benchmark recovery" in:comments`,
      }, task.id === "issue-comment"
        ? { expectedTextIncludes: String(variables.RUN_ID) }
        : { expectedJsonMatches: [{ path: "items.*.number", value: Number(variables.FIXTURE_ISSUE_NUMBER) }] });
    case "issue-assign":
      return args("search_issues", "search_issues", {
        ...common,
        query: `repo:${owner}/${repo} is:issue "${String(variables.RUN_ID)}" assignee:${String(variables.GITHUB_BENCHMARK_ASSIGNEE)}`,
      }, { expectedTextIncludes: String(variables.RUN_ID) });
    case "issue-label-add":
      return args("search_issues", "search_issues", {
        ...common,
        query: `repo:${owner}/${repo} is:issue "${String(variables.RUN_ID)}" label:benchmark`,
      }, { expectedTextIncludes: String(variables.RUN_ID) });
    case "issue-label-remove":
      return args("search_issues", "search_issues", {
        ...common,
        query: `repo:${owner}/${repo} is:issue "${String(variables.RUN_ID)}" label:benchmark -label:needs-review`,
      }, { expectedTextIncludes: String(variables.RUN_ID) });
    case "pull-list-open":
      return args("list_pull_requests", "list_pull_requests", { ...common, state: "open" });
    case "pull-request-reviewers":
      return args("pull_request_read", "pull_request_read", {
        ...common,
        method: "get",
        pull_number: Number(variables.FIXTURE_PULL_NUMBER),
      }, { expectedTextIncludes: String(variables.GITHUB_BENCHMARK_REVIEWER) }, {
        ...common,
        method: "get",
        pullNumber: Number(variables.FIXTURE_PULL_NUMBER),
      });
    case "pull-add-review-comment":
      return args("pull_request_read", "pull_request_read", {
        ...common,
        method: "get_review_comments",
        pull_number: Number(variables.FIXTURE_PULL_NUMBER),
      }, { expectedTextIncludes: expectedReviewComment(String(variables.RUN_ID)) }, {
        ...common,
        method: "get_review_comments",
        pullNumber: Number(variables.FIXTURE_PULL_NUMBER),
      });
    case "pull-submit-review":
      return args("pull_request_read", "pull_request_read", {
        ...common,
        method: "get_reviews",
        pull_number: Number(variables.FIXTURE_PULL_NUMBER),
      }, { expectedTextIncludes: `Pending benchmark review for ${String(variables.RUN_ID)}` }, {
        ...common,
        method: "get_reviews",
        pullNumber: Number(variables.FIXTURE_PULL_NUMBER),
      });
    case "error-pr-reviewer-invalid":
      return args("pull_request_read", "pull_request_read", {
        ...common,
        method: "get",
        pull_number: Number(variables.FIXTURE_PULL_NUMBER),
      }, { expectedTextIncludes: String(variables.GITHUB_BENCHMARK_REVIEWER) }, {
        ...common,
        method: "get",
        pullNumber: Number(variables.FIXTURE_PULL_NUMBER),
      });
    case "error-label-add-invalid":
      return args("search_issues", "search_issues", {
        ...common,
        query: `repo:${owner}/${repo} is:issue "${String(variables.RUN_ID)}" label:benchmark`,
      }, { expectedTextIncludes: String(variables.RUN_ID) });
    case "repo-get":
      return args("get_repository_tree", "get_repository_tree", { ...common });
    case "repo-branches":
      return args("list_branches", "list_branches", { ...common });
    case "repo-tags":
      return args("list_tags", "list_tags", { ...common });
    case "repo-commits":
      return args("list_commits", "list_commits", { ...common, sha: String(variables.FIXTURE_BASE_BRANCH) });
    case "repo-file-read":
      return args("get_file_contents", "get_file_contents", { ...common, path: String(variables.FIXTURE_README_PATH) });
    case "search-code":
      return args("search_code", "search_code", { ...common, query: `repo:${owner}/${repo} benchmark` });
    case "search-repositories":
      return args("search_repositories", "search_repositories", { query: `${repo} user:${owner}` });
    case "labels-list":
      return args("list_label", "list_label", { ...common }, { expectedTextIncludes: "benchmark" });
    case "collaborators-list":
      return args("list_repository_collaborators", "list_repository_collaborators", { ...common });
    case "commit-get":
      return args("get_commit", "get_commit", { ...common, sha: String(variables.FIXTURE_COMMIT_SHA) });
    case "workflow-list":
      return args("actions_list", "actions_list", { ...common, ...methodParams });
    case "workflow-runs":
      return args("actions_list", "actions_list", { ...common, ...methodParams });
    case "release-list":
      return args("list_releases", "list_releases", { ...common });
    case "user-get-authenticated":
      return args("get_me", "get_me", {});
    case "error-search-malformed-query":
      return args("search_issues", "search_issues", { ...common, query: `repo:${owner}/${repo} benchmark recovery` });
    default:
      return undefined;
  }
}

function args(
  operation: string,
  rawTool: string,
  values: Record<string, unknown>,
  extra?: Partial<FixtureCompletionVerifier>,
  rawValues?: Record<string, unknown>,
): {
  operation: string;
  params: Record<string, unknown>;
  rawTool: string;
  rawArgs: Record<string, unknown>;
  extra?: Partial<FixtureCompletionVerifier>;
} {
  return {
    operation,
    params: values,
    rawTool,
    rawArgs: rawValues ?? values,
    extra,
  };
}

function expectedCreatedIssueTitle(taskId: string, runId: string): string {
  if (taskId === "issue-create-with-labels") return `Labeled benchmark ${runId}`;
  if (taskId === "error-issue-create-missing-title") return `benchmark recovery ${runId}`;
  return `Benchmark issue ${runId}`;
}

function expectedCreatedIssueQuery(taskId: string, runId: string, owner: string, repo: string): string {
  const labelFilters = taskId === "issue-create-with-labels" ? " label:benchmark label:documentation" : "";
  return `repo:${owner}/${repo} is:issue in:title "${expectedCreatedIssueTitle(taskId, runId)}"${labelFilters}`;
}

function expectedUpdatedIssueTitle(runId: string): string {
  return `Benchmark title ${runId}`;
}

function expectedFileUpdateLine(runId: string): string {
  return `Benchmark update ${runId}`;
}

function expectedFileRecoveryLine(runId: string): string {
  return `Benchmark recovery ${runId}`;
}

function expectedReviewComment(runId: string): string {
  return `Benchmark review comment ${runId}`;
}

function pullHeadFilter(owner: string, branch: string): string {
  return `${owner}:${branch}`;
}

function endpointForOperation(task: GitHubBenchmarkTask, operation: string): string {
  if (operation === task.expectedOperation) return task.expectedFirstTool.mcpaqlAdapted;
  if (operation.startsWith("get_") || operation.startsWith("list_") || operation.startsWith("search_") || operation.endsWith("_read")) {
    return "mcp_aql_read";
  }
  return "mcp_aql_execute";
}

export async function teardownGitHubBenchmarkFixtures(options: GitHubFixtureTeardownOptions): Promise<GitHubBenchmarkFixtureTeardown> {
  const setupPath = options.setupPath ?? DEFAULT_SETUP_PATH;
  const outputPath = options.outputPath ?? DEFAULT_TEARDOWN_PATH;
  const setup = JSON.parse(await readFile(setupPath, "utf8")) as GitHubBenchmarkFixtureSetup;
  if (setup.schemaVersion !== GITHUB_FIXTURE_SCHEMA_VERSION) {
    throw new Error(`Fixture setup ${setupPath} has unsupported schemaVersion ${String(setup.schemaVersion)}.`);
  }
  const dryRun = options.dryRun ?? setup.mode === "dry-run";
  const client = options.client ?? (dryRun ? new DryRunGitHubFixtureClient() : new RestGitHubFixtureClient(options.token ?? requireEnv("GITHUB_PERSONAL_ACCESS_TOKEN")));
  const generatedAt = options.startedAt ?? new Date().toISOString();
  const results: FixtureTeardownResult[] = [];
  const errors: Array<{ resourceId: string; message: string }> = [];

  for (const resource of [...setup.createdResources].reverse()) {
    try {
      results.push(await teardownResource(client, resource));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ resourceId: resource.id, message });
      results.push({ resourceId: resource.id, type: resource.type, action: resource.teardown ?? "none", status: "error", message });
      if (!options.continueOnError) break;
    }
  }

  const teardown: GitHubBenchmarkFixtureTeardown = {
    schemaVersion: GITHUB_FIXTURE_SCHEMA_VERSION,
    generatedAt,
    setupPath,
    owner: setup.owner,
    repo: setup.repo,
    mode: dryRun ? "dry-run" : "live",
    results,
    errors,
    notes: dryRun
      ? "Dry-run teardown only. No GitHub resources were changed."
      : "Live fixture teardown/archive record. Review errors before deleting local artifacts.",
  };
  await writeJsonFile(outputPath, deepRedact(teardown));
  if (errors.length > 0 && !options.continueOnError) {
    throw new Error(`Fixture teardown failed with ${errors.length} error(s).`);
  }
  return teardown;
}

async function teardownResource(client: GitHubFixtureClient, resource: FixtureResource): Promise<FixtureTeardownResult> {
  const action = resource.teardown ?? "none";
  const meta = resource.metadata;
  if (action === "none") return { resourceId: resource.id, type: resource.type, action, status: "skipped" };
  if (resource.type === "issue" && typeof meta.number === "number") {
    await client.updateIssue({ owner: resource.owner, repo: resource.repo, number: meta.number, state: "closed" });
    return { resourceId: resource.id, type: resource.type, action, status: "ok" };
  }
  if (resource.type === "pull_request" && typeof meta.number === "number") {
    await client.closePullRequest(resource.owner, resource.repo, meta.number);
    return { resourceId: resource.id, type: resource.type, action, status: "ok" };
  }
  if (resource.type === "pull_request_review_comment" && typeof meta.commentId === "number") {
    await client.deletePullRequestReviewComment(resource.owner, resource.repo, meta.commentId);
    return { resourceId: resource.id, type: resource.type, action, status: "ok" };
  }
  if (resource.type === "pending_review" && typeof meta.pullNumber === "number" && typeof meta.reviewId === "number") {
    const review = await client.getPullRequestReview(resource.owner, resource.repo, meta.pullNumber, meta.reviewId);
    if (review === undefined || review.state.toUpperCase() !== "PENDING") {
      return {
        resourceId: resource.id,
        type: resource.type,
        action,
        status: "skipped",
        message: review === undefined ? "Pending review no longer exists." : `Review is already ${review.state}.`,
      };
    }
    await client.deletePendingReview(resource.owner, resource.repo, meta.pullNumber, meta.reviewId);
    return { resourceId: resource.id, type: resource.type, action, status: "ok" };
  }
  if (resource.type === "branch" && typeof meta.branch === "string") {
    await client.deleteBranch(resource.owner, resource.repo, meta.branch);
    return { resourceId: resource.id, type: resource.type, action, status: "ok" };
  }
  if (resource.type === "file" && typeof meta.path === "string" && typeof meta.branch === "string") {
    await client.deleteFile({ owner: resource.owner, repo: resource.repo, filePath: meta.path, branch: meta.branch, message: `Delete benchmark fixture ${resource.id}` });
    return { resourceId: resource.id, type: resource.type, action, status: "ok" };
  }
  if (resource.type === "release" && typeof meta.releaseId === "number") {
    await client.deleteRelease(resource.owner, resource.repo, meta.releaseId);
    return { resourceId: resource.id, type: resource.type, action, status: "ok" };
  }
  if (resource.type === "tag" && typeof meta.tag === "string") {
    await client.deleteTag(resource.owner, resource.repo, meta.tag);
    return { resourceId: resource.id, type: resource.type, action, status: "ok" };
  }
  if (resource.type === "expected_issue" && typeof meta.title === "string") {
    const issue = await client.findIssue(resource.owner, resource.repo, { title: meta.title });
    if (!issue) return { resourceId: resource.id, type: resource.type, action, status: "skipped", message: "expected issue was not found" };
    await client.updateIssue({ owner: resource.owner, repo: resource.repo, number: issue.number, state: "closed" });
    return { resourceId: resource.id, type: resource.type, action, status: "ok" };
  }
  if (resource.type === "expected_pull_request") {
    const pull = await client.findPullRequest(resource.owner, resource.repo, {
      head: typeof meta.head === "string" ? meta.head : undefined,
      title: typeof meta.title === "string" ? meta.title : undefined,
    });
    if (!pull) return { resourceId: resource.id, type: resource.type, action, status: "skipped", message: "expected pull request was not found" };
    await client.closePullRequest(resource.owner, resource.repo, pull.number);
    return { resourceId: resource.id, type: resource.type, action, status: "ok" };
  }
  if (resource.type === "expected_branch" && typeof meta.branch === "string") {
    await client.deleteBranch(resource.owner, resource.repo, meta.branch);
    return { resourceId: resource.id, type: resource.type, action, status: "ok" };
  }
  if (resource.type === "expected_file" && typeof meta.path === "string" && typeof meta.branch === "string") {
    await client.deleteFile({ owner: resource.owner, repo: resource.repo, filePath: meta.path, branch: meta.branch, message: `Delete benchmark output ${resource.id}` });
    return { resourceId: resource.id, type: resource.type, action, status: "ok" };
  }
  return { resourceId: resource.id, type: resource.type, action, status: "skipped", message: "resource metadata is insufficient for teardown" };
}

async function loadManifest(manifestPath: string): Promise<GitHubBenchmarkManifest> {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  if (!isRecord(manifest) || typeof manifest.suite !== "string" || !Array.isArray(manifest.tasks)) {
    throw new Error(`Benchmark manifest ${manifestPath} must include suite and tasks.`);
  }
  return manifest as unknown as GitHubBenchmarkManifest;
}

async function ensureFixtureDirectory(outputPath: string): Promise<void> {
  await mkdir(path.dirname(outputPath), { recursive: true });
}

function sanitizeRef(value: string): string {
  return value.replace(/[^A-Za-z0-9._/-]+/g, "-").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

class DryRunGitHubFixtureClient implements GitHubFixtureClient {
  private issueNumber = 1000;
  private pullNumber = 2000;
  private releaseId = 3000;
  private reviewId = 4000;
  private files = new Set<string>();

  async getRepository(): Promise<{ defaultBranch: string }> {
    return { defaultBranch: "main" };
  }

  async getBranchHead(): Promise<{ sha: string }> {
    return { sha: "dry-run-base-sha" };
  }

  async ensureLabel(): Promise<void> {}

  async createIssue(): Promise<{ number: number; url?: string }> {
    this.issueNumber += 1;
    return { number: this.issueNumber };
  }

  async updateIssue(): Promise<void> {}

  async createBranch(): Promise<void> {}

  async deleteBranch(): Promise<void> {}

  async createOrUpdateFile(input: CreateFileInput): Promise<{ path: string; sha: string }> {
    this.files.add(`${input.branch}:${input.filePath}`);
    return { path: input.filePath, sha: `sha-${this.files.size}` };
  }

  async deleteFile(input: DeleteFileInput): Promise<void> {
    this.files.delete(`${input.branch}:${input.filePath}`);
  }

  async getFile(_owner: string, _repo: string, filePath: string): Promise<{ sha: string } | undefined> {
    return { sha: `dry-run-${filePath}` };
  }

  async createPullRequest(): Promise<{ number: number; url?: string }> {
    this.pullNumber += 1;
    return { number: this.pullNumber };
  }

  async closePullRequest(): Promise<void> {}

  async findPullRequest(): Promise<{ number: number } | undefined> {
    return undefined;
  }

  async createPullRequestReviewComment(): Promise<{ id: number }> {
    this.reviewId += 1;
    return { id: this.reviewId };
  }

  async deletePullRequestReviewComment(): Promise<void> {}

  async createPendingReview(): Promise<{ id: number }> {
    this.reviewId += 1;
    return { id: this.reviewId };
  }

  async getPullRequestReview(): Promise<{ state: string } | undefined> {
    return { state: "PENDING" };
  }

  async deletePendingReview(): Promise<void> {}

  async createRelease(input: CreateReleaseInput): Promise<{ id: number; tagName: string }> {
    this.releaseId += 1;
    return { id: this.releaseId, tagName: input.tag };
  }

  async deleteRelease(): Promise<void> {}

  async deleteTag(): Promise<void> {}

  async findIssue(): Promise<{ number: number } | undefined> {
    return undefined;
  }
}

class RestGitHubFixtureClient implements GitHubFixtureClient {
  constructor(private readonly token: string) {}

  async getRepository(owner: string, repo: string): Promise<{ defaultBranch: string }> {
    const data = await this.request<{ default_branch: string }>("GET", `/repos/${owner}/${repo}`);
    return { defaultBranch: data.default_branch };
  }

  async getBranchHead(owner: string, repo: string, branch: string): Promise<{ sha: string }> {
    const data = await this.request<{ object: { sha: string } }>("GET", `/repos/${owner}/${repo}/git/ref/heads/${encodePathPart(branch)}`);
    return { sha: data.object.sha };
  }

  async ensureLabel(owner: string, repo: string, name: string, color: string, description: string): Promise<void> {
    try {
      await this.request("GET", `/repos/${owner}/${repo}/labels/${encodePathPart(name)}`);
    } catch (error) {
      if (!isHttpNotFound(error)) throw error;
      await this.request("POST", `/repos/${owner}/${repo}/labels`, { name, color, description });
    }
  }

  async createIssue(input: CreateIssueInput): Promise<{ number: number; url?: string }> {
    const data = await this.request<{ number: number; html_url?: string }>("POST", `/repos/${input.owner}/${input.repo}/issues`, {
      title: input.title,
      body: input.body,
      labels: input.labels,
      assignees: input.assignees,
    });
    return { number: data.number, url: data.html_url };
  }

  async updateIssue(input: UpdateIssueInput): Promise<void> {
    await this.request("PATCH", `/repos/${input.owner}/${input.repo}/issues/${input.number}`, {
      title: input.title,
      state: input.state,
      labels: input.labels,
      assignees: input.assignees,
    });
  }

  async createBranch(input: CreateBranchInput): Promise<void> {
    await this.request("POST", `/repos/${input.owner}/${input.repo}/git/refs`, {
      ref: `refs/heads/${input.branch}`,
      sha: input.sha,
    });
  }

  async deleteBranch(owner: string, repo: string, branch: string): Promise<void> {
    await this.deleteIfFound(`/repos/${owner}/${repo}/git/refs/heads/${encodePathPart(branch)}`);
  }

  async createOrUpdateFile(input: CreateFileInput): Promise<{ path: string; sha: string }> {
    const existing = await this.getFile(input.owner, input.repo, input.filePath, input.branch);
    const data = await this.request<{ content: { path: string; sha: string } }>("PUT", `/repos/${input.owner}/${input.repo}/contents/${encodePathPart(input.filePath)}`, {
      message: input.message,
      content: Buffer.from(input.content, "utf8").toString("base64"),
      branch: input.branch,
      sha: existing?.sha,
    });
    return { path: data.content.path, sha: data.content.sha };
  }

  async deleteFile(input: DeleteFileInput): Promise<void> {
    const existing = await this.getFile(input.owner, input.repo, input.filePath, input.branch);
    if (!existing) return;
    await this.request("DELETE", `/repos/${input.owner}/${input.repo}/contents/${encodePathPart(input.filePath)}`, {
      message: input.message,
      sha: existing.sha,
      branch: input.branch,
    });
  }

  async getFile(owner: string, repo: string, filePath: string, ref?: string): Promise<{ sha: string } | undefined> {
    const suffix = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    try {
      const data = await this.request<{ sha: string }>("GET", `/repos/${owner}/${repo}/contents/${encodePathPart(filePath)}${suffix}`);
      return { sha: data.sha };
    } catch (error) {
      if (isHttpNotFound(error)) return undefined;
      throw error;
    }
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<{ number: number; url?: string }> {
    const data = await this.request<{ number: number; html_url?: string }>("POST", `/repos/${input.owner}/${input.repo}/pulls`, {
      title: input.title,
      head: input.head,
      base: input.base,
      body: input.body,
    });
    return { number: data.number, url: data.html_url };
  }

  async closePullRequest(owner: string, repo: string, pullNumber: number): Promise<void> {
    await this.request("PATCH", `/repos/${owner}/${repo}/issues/${pullNumber}`, { state: "closed" });
  }

  async findPullRequest(owner: string, repo: string, query: { head?: string; title?: string }): Promise<{ number: number } | undefined> {
    const data = await this.request<Array<{ number: number; title: string; head: { ref: string } }>>("GET", `/repos/${owner}/${repo}/pulls?state=open&per_page=100`);
    return data.find((pull) =>
      (query.head === undefined || pull.head.ref === query.head) &&
      (query.title === undefined || pull.title === query.title)
    );
  }

  async createPullRequestReviewComment(input: CreatePullRequestReviewCommentInput): Promise<{ id: number }> {
    const data = await this.request<{ id: number }>("POST", `/repos/${input.owner}/${input.repo}/pulls/${input.pullNumber}/comments`, {
      body: input.body,
      commit_id: input.commitId,
      path: input.path,
      line: input.line,
      side: input.side,
    });
    return { id: data.id };
  }

  async deletePullRequestReviewComment(owner: string, repo: string, commentId: number): Promise<void> {
    await this.deleteIfFound(`/repos/${owner}/${repo}/pulls/comments/${commentId}`);
  }

  async createPendingReview(input: CreatePendingReviewInput): Promise<{ id: number }> {
    const data = await this.request<{ id: number }>("POST", `/repos/${input.owner}/${input.repo}/pulls/${input.pullNumber}/reviews`, {
      body: input.body,
    });
    return { id: data.id };
  }

  async getPullRequestReview(owner: string, repo: string, pullNumber: number, reviewId: number): Promise<{ state: string } | undefined> {
    try {
      const data = await this.request<{ state: string }>("GET", `/repos/${owner}/${repo}/pulls/${pullNumber}/reviews/${reviewId}`);
      return { state: data.state };
    } catch (error) {
      if (isHttpNotFound(error)) return undefined;
      throw error;
    }
  }

  async deletePendingReview(owner: string, repo: string, pullNumber: number, reviewId: number): Promise<void> {
    await this.deleteIfFound(`/repos/${owner}/${repo}/pulls/${pullNumber}/reviews/${reviewId}`);
  }

  async createRelease(input: CreateReleaseInput): Promise<{ id: number; tagName: string }> {
    const data = await this.request<{ id: number; tag_name: string }>("POST", `/repos/${input.owner}/${input.repo}/releases`, {
      tag_name: input.tag,
      name: input.name,
      body: input.body,
      draft: input.draft ?? false,
      prerelease: true,
    });
    return { id: data.id, tagName: data.tag_name };
  }

  async deleteRelease(owner: string, repo: string, releaseId: number): Promise<void> {
    await this.deleteIfFound(`/repos/${owner}/${repo}/releases/${releaseId}`);
  }

  async deleteTag(owner: string, repo: string, tag: string): Promise<void> {
    await this.deleteIfFound(`/repos/${owner}/${repo}/git/refs/tags/${encodePathPart(tag)}`);
  }

  async findIssue(owner: string, repo: string, query: { title: string }): Promise<{ number: number } | undefined> {
    const q = encodeURIComponent(`repo:${owner}/${repo} is:issue in:title "${query.title}"`);
    const data = await this.request<{ items: Array<{ number: number; title: string }> }>("GET", `/search/issues?q=${q}`);
    return data.items.find((issue) => issue.title === query.title);
  }

  private async deleteIfFound(apiPath: string): Promise<void> {
    try {
      await this.request("DELETE", apiPath);
    } catch (error) {
      if (!isHttpNotFound(error)) throw error;
    }
  }

  private async request<T = unknown>(method: string, apiPath: string, body?: unknown): Promise<T> {
    const response = await fetch(`https://api.github.com${apiPath}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "User-Agent": "mcpaql-github-llm-fixtures",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(withoutUndefined(body)),
    });
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    const parsed = text ? JSON.parse(text) as unknown : undefined;
    if (!response.ok) {
      const error = new Error(`GitHub API ${method} ${apiPath} failed with ${response.status}: ${JSON.stringify(deepRedact(parsed)).slice(0, 500)}`);
      (error as Error & { status?: number }).status = response.status;
      throw error;
    }
    return parsed as T;
  }
}

function withoutUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUndefined);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, withoutUndefined(entry)]));
  }
  return value;
}

function isHttpNotFound(error: unknown): boolean {
  return error instanceof Error && (error as Error & { status?: number }).status === 404;
}

function encodePathPart(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}
