import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { deepRedact, withTimeout, writeJsonFile } from "./shared.js";
import type {
  LlmMetricConfigId,
  LlmMetricConfiguration,
  LlmMetricsReportInput,
  LlmTaskOutcome,
  LlmTaskResult,
  LlmTokenUsage,
} from "./parity/llm-metrics.js";

const RAW_CONFIG_ID = "raw_mcp" satisfies LlmMetricConfigId;
const ADAPTED_CONFIG_ID = "mcpaql_adapted" satisfies LlmMetricConfigId;
const CONFIG_IDS = [RAW_CONFIG_ID, ADAPTED_CONFIG_ID] as const;
const DEFAULT_ARTIFACT_ROOT = "artifacts/github-llm-benchmark";
const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TURNS = 6;
const DEFAULT_MAX_TOKENS = 1024;
const PROMPT_ENV_ALLOWLIST = [
  "GITHUB_BENCHMARK_OWNER",
  "GITHUB_BENCHMARK_REPO",
  "GITHUB_BENCHMARK_ASSIGNEE",
  "GITHUB_BENCHMARK_REVIEWER",
] as const;
const REQUIRED_LIVE_ENV = [
  "ANTHROPIC_API_KEY",
  "GITHUB_BENCHMARK_OWNER",
  "GITHUB_BENCHMARK_REPO",
  "GITHUB_BENCHMARK_ASSIGNEE",
  "GITHUB_BENCHMARK_REVIEWER",
] as const;
const RAW_LIVE_ENV = [
  "GITHUB_PERSONAL_ACCESS_TOKEN",
  "RAW_GITHUB_MCP_COMMAND",
  "GITHUB_TOOLSETS",
] as const;
const ADAPTED_LIVE_ENV = [
  "GITHUB_PERSONAL_ACCESS_TOKEN",
  "MCPAQL_GITHUB_ADAPTER_SERVER",
  "MCPAQL_GITHUB_ADAPTER_SCHEMA",
  "MCPAQL_GITHUB_ADAPTER_PROVENANCE",
] as const;

export interface GitHubLlmBenchmarkOptions {
  manifestPath: string;
  outputPath: string;
  artifactRoot?: string;
  fixtureInputPath?: string;
  dryRun?: boolean;
  runsPerConfiguration?: number;
  taskIds?: string[];
  taskLimit?: number;
  configIds?: LlmMetricConfigId[];
  model?: string;
  modelVersion?: string;
  anthropicVersion?: string;
  temperature?: number;
  maxTokens?: number;
  maxTurns?: number;
  label?: string;
  startedAt?: string;
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
  mutation?: boolean;
  inducedError?: {
    enabled?: boolean;
    errorCode?: string;
    policy?: string;
  };
}

interface FixtureInput {
  variables?: Record<string, unknown>;
  allocations?: FixtureAllocation[];
  runs?: FixtureAllocation[];
}

interface FixtureAllocation {
  taskId?: string;
  configId?: LlmMetricConfigId;
  runIndex?: number;
  status?: "ready" | "error";
  variables?: Record<string, unknown>;
  completionVerifier?: FixtureCompletionVerifier | Partial<Record<LlmMetricConfigId, FixtureCompletionVerifier>>;
  rawDataPaths?: {
    fixtures?: string[];
    other?: string[];
  };
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

interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema?: unknown;
  [key: string]: unknown;
}

interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface McpToolResult {
  isError?: boolean;
  content?: unknown;
  [key: string]: unknown;
}

interface BenchmarkMcpClient {
  listTools(request?: { cursor?: string }): Promise<{ tools: ToolDefinition[]; nextCursor?: string }>;
  callTool(request: { name: string; arguments?: Record<string, unknown> }): Promise<McpToolResult>;
  close(): Promise<void>;
}

interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
}

interface ModelResponse {
  content: Array<Record<string, unknown>>;
  usage: ModelUsage;
}

interface ModelRequest {
  model: string;
  system: string;
  messages: Array<Record<string, unknown>>;
  tools: Array<Record<string, unknown>>;
  maxTokens: number;
  temperature: number;
  expectedToolCall?: ToolCall;
}

interface ModelProvider {
  createMessage(request: ModelRequest): Promise<ModelResponse>;
  countToolDefinitionTokens(model: string, system: string, tools: Array<Record<string, unknown>>): Promise<number>;
}

interface RunContext {
  task: GitHubBenchmarkTask;
  configId: LlmMetricConfigId;
  runIndex: number;
  prompt: string;
  promptPath: string;
  transcriptPath: string;
  logPath: string;
  toolDefinitionsPath: string;
  fixturePaths: string[];
  completionVerifier?: FixtureCompletionVerifier;
  client: BenchmarkMcpClient;
  tools: Array<Record<string, unknown>>;
  modelProvider: ModelProvider;
  model: string;
  systemPrompt: string;
  maxTokens: number;
  maxTurns: number;
  temperature: number;
  toolDefinitionTokensPerTurn: number;
  dryRun: boolean;
}

export async function runGitHubLlmBenchmark(options: GitHubLlmBenchmarkOptions): Promise<LlmMetricsReportInput> {
  const dryRun = options.dryRun === true;
  const manifest = await loadManifest(options.manifestPath);
  const fixtureInput = options.fixtureInputPath ? await loadFixtureInput(options.fixtureInputPath) : undefined;
  const artifactRoot = options.artifactRoot ?? DEFAULT_ARTIFACT_ROOT;
  const outputPath = options.outputPath;
  const runsPerConfiguration = options.runsPerConfiguration ?? manifest.runCountPerConfiguration ?? 1;
  const configIds = options.configIds ?? [...CONFIG_IDS];
  if (!dryRun) validateLiveEnvironment(configIds, options.model);
  const selectedTasks = selectTasks(manifest.tasks, options);
  const startedAt = options.startedAt ?? new Date().toISOString();
  const model = options.model ?? process.env.ANTHROPIC_MODEL ?? (dryRun ? "mock-claude-github-llm-runner" : "");
  if (!model) throw new Error("--model or ANTHROPIC_MODEL is required for live benchmark runs.");

  await ensureArtifactLayout(artifactRoot);
  const modelProvider = dryRun
    ? new DryRunModelProvider()
    : new AnthropicModelProvider({
      apiKey: requireEnv("ANTHROPIC_API_KEY"),
      version: options.anthropicVersion ?? process.env.ANTHROPIC_VERSION ?? DEFAULT_ANTHROPIC_VERSION,
    });

  const clients = dryRun
    ? createDryRunClients(selectedTasks, configIds)
    : await createLiveClients(configIds);

  try {
    const toolDefinitionsPaths = buildToolDefinitionsPaths(artifactRoot);
    const listedTools = await listSelectedTools(clients, configIds);
    for (const configId of configIds) {
      await writeJsonFile(toolDefinitionsPaths[configId], { tools: deepRedact(requireConfigValue(listedTools, configId, "tool definitions")) });
      assertToolCoverage(selectedTasks, configId, requireConfigValue(listedTools, configId, "tool definitions"));
    }

    const systemPrompt = buildSystemPrompt();
    const toolsByConfig = await buildAnthropicToolsByConfig(listedTools, configIds);
    const toolDefinitionTokensByConfig = await countToolDefinitionTokensByConfig(modelProvider, model, systemPrompt, toolsByConfig, configIds);
    const taskResults: LlmTaskResult[] = [];

    for (const configId of configIds) {
      const configDir = configId === RAW_CONFIG_ID ? "raw-mcp" : "mcpaql-adapted";
      const client = requireConfigValue(clients, configId, "MCP client");
      for (const task of selectedTasks) {
        for (let runIndex = 0; runIndex < runsPerConfiguration; runIndex += 1) {
          const runId = `${task.id}-${configId}-${runIndex}`;
          const allocation = findFixtureAllocation(fixtureInput, task.id, configId, runIndex, task.mutation === true);
          if (allocation?.status === "error") {
            taskResults.push(await buildFixtureSetupErrorResult({
              task,
              configId,
              runIndex,
              artifactRoot,
              configDir,
              toolDefinitionsPath: toolDefinitionsPaths[configId],
              fixturePaths: [
                options.manifestPath,
                ...(options.fixtureInputPath ? [options.fixtureInputPath] : []),
                ...(allocation.rawDataPaths?.fixtures ?? []),
              ],
              error: allocation.error ?? "Fixture setup failed for this task/configuration/run.",
            }));
            continue;
          }
          const variables = buildPromptVariables(task, configId, runIndex, runId, fixtureInput, allocation, dryRun);
          const prompt = substitutePrompt(task.prompt, variables, dryRun);
          const unresolved = findUnresolvedPlaceholders(prompt);
          if (unresolved.length > 0) {
            throw new Error(`Task ${task.id} ${configId} run ${runIndex} has unresolved fixture variables: ${unresolved.join(", ")}.`);
          }

          const fileStem = sanitizeFileStem(runId);
          const promptPath = path.join(artifactRoot, configDir, "prompts", `${fileStem}.txt`);
          const transcriptPath = path.join(artifactRoot, configDir, "transcripts", `${fileStem}.jsonl`);
          const logPath = path.join(artifactRoot, configDir, "logs", `${fileStem}.json`);
          await writeFile(promptPath, prompt, "utf8");

          taskResults.push(await runOneTask({
            task,
            configId,
            runIndex,
            prompt,
            promptPath,
            transcriptPath,
            logPath,
            toolDefinitionsPath: toolDefinitionsPaths[configId],
            fixturePaths: [
              options.manifestPath,
              ...(options.fixtureInputPath ? [options.fixtureInputPath] : []),
              ...(allocation?.rawDataPaths?.fixtures ?? []),
            ],
            completionVerifier: resolveCompletionVerifier(allocation, configId),
            client,
            tools: requireConfigValue(toolsByConfig, configId, "model tools"),
            modelProvider,
            model,
            systemPrompt,
            maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
            maxTurns: options.maxTurns ?? DEFAULT_MAX_TURNS,
            temperature: options.temperature ?? 0,
            toolDefinitionTokensPerTurn: requireConfigValue(toolDefinitionTokensByConfig, configId, "tool definition token count"),
            dryRun,
          }));
        }
      }
    }

    const finishedAt = new Date().toISOString();
    const input: LlmMetricsReportInput = {
      suite: manifest.suite,
      label: options.label ?? (dryRun ? "github-mcp-live-runner-dry-run" : "github-mcp-live-run"),
      generatedAt: finishedAt,
      startedAt,
      finishedAt,
      model: {
        provider: dryRun ? "mock" : "anthropic",
        model,
        version: options.modelVersion ?? process.env.ANTHROPIC_MODEL_VERSION ?? model,
        apiVersion: dryRun ? undefined : options.anthropicVersion ?? process.env.ANTHROPIC_VERSION ?? DEFAULT_ANTHROPIC_VERSION,
        temperature: options.temperature ?? 0,
        maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
        extra: {
          dryRun,
          maxTurns: options.maxTurns ?? DEFAULT_MAX_TURNS,
          fixtureInputPath: options.fixtureInputPath,
          toolDefinitionTokenCounting: dryRun ? "mock-estimate" : "anthropic-count-tokens-minus-baseline",
          fixtureAllocationContract: "Consumes optional variables/allocations from mcpaql-github-llm-fixtures setup output.",
        },
      },
      configurations: buildConfigurations(artifactRoot, configIds),
      rawDataPaths: {
        transcripts: [
          path.join(artifactRoot, "raw-mcp", "transcripts"),
          path.join(artifactRoot, "mcpaql-adapted", "transcripts"),
        ],
        logs: [
          path.join(artifactRoot, "raw-mcp", "logs"),
          path.join(artifactRoot, "mcpaql-adapted", "logs"),
        ],
        prompts: [
          path.join(artifactRoot, "raw-mcp", "prompts"),
          path.join(artifactRoot, "mcpaql-adapted", "prompts"),
        ],
        toolDefinitions: configIds.map((configId) => toolDefinitionsPaths[configId]),
        fixtures: [
          options.manifestPath,
          ...(options.fixtureInputPath ? [options.fixtureInputPath] : []),
          path.join(artifactRoot, "fixtures", "setup.json"),
        ],
      },
      taskResults,
      notes: dryRun
        ? "Dry run only. Model responses, tool calls, tool results, and token usage are synthetic shape-validation data and are not benchmark evidence."
        : "Live runner capture. Do not publish metrics until coordinator review confirms fixture isolation, raw transcripts, and generated reports are safe to cite.",
    };

    await writeJsonFile(outputPath, input);
    return input;
  } finally {
    await closeClientsQuietly(clients);
  }
}

async function buildFixtureSetupErrorResult(input: {
  task: GitHubBenchmarkTask;
  configId: LlmMetricConfigId;
  runIndex: number;
  artifactRoot: string;
  configDir: string;
  toolDefinitionsPath: string;
  fixturePaths: string[];
  error: string;
}): Promise<LlmTaskResult> {
  const timestamp = new Date().toISOString();
  const fileStem = sanitizeFileStem(`${input.task.id}-${input.configId}-${input.runIndex}`);
  const transcriptPath = path.join(input.artifactRoot, input.configDir, "transcripts", `${fileStem}.jsonl`);
  const logPath = path.join(input.artifactRoot, input.configDir, "logs", `${fileStem}.json`);
  const promptPath = path.join(input.artifactRoot, input.configDir, "prompts", `${fileStem}.txt`);
  await mkdir(path.dirname(promptPath), { recursive: true });
  await writeFile(promptPath, `Fixture setup failed before prompt rendering: ${input.error}\n`, "utf8");
  await appendTranscript(transcriptPath, {
    type: "fixture_setup_error",
    taskId: input.task.id,
    configId: input.configId,
    runIndex: input.runIndex,
    error: input.error,
    fixturePaths: input.fixturePaths,
  });
  await writeJsonFile(logPath, {
    taskId: input.task.id,
    configId: input.configId,
    runIndex: input.runIndex,
    outcome: "error",
    firstCallSuccess: null,
    turnsToCompletion: null,
    tokensToCompletion: null,
    startedAt: timestamp,
    finishedAt: timestamp,
    notes: `Fixture setup failed before model execution: ${input.error}`,
  });
  return {
    taskId: input.task.id,
    taskName: input.task.id,
    configId: input.configId,
    outcome: "error",
    firstCallSuccess: null,
    turnsToCompletion: null,
    tokensToCompletion: null,
    inducedError: input.task.inducedError?.enabled === true
      ? {
        injected: false,
        recoveredWithinTwoTurns: null,
        turnsToRecovery: null,
        errorCode: input.task.inducedError.errorCode,
        finalOutcome: "not_measured",
      }
      : { injected: false, finalOutcome: "not_measured" },
    rawDataPaths: {
      transcripts: [transcriptPath],
      logs: [logPath],
      prompts: [promptPath],
      toolDefinitions: [input.toolDefinitionsPath],
      fixtures: input.fixturePaths,
    },
    startedAt: timestamp,
    finishedAt: timestamp,
    notes: `Fixture setup failed before model execution: ${input.error}`,
  };
}

async function runOneTask(context: RunContext): Promise<LlmTaskResult> {
  const startedAt = new Date().toISOString();
  await appendTranscript(context.transcriptPath, {
    type: "task_started",
    taskId: context.task.id,
    configId: context.configId,
    runIndex: context.runIndex,
    dryRun: context.dryRun,
    promptPath: context.promptPath,
    toolDefinitionsPath: context.toolDefinitionsPath,
    startedAt,
  });

  const messages: Array<Record<string, unknown>> = [{ role: "user", content: context.prompt }];
  const expectedToolCall = expectedFirstToolCall(context.task, context.configId);
  let firstToolCall: ToolCall | undefined;
  let firstCallSuccess: boolean | null = null;
  let modelTurnCount = 0;
  let toolCallTurnCount = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let injected = false;
  let injectionTurn: number | null = null;
  let turnsToRecoveryAfterInjection: number | null = null;
  let recoveredWithinTwoTurns: boolean | null = null;
  let lastToolResultWasError = false;
  let outcome: LlmTaskOutcome = "gave_up";
  let notes: string | undefined;

  try {
    for (let turn = 0; turn < context.maxTurns; turn += 1) {
      const response = await context.modelProvider.createMessage({
        model: context.model,
        system: context.systemPrompt,
        messages,
        tools: context.tools,
        maxTokens: context.maxTokens,
        temperature: context.temperature,
        expectedToolCall,
      });
      modelTurnCount += 1;
      promptTokens += Math.max(0, response.usage.inputTokens - context.toolDefinitionTokensPerTurn);
      completionTokens += response.usage.outputTokens;

      await appendTranscript(context.transcriptPath, {
        type: "model_response",
        taskId: context.task.id,
        configId: context.configId,
        runIndex: context.runIndex,
        turn,
        usage: response.usage,
        content: deepRedact(response.content),
      });

      const toolCalls = extractToolCalls(response.content);
      if (toolCalls.length === 0) {
        messages.push({ role: "assistant", content: response.content });
        const completion = await verifyStoppedTaskCompletion(context, {
          firstToolCall,
          firstCallSuccess,
          lastToolResultWasError,
        });
        outcome = completion.outcome;
        notes = completion.notes;
        break;
      }

      toolCallTurnCount += 1;
      if (!firstToolCall) {
        firstToolCall = toolCalls[0];
        firstCallSuccess = isFirstCallSuccess(context.task, context.configId, firstToolCall);
      }

      messages.push({ role: "assistant", content: response.content });
      const toolResults: Array<Record<string, unknown>> = [];
      for (const toolCall of toolCalls) {
        const shouldInject = context.task.inducedError?.enabled === true && !injected;
        let toolResult: McpToolResult;
        if (shouldInject) {
          injected = true;
          injectionTurn = turn;
          toolResult = buildInjectedErrorResult(context.task);
        } else {
          toolResult = await withTimeout(
            context.client.callTool({ name: toolCall.name, arguments: toolCall.input }),
            60_000,
            `${context.configId} ${context.task.id} ${toolCall.name}`,
          );
          const injectedAtTurn = injectionTurn;
          const isCorrectiveRetry = injected && injectedAtTurn !== null && turn > injectedAtTurn && isFirstCallSuccess(context.task, context.configId, toolCall);
          if (isCorrectiveRetry && recoveredWithinTwoTurns === null && toolResult.isError !== true) {
            turnsToRecoveryAfterInjection = turn - injectedAtTurn;
            recoveredWithinTwoTurns = turnsToRecoveryAfterInjection <= 2;
          }
        }

        lastToolResultWasError = toolResult.isError === true;
        await appendTranscript(context.transcriptPath, {
          type: shouldInject ? "induced_tool_error" : "tool_result",
          taskId: context.task.id,
          configId: context.configId,
          runIndex: context.runIndex,
          turn,
          toolCall: deepRedact(toolCall),
          toolResult: deepRedact(toolResult),
        });
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolCall.id,
          content: JSON.stringify(deepRedact(toolResult)),
          is_error: toolResult.isError === true,
        });
      }
      messages.push({ role: "user", content: toolResults });
    }

    if (outcome === "gave_up" && context.task.inducedError?.enabled === true && recoveredWithinTwoTurns === null) {
      recoveredWithinTwoTurns = false;
    }
  } catch (error) {
    outcome = "error";
    notes = error instanceof Error ? error.message : String(error);
    await appendTranscript(context.transcriptPath, {
      type: "runner_error",
      taskId: context.task.id,
      configId: context.configId,
      runIndex: context.runIndex,
      error: notes,
    });
  }

  const finishedAt = new Date().toISOString();
  const completed = outcome === "completed";
  const tokenUsage: LlmTokenUsage = {
    prompt: promptTokens,
    completion: completionTokens,
    toolDefinitions: context.toolDefinitionTokensPerTurn * modelTurnCount,
    total: promptTokens + completionTokens + (context.toolDefinitionTokensPerTurn * modelTurnCount),
  };
  await writeJsonFile(context.logPath, {
    taskId: context.task.id,
    configId: context.configId,
    runIndex: context.runIndex,
    outcome,
    firstCallSuccess,
    turnsToCompletion: completed ? toolCallTurnCount : null,
    tokensToCompletion: completed ? tokenUsage : null,
    inducedError: buildInducedErrorMetric(context.task, injected, recoveredWithinTwoTurns, turnsToRecoveryAfterInjection),
    startedAt,
    finishedAt,
    notes,
  });

  return {
    taskId: context.task.id,
    taskName: context.task.id,
    configId: context.configId,
    outcome,
    firstCallSuccess,
    turnsToCompletion: completed ? toolCallTurnCount : null,
    tokensToCompletion: completed ? tokenUsage : null,
    inducedError: buildInducedErrorMetric(context.task, injected, recoveredWithinTwoTurns, turnsToRecoveryAfterInjection),
    rawDataPaths: {
      transcripts: [context.transcriptPath],
      logs: [context.logPath],
      prompts: [context.promptPath],
      toolDefinitions: [context.toolDefinitionsPath],
      fixtures: context.fixturePaths,
    },
    startedAt,
    finishedAt,
    notes,
  };
}

async function verifyStoppedTaskCompletion(
  context: RunContext,
  state: {
    firstToolCall?: ToolCall;
    firstCallSuccess: boolean | null;
    lastToolResultWasError: boolean;
  },
): Promise<{ outcome: LlmTaskOutcome; notes?: string }> {
  if (!state.firstToolCall) {
    return { outcome: "failed", notes: "Model finished without calling a tool." };
  }
  if (state.firstCallSuccess !== true) {
    return { outcome: "failed", notes: "Model stopped after an incorrect first tool call." };
  }
  if (state.lastToolResultWasError) {
    return { outcome: "failed", notes: "Model stopped after a tool error." };
  }
  if (context.dryRun) {
    return { outcome: "completed" };
  }
  if (!context.completionVerifier) {
    return {
      outcome: "gave_up",
      notes: "Task completion verifier is not configured; live run was not marked completed from tool success alone.",
    };
  }

  const verifier = context.completionVerifier;
  const expectedError = verifier.expectError === true;
  const attempts = Math.max(1, Math.floor(verifier.retry?.attempts ?? 1));
  const delayMs = Math.max(0, Math.floor(verifier.retry?.delayMs ?? 0));
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = await withTimeout(
      context.client.callTool({ name: verifier.toolName, arguments: verifier.arguments ?? {} }),
      60_000,
      `${context.configId} ${context.task.id} completion verifier ${verifier.toolName}`,
    );
    const resultIsError = completionVerifierResultIsError(result);
    const ok = expectedError ? resultIsError : !resultIsError;
    const verifierMatches = completionVerifierResultMatches(result, verifier);
    await appendTranscript(context.transcriptPath, {
      type: "completion_verifier_result",
      taskId: context.task.id,
      configId: context.configId,
      runIndex: context.runIndex,
      verifier: deepRedact(verifier),
      result: deepRedact(result),
      attempt,
      attempts,
      ok: ok && verifierMatches,
    });

    if (ok && verifierMatches) {
      return { outcome: "completed" };
    }
    if (attempt < attempts && delayMs > 0) {
      await sleep(delayMs);
    }
  }
  return {
    outcome: "failed",
    notes: `Completion verifier ${verifier.toolName} did not confirm the requested repository state.`,
  };
}

function validateLiveEnvironment(configIds: readonly LlmMetricConfigId[], modelOption: string | undefined): void {
  const required = new Set<string>(REQUIRED_LIVE_ENV);
  if (!modelOption) required.add("ANTHROPIC_MODEL");
  if (configIds.includes(RAW_CONFIG_ID)) {
    for (const name of RAW_LIVE_ENV) required.add(name);
  }
  if (configIds.includes(ADAPTED_CONFIG_ID)) {
    for (const name of ADAPTED_LIVE_ENV) required.add(name);
  }
  const missing = [...required].filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing required live benchmark environment variables: ${missing.join(", ")}.`);
  }
}

async function loadManifest(manifestPath: string): Promise<GitHubBenchmarkManifest> {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  if (!isRecord(manifest) || typeof manifest.suite !== "string" || !Array.isArray(manifest.tasks)) {
    throw new Error(`Benchmark manifest ${manifestPath} must include suite and tasks.`);
  }
  return manifest as unknown as GitHubBenchmarkManifest;
}

async function loadFixtureInput(fixtureInputPath: string): Promise<FixtureInput> {
  const input = JSON.parse(await readFile(fixtureInputPath, "utf8")) as unknown;
  if (!isRecord(input)) throw new Error(`Fixture input ${fixtureInputPath} must be a JSON object.`);
  return input as FixtureInput;
}

function selectTasks(tasks: GitHubBenchmarkTask[], options: GitHubLlmBenchmarkOptions): GitHubBenchmarkTask[] {
  let selected = tasks;
  if (options.taskIds && options.taskIds.length > 0) {
    const requested = new Set(options.taskIds);
    selected = selected.filter((task) => requested.has(task.id));
    const found = new Set(selected.map((task) => task.id));
    const missing = [...requested].filter((taskId) => !found.has(taskId));
    if (missing.length > 0) throw new Error(`Unknown benchmark task id(s): ${missing.join(", ")}.`);
  }
  if (options.taskLimit !== undefined) selected = selected.slice(0, options.taskLimit);
  if (selected.length === 0) throw new Error("No benchmark tasks selected.");
  return selected;
}

async function ensureArtifactLayout(artifactRoot: string): Promise<void> {
  await Promise.all([
    mkdir(path.join(artifactRoot, "raw-mcp", "transcripts"), { recursive: true }),
    mkdir(path.join(artifactRoot, "raw-mcp", "logs"), { recursive: true }),
    mkdir(path.join(artifactRoot, "raw-mcp", "prompts"), { recursive: true }),
    mkdir(path.join(artifactRoot, "mcpaql-adapted", "transcripts"), { recursive: true }),
    mkdir(path.join(artifactRoot, "mcpaql-adapted", "logs"), { recursive: true }),
    mkdir(path.join(artifactRoot, "mcpaql-adapted", "prompts"), { recursive: true }),
    mkdir(path.join(artifactRoot, "fixtures"), { recursive: true }),
  ]);
}

async function createLiveClients(configIds: readonly LlmMetricConfigId[]): Promise<Partial<Record<LlmMetricConfigId, BenchmarkMcpClient>>> {
  const clients: Partial<Record<LlmMetricConfigId, BenchmarkMcpClient>> = {};
  try {
    if (configIds.includes(RAW_CONFIG_ID)) {
      const rawClient = new Client({ name: "github-llm-benchmark-raw", version: "0.1.0" });
      const rawTransport = new StdioClientTransport({
        command: "sh",
        args: ["-lc", requireEnv("RAW_GITHUB_MCP_COMMAND")],
        env: childEnv(),
        stderr: "pipe",
      });
      await rawClient.connect(rawTransport);
      clients[RAW_CONFIG_ID] = rawClient as unknown as BenchmarkMcpClient;
    }
    if (configIds.includes(ADAPTED_CONFIG_ID)) {
      const adaptedClient = new Client({ name: "github-llm-benchmark-mcpaql", version: "0.1.0" });
      const adaptedTransport = new StdioClientTransport({
        command: "node",
        args: [requireEnv("MCPAQL_GITHUB_ADAPTER_SERVER")],
        env: childEnv(),
        stderr: "pipe",
      });
      await adaptedClient.connect(adaptedTransport);
      clients[ADAPTED_CONFIG_ID] = adaptedClient as unknown as BenchmarkMcpClient;
    }
  } catch (error) {
    await closeClientsQuietly(clients);
    throw error;
  }
  return clients;
}

async function closeClientsQuietly(clients: Partial<Record<LlmMetricConfigId, BenchmarkMcpClient>>): Promise<void> {
  await Promise.allSettled(Object.values(clients).map((client) => client.close()));
}

function createDryRunClients(
  tasks: GitHubBenchmarkTask[],
  configIds: readonly LlmMetricConfigId[],
): Partial<Record<LlmMetricConfigId, BenchmarkMcpClient>> {
  const clients: Partial<Record<LlmMetricConfigId, BenchmarkMcpClient>> = {};
  for (const configId of configIds) {
    clients[configId] = new DryRunMcpClient(buildDryRunToolDefinitions(tasks, configId));
  }
  return clients;
}

async function listAllTools(client: BenchmarkMcpClient): Promise<ToolDefinition[]> {
  const tools: ToolDefinition[] = [];
  let cursor: string | undefined;
  for (;;) {
    const response = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...response.tools);
    if (!response.nextCursor) break;
    cursor = response.nextCursor;
  }
  return tools;
}

function buildToolDefinitionsPaths(artifactRoot: string): Record<LlmMetricConfigId, string> {
  return {
    [RAW_CONFIG_ID]: path.join(artifactRoot, "raw-mcp", "tool-definitions.json"),
    [ADAPTED_CONFIG_ID]: path.join(artifactRoot, "mcpaql-adapted", "tool-definitions.json"),
  };
}

async function listSelectedTools(
  clients: Partial<Record<LlmMetricConfigId, BenchmarkMcpClient>>,
  configIds: readonly LlmMetricConfigId[],
): Promise<Partial<Record<LlmMetricConfigId, ToolDefinition[]>>> {
  const listed: Partial<Record<LlmMetricConfigId, ToolDefinition[]>> = {};
  for (const configId of configIds) {
    listed[configId] = await listAllTools(requireConfigValue(clients, configId, "MCP client"));
  }
  return listed;
}

async function buildAnthropicToolsByConfig(
  listedTools: Partial<Record<LlmMetricConfigId, ToolDefinition[]>>,
  configIds: readonly LlmMetricConfigId[],
): Promise<Partial<Record<LlmMetricConfigId, Array<Record<string, unknown>>>>> {
  const tools: Partial<Record<LlmMetricConfigId, Array<Record<string, unknown>>>> = {};
  for (const configId of configIds) {
    tools[configId] = toAnthropicTools(requireConfigValue(listedTools, configId, "tool definitions"));
  }
  return tools;
}

async function countToolDefinitionTokensByConfig(
  modelProvider: ModelProvider,
  model: string,
  systemPrompt: string,
  toolsByConfig: Partial<Record<LlmMetricConfigId, Array<Record<string, unknown>>>>,
  configIds: readonly LlmMetricConfigId[],
): Promise<Partial<Record<LlmMetricConfigId, number>>> {
  const counts: Partial<Record<LlmMetricConfigId, number>> = {};
  for (const configId of configIds) {
    counts[configId] = await modelProvider.countToolDefinitionTokens(
      model,
      systemPrompt,
      requireConfigValue(toolsByConfig, configId, "model tools"),
    );
  }
  return counts;
}

function requireConfigValue<T>(
  values: Partial<Record<LlmMetricConfigId, T>>,
  configId: LlmMetricConfigId,
  label: string,
): T {
  const value = values[configId];
  if (value === undefined) throw new Error(`Missing ${label} for selected configuration ${configId}.`);
  return value;
}

function assertToolCoverage(
  tasks: GitHubBenchmarkTask[],
  configId: LlmMetricConfigId,
  tools: ToolDefinition[],
): void {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  for (const task of tasks) {
    if (configId === RAW_CONFIG_ID) {
      const rawTool = byName.get(task.expectedFirstTool.rawMcp);
      if (!rawTool) throw new Error(`Raw MCP tool "${task.expectedFirstTool.rawMcp}" required by task "${task.id}" was not listed by the server.`);
      if (task.expectedRawMethod && !toolDefinitionContainsString(rawTool, task.expectedRawMethod)) {
        throw new Error(`Raw MCP tool "${rawTool.name}" for task "${task.id}" does not expose expected method/action "${task.expectedRawMethod}".`);
      }
      continue;
    }
    const adaptedTool = byName.get(task.expectedFirstTool.mcpaqlAdapted);
    if (!adaptedTool) throw new Error(`MCPAQL tool "${task.expectedFirstTool.mcpaqlAdapted}" required by task "${task.id}" was not listed by the adapter.`);
    if (!toolDefinitionContainsString(adaptedTool, task.expectedOperation)) {
      throw new Error(`MCPAQL tool "${adaptedTool.name}" for task "${task.id}" does not expose expected operation "${task.expectedOperation}".`);
    }
    if (task.expectedAdaptedMethod && !toolDefinitionContainsString(adaptedTool, task.expectedAdaptedMethod)) {
      throw new Error(`MCPAQL tool "${adaptedTool.name}" for task "${task.id}" does not expose expected method/action "${task.expectedAdaptedMethod}".`);
    }
  }
}

function toAnthropicTools(tools: ToolDefinition[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    name: tool.name,
    description: typeof tool.description === "string" ? tool.description : `MCP tool ${tool.name}`,
    input_schema: isRecord(tool.inputSchema) ? tool.inputSchema : { type: "object", additionalProperties: true },
  }));
}

function buildDryRunToolDefinitions(tasks: GitHubBenchmarkTask[], configId: LlmMetricConfigId): ToolDefinition[] {
  const byName = new Map<string, Set<string>>();
  const methodsByName = new Map<string, Set<string>>();
  for (const task of tasks) {
    const toolName = configId === RAW_CONFIG_ID ? task.expectedFirstTool.rawMcp : task.expectedFirstTool.mcpaqlAdapted;
    const operation = configId === RAW_CONFIG_ID ? undefined : task.expectedOperation;
    const method = configId === RAW_CONFIG_ID ? task.expectedRawMethod : task.expectedAdaptedMethod;
    if (!byName.has(toolName)) byName.set(toolName, new Set());
    if (!methodsByName.has(toolName)) methodsByName.set(toolName, new Set());
    if (operation) byName.get(toolName)?.add(operation);
    if (method) methodsByName.get(toolName)?.add(method);
  }
  return [...byName.entries()].map(([name, operations]) => {
    const methods = methodsByName.get(name) ?? new Set<string>();
    return {
      name,
      description: `Dry-run tool definition for ${name}.`,
      inputSchema: {
        type: "object",
        properties: {
          operation: operations.size > 0 ? { type: "string", enum: [...operations] } : { type: "string" },
          method: methods.size > 0 ? { type: "string", enum: [...methods] } : { type: "string" },
          action: methods.size > 0 ? { type: "string", enum: [...methods] } : { type: "string" },
          params: {
            type: "object",
            properties: {
              method: methods.size > 0 ? { type: "string", enum: [...methods] } : { type: "string" },
              action: methods.size > 0 ? { type: "string", enum: [...methods] } : { type: "string" },
            },
            additionalProperties: true,
          },
        },
        additionalProperties: true,
      },
    };
  });
}

function expectedFirstToolCall(task: GitHubBenchmarkTask, configId: LlmMetricConfigId): ToolCall {
  if (configId === RAW_CONFIG_ID) {
    return {
      id: `dry-${task.id}-raw`,
      name: task.expectedFirstTool.rawMcp,
      input: task.expectedRawMethod ? { method: task.expectedRawMethod } : {},
    };
  }
  const params: Record<string, unknown> = {};
  if (task.expectedAdaptedMethod) params.method = task.expectedAdaptedMethod;
  return {
    id: `dry-${task.id}-adapted`,
    name: task.expectedFirstTool.mcpaqlAdapted,
    input: { operation: task.expectedOperation, params },
  };
}

function isFirstCallSuccess(task: GitHubBenchmarkTask, configId: LlmMetricConfigId, call: ToolCall): boolean {
  if (configId === RAW_CONFIG_ID) {
    if (call.name !== task.expectedFirstTool.rawMcp) return false;
    return !task.expectedRawMethod || extractMethodArgument(call.input) === task.expectedRawMethod;
  }
  if (call.name !== task.expectedFirstTool.mcpaqlAdapted) return false;
  if (call.input.operation !== task.expectedOperation) return false;
  return !task.expectedAdaptedMethod || extractMethodArgument(call.input) === task.expectedAdaptedMethod;
}

function extractMethodArgument(input: Record<string, unknown>): string | undefined {
  for (const key of ["method", "action"]) {
    if (typeof input[key] === "string") return input[key] as string;
  }
  const params = input.params;
  if (isRecord(params)) {
    for (const key of ["method", "action"]) {
      if (typeof params[key] === "string") return params[key] as string;
    }
  }
  return undefined;
}

function extractToolCalls(content: Array<Record<string, unknown>>): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const block of content) {
    if (block.type !== "tool_use" || typeof block.id !== "string" || typeof block.name !== "string") continue;
    calls.push({
      id: block.id,
      name: block.name,
      input: isRecord(block.input) ? block.input : {},
    });
  }
  return calls;
}

function buildInjectedErrorResult(task: GitHubBenchmarkTask): McpToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `Injected benchmark error ${task.inducedError?.errorCode ?? "BAD_ARGUMENT"}: bad argument supplied. Retry with corrected arguments.`,
      },
    ],
  };
}

function buildInducedErrorMetric(
  task: GitHubBenchmarkTask,
  injected: boolean,
  recoveredWithinTwoTurns: boolean | null,
  turnsToRecovery: number | null,
): LlmTaskResult["inducedError"] {
  if (task.inducedError?.enabled !== true) return { injected: false, finalOutcome: "not_measured" };
  return {
    injected,
    recoveredWithinTwoTurns,
    turnsToRecovery: recoveredWithinTwoTurns ? turnsToRecovery : null,
    errorCode: task.inducedError.errorCode,
    finalOutcome: recoveredWithinTwoTurns === true ? "recovered" : recoveredWithinTwoTurns === false ? "gave_up" : "not_measured",
  };
}

function buildPromptVariables(
  task: GitHubBenchmarkTask,
  configId: LlmMetricConfigId,
  runIndex: number,
  runId: string,
  fixtureInput: FixtureInput | undefined,
  allocation: FixtureAllocation | undefined,
  dryRun: boolean,
): Record<string, string> {
  const values: Record<string, string> = {
    ...allowedPromptEnvVariables(),
    RUN_ID: runId,
    TASK_ID: task.id,
    CONFIG_ID: configId,
    RUN_INDEX: String(runIndex),
  };
  addVariables(values, fixtureInput?.variables);
  addVariables(values, allocation?.variables);
  if (dryRun) {
    for (const key of [
      "GITHUB_BENCHMARK_OWNER",
      "GITHUB_BENCHMARK_REPO",
      "GITHUB_BENCHMARK_ASSIGNEE",
      "GITHUB_BENCHMARK_REVIEWER",
      "FIXTURE_ISSUE_NUMBER",
      "FIXTURE_PULL_NUMBER",
      "FIXTURE_BRANCH",
      "FIXTURE_COMMIT_SHA",
      "FIXTURE_FILE_PATH",
      "FIXTURE_TAG",
    ]) {
      values[key] ??= `DRY_RUN_${key}`;
    }
  }
  return values;
}

function allowedPromptEnvVariables(): Record<string, string> {
  const values: Record<string, string> = {};
  for (const key of PROMPT_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (typeof value === "string") values[key] = value;
  }
  return values;
}

function addVariables(target: Record<string, string>, source: Record<string, unknown> | undefined): void {
  if (!source) return;
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      target[key] = String(value);
    }
  }
}

function stringEnvVariables(): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") values[key] = value;
  }
  return values;
}

function findFixtureAllocation(
  fixtureInput: FixtureInput | undefined,
  taskId: string,
  configId: LlmMetricConfigId,
  runIndex: number,
  requireExact: boolean,
): FixtureAllocation | undefined {
  const allocations = [...(fixtureInput?.allocations ?? []), ...(fixtureInput?.runs ?? [])];
  const exact = allocations.find((allocation) =>
    allocation.taskId === taskId &&
    allocation.configId === configId &&
    allocation.runIndex === runIndex
  );
  if (exact || !requireExact) {
    return exact ?? allocations.find((allocation) =>
      (!allocation.taskId || allocation.taskId === taskId) &&
      (!allocation.configId || allocation.configId === configId) &&
      (allocation.runIndex === undefined || allocation.runIndex === runIndex)
    );
  }
  throw new Error(`Mutable task "${taskId}" requires an exact fixture allocation for ${configId} run ${runIndex}.`);
}

function resolveCompletionVerifier(
  allocation: FixtureAllocation | undefined,
  configId: LlmMetricConfigId,
): FixtureCompletionVerifier | undefined {
  const verifier = allocation?.completionVerifier;
  if (!verifier) return undefined;
  if (isCompletionVerifier(verifier)) return verifier;
  if (isRecord(verifier)) {
    const configVerifier = verifier[configId];
    if (isCompletionVerifier(configVerifier)) return configVerifier;
  }
  return undefined;
}

function isCompletionVerifier(value: unknown): value is FixtureCompletionVerifier {
  return isRecord(value) && typeof value.toolName === "string" && value.toolName.length > 0;
}

function substitutePrompt(prompt: string, variables: Record<string, string>, dryRun: boolean): string {
  return prompt.replace(/\$\{([A-Z0-9_]+)\}/g, (match, key: string) => {
    if (variables[key] !== undefined) return variables[key];
    return dryRun ? `DRY_RUN_${key}` : match;
  });
}

function findUnresolvedPlaceholders(value: string): string[] {
  return [...value.matchAll(/\$\{([A-Z0-9_]+)\}/g)].map((match) => match[1]);
}

function buildConfigurations(
  artifactRoot: string,
  configIds: readonly LlmMetricConfigId[],
): LlmMetricConfiguration[] {
  const configurations: Record<LlmMetricConfigId, LlmMetricConfiguration> = {
    [RAW_CONFIG_ID]: {
      id: RAW_CONFIG_ID,
      label: "Raw GitHub MCP",
      description: "Raw GitHub MCP tool list exposed directly to the model.",
      server: {
        kind: "raw_mcp",
        name: "github-mcp",
        toolDefinitionsPath: path.join(artifactRoot, "raw-mcp", "tool-definitions.json"),
      },
    },
    [ADAPTED_CONFIG_ID]: {
      id: ADAPTED_CONFIG_ID,
      label: "MCPAQL-adapted GitHub MCP",
      description: "MCPAQL adapter endpoint tools over the GitHub MCP operation surface.",
      server: {
        kind: "mcpaql_adapter",
        adapterPath: process.env.MCPAQL_GITHUB_ADAPTER_SERVER,
        schemaPath: process.env.MCPAQL_GITHUB_ADAPTER_SCHEMA,
        provenancePath: process.env.MCPAQL_GITHUB_ADAPTER_PROVENANCE,
        toolDefinitionsPath: path.join(artifactRoot, "mcpaql-adapted", "tool-definitions.json"),
      },
    },
  };
  return configIds.map((configId) => configurations[configId]);
}

function buildSystemPrompt(): string {
  return [
    "You are running a controlled GitHub MCP benchmark against a disposable repository.",
    "Use the available MCP tools to complete the requested task.",
    "Make the most specific correct first tool call you can.",
    "Do not reveal secrets. Do not operate on repositories other than the repository named in the prompt.",
    "After the tool calls have completed the task, respond with a short final summary.",
  ].join("\n");
}

async function appendTranscript(filePath: string, event: Record<string, unknown>): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(deepRedact({ ...event, timestamp: new Date().toISOString() }))}\n`, "utf8");
}

function childEnv(): Record<string, string> {
  const env = stringEnvVariables();
  const token = requireEnv("GITHUB_PERSONAL_ACCESS_TOKEN");
  env.GITHUB_PERSONAL_ACCESS_TOKEN = token;
  env.GITHUB_TOKEN = token;
  env.GH_TOKEN = token;
  return env;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
}

function sanitizeFileStem(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function toolDefinitionContainsString(tool: ToolDefinition, expected: string): boolean {
  return containsString(tool.inputSchema, expected) || containsString(tool, expected);
}

function containsString(value: unknown, expected: string): boolean {
  if (typeof value === "string") return value === expected;
  if (Array.isArray(value)) return value.some((entry) => containsString(entry, expected));
  if (isRecord(value)) return Object.values(value).some((entry) => containsString(entry, expected));
  return false;
}

export function completionVerifierResultMatches(
  result: unknown,
  verifier: {
    expectedTextIncludes?: string;
    expectedTextExcludes?: string;
    expectedJsonMatches?: Array<{ path: string; value: unknown }>;
  },
): boolean {
  const resultText = JSON.stringify(result) ?? "";
  const textMatches = verifier.expectedTextIncludes ? resultText.includes(verifier.expectedTextIncludes) : true;
  const textExcludes = verifier.expectedTextExcludes ? !resultText.includes(verifier.expectedTextExcludes) : true;
  const jsonMatches = verifier.expectedJsonMatches
    ? verifier.expectedJsonMatches.every((expected) =>
      completionVerifierPayloadCandidates(result).some((candidate) =>
        readJsonPathValues(candidate, expected.path).some((value) => Object.is(value, expected.value))
      )
    )
    : true;
  return textMatches && textExcludes && jsonMatches;
}

export function completionVerifierResultIsError(result: unknown): boolean {
  return completionVerifierPayloadCandidates(result).some((candidate) => {
    if (!isRecord(candidate)) return false;
    return candidate.isError === true || candidate.is_error === true || candidate.success === false;
  });
}

function completionVerifierPayloadCandidates(value: unknown, depth = 0, candidates: unknown[] = []): unknown[] {
  if (depth > 5) return candidates;
  candidates.push(value);
  if (!isRecord(value)) return candidates;

  if ("structuredContent" in value) completionVerifierPayloadCandidates(value.structuredContent, depth + 1, candidates);
  if ("structured_content" in value) completionVerifierPayloadCandidates(value.structured_content, depth + 1, candidates);
  if ("data" in value) completionVerifierPayloadCandidates(value.data, depth + 1, candidates);

  const content = value.content;
  if (Array.isArray(content)) {
    for (const entry of content) {
      if (!isRecord(entry) || typeof entry.text !== "string") continue;
      candidates.push(entry.text);
      try {
        completionVerifierPayloadCandidates(JSON.parse(entry.text), depth + 1, candidates);
      } catch {
        // Plain text MCP content is still available to text-based verifiers.
      }
    }
  }
  return candidates;
}

function readJsonPathValues(value: unknown, pathExpression: string): unknown[] {
  let values = [value];
  for (const segment of pathExpression.split(".")) {
    const next: unknown[] = [];
    for (const candidate of values) {
      if (segment === "*") {
        if (Array.isArray(candidate)) next.push(...candidate);
        continue;
      }
      if (Array.isArray(candidate) && /^\d+$/.test(segment)) {
        next.push(candidate[Number(segment)]);
        continue;
      }
      if (isRecord(candidate) && segment in candidate) next.push(candidate[segment]);
    }
    values = next.filter((entry) => entry !== undefined);
  }
  return values;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function estimateTokens(value: unknown): number {
  return Math.max(1, Math.ceil(JSON.stringify(value).length / 4));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class DryRunMcpClient implements BenchmarkMcpClient {
  constructor(private readonly tools: ToolDefinition[]) {}

  async listTools(): Promise<{ tools: ToolDefinition[] }> {
    return { tools: this.tools };
  }

  async callTool(request: { name: string; arguments?: Record<string, unknown> }): Promise<McpToolResult> {
    return {
      isError: false,
      content: [{ type: "text", text: JSON.stringify({ dryRun: true, tool: request.name, arguments: request.arguments ?? {} }) }],
    };
  }

  async close(): Promise<void> {}
}

class DryRunModelProvider implements ModelProvider {
  async countToolDefinitionTokens(_model: string, _system: string, tools: Array<Record<string, unknown>>): Promise<number> {
    return estimateTokens(tools);
  }

  async createMessage(request: ModelRequest): Promise<ModelResponse> {
    const last = request.messages[request.messages.length - 1];
    const lastContent = last?.content;
    const sawToolResult = Array.isArray(lastContent) && lastContent.some((block) => isRecord(block) && block.type === "tool_result");
    const sawToolError = Array.isArray(lastContent) && lastContent.some((block) => isRecord(block) && block.type === "tool_result" && block.is_error === true);
    if (sawToolResult && !sawToolError) {
      return {
        content: [{ type: "text", text: "Dry-run task complete." }],
        usage: { inputTokens: estimateTokens(request.messages), outputTokens: 7 },
      };
    }
    const expected = request.expectedToolCall ?? { id: "dry-tool-use", name: "unknown_tool", input: {} };
    return {
      content: [{
        type: "tool_use",
        id: `${expected.id}-${request.messages.length}`,
        name: expected.name,
        input: expected.input,
      }],
      usage: { inputTokens: estimateTokens(request.messages) + estimateTokens(request.tools), outputTokens: 12 },
    };
  }
}

class AnthropicModelProvider implements ModelProvider {
  constructor(private readonly options: { apiKey: string; version: string }) {}

  async countToolDefinitionTokens(model: string, system: string, tools: Array<Record<string, unknown>>): Promise<number> {
    const baseline = await this.countTokens({ model, system, tools: [] });
    const withTools = await this.countTokens({ model, system, tools });
    return Math.max(0, withTools - baseline);
  }

  async createMessage(request: ModelRequest): Promise<ModelResponse> {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        model: request.model,
        max_tokens: request.maxTokens,
        temperature: request.temperature,
        system: request.system,
        messages: request.messages,
        tools: request.tools,
      }),
    });
    const body = await readAnthropicBody(response);
    const usage = isRecord(body.usage) ? body.usage : {};
    return {
      content: Array.isArray(body.content) ? body.content as Array<Record<string, unknown>> : [],
      usage: {
        inputTokens: numberValue(usage.input_tokens),
        outputTokens: numberValue(usage.output_tokens),
      },
    };
  }

  private async countTokens(request: { model: string; system: string; tools: Array<Record<string, unknown>> }): Promise<number> {
    const response = await fetch("https://api.anthropic.com/v1/messages/count_tokens", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        model: request.model,
        system: request.system,
        messages: [{ role: "user", content: "Count benchmark tool definitions." }],
        tools: request.tools,
      }),
    });
    const body = await readAnthropicBody(response);
    return numberValue(body.input_tokens);
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      "x-api-key": this.options.apiKey,
      "anthropic-version": this.options.version,
    };
  }
}

async function readAnthropicBody(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { text };
  }
  if (!response.ok) {
    throw new Error(`Anthropic API request failed with ${response.status}: ${JSON.stringify(deepRedact(body)).slice(0, 500)}`);
  }
  if (!isRecord(body)) throw new Error("Anthropic API returned a non-object response.");
  return body;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
