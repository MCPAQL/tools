export type * from "./parity/types.js";
export type * from "./parity/llm-metrics.js";
export type { NormalizeOptions } from "./parity/comparison.js";

export { runParitySuite } from "./parity/runner.js";
export { resolveAdapterPaths } from "./parity/metadata.js";
export {
  buildLlmMetricsReport,
  computeLlmMetricAggregates,
  LLM_METRIC_CONFIG_IDS,
  LLM_METRICS_REPORT_KIND,
  LLM_METRICS_REPORT_SCHEMA,
  LLM_METRICS_REPORT_SCHEMA_VERSION,
  loadLlmMetricsInput,
  renderLlmMetricsMarkdownSummary,
  writeLlmMetricsMarkdownSummary,
  writeLlmMetricsReport,
} from "./parity/llm-metrics.js";
export {
  canonicalize,
  classify,
  extractMcpaqlPayload,
  extractOfficialPayload,
  firstDiff,
  maskVariantTokens,
  normalize,
} from "./parity/comparison.js";
export {
  applyParamMappings,
  isExpectedVerifyResult,
  resolveUpstreamToolName,
} from "./parity/operation.js";
