import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { writeJsonFile } from "../shared.js";

export const LLM_METRICS_REPORT_SCHEMA_VERSION = "mcpaql.llm-metrics.v1";
export const LLM_METRICS_REPORT_KIND = "mcpaql-llm-metrics";
export const LLM_METRIC_CONFIG_IDS = ["raw_mcp", "mcpaql_adapted"] as const;

export type LlmMetricConfigId = typeof LLM_METRIC_CONFIG_IDS[number];
export type LlmTaskOutcome = "completed" | "failed" | "gave_up" | "skipped" | "error";
export type LlmRecoveryOutcome = "recovered" | "gave_up" | "compounded_error" | "not_measured";

export interface LlmModelMetadata {
  provider: string;
  model: string;
  version?: string;
  apiVersion?: string;
  temperature?: number;
  maxTokens?: number;
  extra?: Record<string, unknown>;
}

export interface LlmMetricConfiguration {
  id: LlmMetricConfigId;
  label: string;
  description?: string;
  server?: {
    kind?: "raw_mcp" | "mcpaql_adapter" | string;
    name?: string;
    version?: string;
    url?: string;
    adapterPath?: string;
    schemaPath?: string;
    provenancePath?: string;
    toolDefinitionsPath?: string;
  };
}

export interface LlmTokenUsage {
  prompt?: number;
  completion?: number;
  toolDefinitions?: number;
  total: number;
}

export interface LlmInducedErrorResult {
  injected: boolean;
  recoveredWithinTwoTurns?: boolean | null;
  turnsToRecovery?: number | null;
  errorCode?: string;
  finalOutcome?: LlmRecoveryOutcome;
}

export interface LlmRawDataPaths {
  transcripts?: string[];
  logs?: string[];
  prompts?: string[];
  toolDefinitions?: string[];
  fixtures?: string[];
  other?: string[];
}

export interface LlmTaskResult {
  taskId: string;
  taskName?: string;
  configId: LlmMetricConfigId;
  outcome: LlmTaskOutcome;
  firstCallSuccess?: boolean | null;
  turnsToCompletion?: number | null;
  tokensToCompletion?: LlmTokenUsage | null;
  inducedError?: LlmInducedErrorResult | null;
  rawDataPaths?: LlmRawDataPaths;
  startedAt?: string;
  finishedAt?: string;
  notes?: string;
}

export interface CountRateMetric {
  successCount: number;
  measuredCount: number;
  rate: number | null;
}

export interface AverageMetric {
  measuredCount: number;
  total: number;
  average: number | null;
}

export interface LlmRecoveryAggregate {
  injectedTaskCount: number;
  measuredCount: number;
  recoveredWithinTwoTurnsCount: number;
  rate: number | null;
}

export interface LlmMetricAggregate {
  configId: LlmMetricConfigId;
  taskCount: number;
  completedTaskCount: number;
  firstCallSuccess: CountRateMetric;
  turnsToCompletion: AverageMetric;
  tokensToCompletion: AverageMetric;
  inducedErrorRecovery: LlmRecoveryAggregate;
}

export interface LlmMetricsReport {
  schemaVersion: typeof LLM_METRICS_REPORT_SCHEMA_VERSION;
  reportKind: typeof LLM_METRICS_REPORT_KIND;
  suite: string;
  label?: string;
  generatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  model: LlmModelMetadata;
  configurations: LlmMetricConfiguration[];
  rawDataPaths?: LlmRawDataPaths;
  parityReportPath?: string;
  taskResults: LlmTaskResult[];
  aggregates: LlmMetricAggregate[];
  notes?: string;
}

export type LlmMetricsReportInput = Omit<LlmMetricsReport, "schemaVersion" | "reportKind" | "generatedAt" | "aggregates"> & {
  schemaVersion?: string;
  reportKind?: string;
  generatedAt?: string;
  aggregates?: LlmMetricAggregate[];
};

export const LLM_METRICS_REPORT_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://mcpaql.dev/schemas/llm-metrics-report.schema.json",
  title: "MCPAQL LLM metrics report",
  type: "object",
  required: ["schemaVersion", "reportKind", "suite", "generatedAt", "model", "configurations", "taskResults", "aggregates"],
  additionalProperties: false,
  properties: {
    schemaVersion: { const: LLM_METRICS_REPORT_SCHEMA_VERSION },
    reportKind: { const: LLM_METRICS_REPORT_KIND },
    suite: { type: "string", minLength: 1 },
    label: { type: "string" },
    generatedAt: { type: "string", minLength: 1 },
    startedAt: { type: "string" },
    finishedAt: { type: "string" },
    model: {
      type: "object",
      required: ["provider", "model"],
      additionalProperties: true,
      properties: {
        provider: { type: "string", minLength: 1 },
        model: { type: "string", minLength: 1 },
        version: { type: "string" },
        apiVersion: { type: "string" },
        temperature: { type: "number" },
        maxTokens: { type: "number" },
        extra: { type: "object", additionalProperties: true },
      },
    },
    configurations: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["id", "label"],
        additionalProperties: true,
        properties: {
          id: { enum: LLM_METRIC_CONFIG_IDS },
          label: { type: "string", minLength: 1 },
          description: { type: "string" },
          server: { type: "object", additionalProperties: true },
        },
      },
    },
    rawDataPaths: { $ref: "#/definitions/rawDataPaths" },
    parityReportPath: { type: "string" },
    taskResults: {
      type: "array",
      items: {
        type: "object",
        required: ["taskId", "configId", "outcome"],
        additionalProperties: false,
        properties: {
          taskId: { type: "string", minLength: 1 },
          taskName: { type: "string" },
          configId: { enum: LLM_METRIC_CONFIG_IDS },
          outcome: { enum: ["completed", "failed", "gave_up", "skipped", "error"] },
          firstCallSuccess: { type: ["boolean", "null"] },
          turnsToCompletion: { type: ["number", "null"], minimum: 0 },
          tokensToCompletion: {
            anyOf: [
              { type: "null" },
              {
                type: "object",
                required: ["total"],
                additionalProperties: false,
                properties: {
                  prompt: { type: "number", minimum: 0 },
                  completion: { type: "number", minimum: 0 },
                  toolDefinitions: { type: "number", minimum: 0 },
                  total: { type: "number", minimum: 0 },
                },
              },
            ],
          },
          inducedError: {
            anyOf: [
              { type: "null" },
              {
                type: "object",
                required: ["injected"],
                additionalProperties: false,
                properties: {
                  injected: { type: "boolean" },
                  recoveredWithinTwoTurns: { type: ["boolean", "null"] },
                  turnsToRecovery: { type: ["number", "null"], minimum: 0 },
                  errorCode: { type: "string" },
                  finalOutcome: { enum: ["recovered", "gave_up", "compounded_error", "not_measured"] },
                },
              },
            ],
          },
          rawDataPaths: { $ref: "#/definitions/rawDataPaths" },
          startedAt: { type: "string" },
          finishedAt: { type: "string" },
          notes: { type: "string" },
        },
      },
    },
    aggregates: {
      type: "array",
      items: {
        type: "object",
        required: [
          "configId",
          "taskCount",
          "completedTaskCount",
          "firstCallSuccess",
          "turnsToCompletion",
          "tokensToCompletion",
          "inducedErrorRecovery",
        ],
        additionalProperties: false,
        properties: {
          configId: { enum: LLM_METRIC_CONFIG_IDS },
          taskCount: { type: "number", minimum: 0 },
          completedTaskCount: { type: "number", minimum: 0 },
          firstCallSuccess: { $ref: "#/definitions/countRateMetric" },
          turnsToCompletion: { $ref: "#/definitions/averageMetric" },
          tokensToCompletion: { $ref: "#/definitions/averageMetric" },
          inducedErrorRecovery: {
            type: "object",
            required: ["injectedTaskCount", "measuredCount", "recoveredWithinTwoTurnsCount", "rate"],
            additionalProperties: false,
            properties: {
              injectedTaskCount: { type: "number", minimum: 0 },
              measuredCount: { type: "number", minimum: 0 },
              recoveredWithinTwoTurnsCount: { type: "number", minimum: 0 },
              rate: { type: ["number", "null"], minimum: 0, maximum: 1 },
            },
          },
        },
      },
    },
    notes: { type: "string" },
  },
  definitions: {
    rawDataPaths: {
      type: "object",
      additionalProperties: false,
      properties: {
        transcripts: { type: "array", items: { type: "string" } },
        logs: { type: "array", items: { type: "string" } },
        prompts: { type: "array", items: { type: "string" } },
        toolDefinitions: { type: "array", items: { type: "string" } },
        fixtures: { type: "array", items: { type: "string" } },
        other: { type: "array", items: { type: "string" } },
      },
    },
    countRateMetric: {
      type: "object",
      required: ["successCount", "measuredCount", "rate"],
      additionalProperties: false,
      properties: {
        successCount: { type: "number", minimum: 0 },
        measuredCount: { type: "number", minimum: 0 },
        rate: { type: ["number", "null"], minimum: 0, maximum: 1 },
      },
    },
    averageMetric: {
      type: "object",
      required: ["measuredCount", "total", "average"],
      additionalProperties: false,
      properties: {
        measuredCount: { type: "number", minimum: 0 },
        total: { type: "number", minimum: 0 },
        average: { type: ["number", "null"], minimum: 0 },
      },
    },
  },
} as const;

export function buildLlmMetricsReport(input: LlmMetricsReportInput): LlmMetricsReport {
  validateTaskConfigurations(input.configurations, input.taskResults);

  return {
    ...input,
    schemaVersion: LLM_METRICS_REPORT_SCHEMA_VERSION,
    reportKind: LLM_METRICS_REPORT_KIND,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    taskResults: input.taskResults,
    aggregates: computeLlmMetricAggregates(input.configurations, input.taskResults),
  };
}

export function computeLlmMetricAggregates(
  configurations: LlmMetricConfiguration[],
  taskResults: LlmTaskResult[],
): LlmMetricAggregate[] {
  return configurations.map((configuration) => {
    const tasks = taskResults.filter((task) => task.configId === configuration.id);
    const completedTaskCount = tasks.filter((task) => task.outcome === "completed").length;
    const firstCallResults = tasks
      .map((task) => task.firstCallSuccess)
      .filter((value): value is boolean => typeof value === "boolean");
    const turnResults = tasks
      .map((task) => task.turnsToCompletion)
      .filter(isFiniteNumber);
    const tokenResults = tasks
      .map((task) => task.tokensToCompletion?.total)
      .filter(isFiniteNumber);
    const injectedErrorTasks = tasks.filter((task) => task.inducedError?.injected === true);
    const measuredRecoveryTasks = injectedErrorTasks.filter((task) => typeof task.inducedError?.recoveredWithinTwoTurns === "boolean");
    const recoveredWithinTwoTurnsCount = measuredRecoveryTasks
      .filter((task) => task.inducedError?.recoveredWithinTwoTurns === true)
      .length;

    return {
      configId: configuration.id,
      taskCount: tasks.length,
      completedTaskCount,
      firstCallSuccess: buildCountRate(
        firstCallResults.filter((value) => value).length,
        firstCallResults.length,
      ),
      turnsToCompletion: buildAverage(turnResults),
      tokensToCompletion: buildAverage(tokenResults),
      inducedErrorRecovery: {
        injectedTaskCount: injectedErrorTasks.length,
        measuredCount: measuredRecoveryTasks.length,
        recoveredWithinTwoTurnsCount,
        rate: rate(recoveredWithinTwoTurnsCount, measuredRecoveryTasks.length),
      },
    };
  });
}

export async function loadLlmMetricsInput(inputPath: string): Promise<LlmMetricsReportInput> {
  return JSON.parse(await readFile(inputPath, "utf8")) as LlmMetricsReportInput;
}

export async function writeLlmMetricsReport(
  reportPath: string,
  input: LlmMetricsReportInput | LlmMetricsReport,
): Promise<LlmMetricsReport> {
  const report = buildLlmMetricsReport(input);
  await writeJsonFile(reportPath, report);
  return report;
}

export async function writeLlmMetricsMarkdownSummary(
  summaryPath: string,
  report: LlmMetricsReport,
): Promise<void> {
  await mkdir(path.dirname(summaryPath), { recursive: true });
  await writeFile(summaryPath, renderLlmMetricsMarkdownSummary(report), "utf8");
}

export function renderLlmMetricsMarkdownSummary(report: LlmMetricsReport): string {
  const lines: string[] = [];
  lines.push(`# LLM Correctness Metrics: ${report.suite}`);
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  if (report.label) lines.push(`Label: ${report.label}`);
  lines.push(`Model: ${formatModel(report.model)}`);
  if (report.parityReportPath) lines.push(`Parity report: \`${report.parityReportPath}\``);
  lines.push("");
  lines.push("> This report summarizes recorded harness data only. Missing task metrics are shown as n/a and should not be treated as benchmark evidence.");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Configuration | Tasks | Completed | First-call success | Avg turns | Avg tokens | Induced-error recovery |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const aggregate of report.aggregates) {
    const configuration = report.configurations.find((entry) => entry.id === aggregate.configId);
    lines.push([
      configuration?.label ?? aggregate.configId,
      String(aggregate.taskCount),
      String(aggregate.completedTaskCount),
      formatRate(aggregate.firstCallSuccess.rate, aggregate.firstCallSuccess.successCount, aggregate.firstCallSuccess.measuredCount),
      formatNullableNumber(aggregate.turnsToCompletion.average),
      formatNullableNumber(aggregate.tokensToCompletion.average),
      formatRate(
        aggregate.inducedErrorRecovery.rate,
        aggregate.inducedErrorRecovery.recoveredWithinTwoTurnsCount,
        aggregate.inducedErrorRecovery.measuredCount,
      ),
    ].join(" | ").replace(/^/, "| ").replace(/$/, " |"));
  }

  lines.push("");
  lines.push("## Task Results");
  lines.push("");
  if (report.taskResults.length === 0) {
    lines.push("No task-level benchmark data recorded.");
  } else {
    lines.push("| Task | Configuration | Outcome | First call | Turns | Tokens | Recovery | Raw data |");
    lines.push("| --- | --- | --- | ---: | ---: | ---: | --- | --- |");
    for (const task of report.taskResults) {
      const configuration = report.configurations.find((entry) => entry.id === task.configId);
      lines.push([
        task.taskName ?? task.taskId,
        configuration?.label ?? task.configId,
        task.outcome,
        formatBoolean(task.firstCallSuccess),
        formatNullableNumber(task.turnsToCompletion),
        formatNullableNumber(task.tokensToCompletion?.total),
        formatRecovery(task.inducedError),
        formatRawDataPaths(task.rawDataPaths),
      ].join(" | ").replace(/^/, "| ").replace(/$/, " |"));
    }
  }

  const rawData = formatRawDataPaths(report.rawDataPaths);
  if (rawData !== "n/a") {
    lines.push("");
    lines.push("## Raw Data");
    lines.push("");
    lines.push(rawData);
  }

  if (report.notes) {
    lines.push("");
    lines.push("## Notes");
    lines.push("");
    lines.push(report.notes);
  }

  lines.push("");
  return lines.join("\n");
}

function validateTaskConfigurations(
  configurations: LlmMetricConfiguration[],
  taskResults: LlmTaskResult[],
): void {
  const configIds = new Set(configurations.map((configuration) => configuration.id));
  for (const task of taskResults) {
    if (!configIds.has(task.configId)) {
      throw new Error(`Task "${task.taskId}" references unknown LLM metrics configuration "${task.configId}".`);
    }
  }
}

function buildCountRate(successCount: number, measuredCount: number): CountRateMetric {
  return {
    successCount,
    measuredCount,
    rate: rate(successCount, measuredCount),
  };
}

function buildAverage(values: number[]): AverageMetric {
  const total = roundMetric(values.reduce((sum, value) => sum + value, 0));
  return {
    measuredCount: values.length,
    total,
    average: values.length === 0 ? null : roundMetric(total / values.length),
  };
}

function rate(successCount: number, measuredCount: number): number | null {
  return measuredCount === 0 ? null : roundMetric(successCount / measuredCount);
}

function roundMetric(value: number): number {
  return Number(value.toFixed(6));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function formatModel(model: LlmModelMetadata): string {
  const parts = [`${model.provider}/${model.model}`];
  if (model.version) parts.push(`version ${model.version}`);
  if (model.apiVersion) parts.push(`API ${model.apiVersion}`);
  return parts.join(", ");
}

function formatRate(value: number | null, numerator: number, denominator: number): string {
  if (value === null) return "n/a";
  return `${(value * 100).toFixed(1)}% (${numerator}/${denominator})`;
}

function formatNullableNumber(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "n/a";
}

function formatBoolean(value: boolean | null | undefined): string {
  if (value === true) return "yes";
  if (value === false) return "no";
  return "n/a";
}

function formatRecovery(inducedError: LlmInducedErrorResult | null | undefined): string {
  if (!inducedError?.injected) return "n/a";
  if (inducedError.recoveredWithinTwoTurns === true) return "recovered within 2 turns";
  if (inducedError.recoveredWithinTwoTurns === false) return inducedError.finalOutcome ?? "not recovered";
  return "not measured";
}

function formatRawDataPaths(paths: LlmRawDataPaths | undefined): string {
  if (!paths) return "n/a";
  const entries = (Object.entries(paths) as Array<[string, string[] | undefined]>)
    .flatMap(([kind, values]) => (values ?? []).map((value) => `${kind}: \`${value}\``));
  return entries.length === 0 ? "n/a" : entries.join("<br>");
}
