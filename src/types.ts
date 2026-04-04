export type EndpointCategory = "CREATE" | "READ" | "UPDATE" | "DELETE" | "EXECUTE";

export type DangerLevel = "safe" | "reversible" | "destructive" | "dangerous" | "forbidden";

export type InferenceSource =
  | "direct_source_metadata"
  | "deterministic_normalization"
  | "heuristic_classification"
  | "manual_override";

export interface InterrogationConfig {
  name: string;
  server_url: string;
  transport: {
    type: "streamable_http";
  };
  auth?: {
    type: "bearer";
    token_env?: string;
    token_command?: string;
    header?: string;
    prefix?: string;
  };
  headers?: Record<string, string>;
  sample_operations?: Array<{
    tool: string;
    arguments?: Record<string, unknown>;
  }>;
}

export interface DiscoveryWarning {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  tool?: string;
  field?: string;
  heuristic?: string;
}

export interface DiscoveryParam {
  name: string;
  original_name: string;
  type: string;
  required: boolean;
  description?: string;
  default?: unknown;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  pattern?: string;
  format?: string;
  source_path: string;
}

export interface NormalizedOperation {
  source_tool_name: string;
  operation_name: string;
  title?: string;
  description: string;
  endpoint: EndpointCategory;
  endpoint_confidence: "high" | "medium" | "low";
  danger_level: DangerLevel;
  needs_review: boolean;
  review_reasons: string[];
  params: DiscoveryParam[];
  maps_to: string;
  returns: {
    type: "object";
    name: "WrappedToolResult";
    description: string;
  };
  provenance: {
    name: string;
    description?: string;
    annotations?: string[];
    input_schema_present: boolean;
    inference_sources?: {
      operation_name?: InferenceSource;
      description?: InferenceSource;
      endpoint?: InferenceSource;
      danger_level?: InferenceSource;
      maps_to?: InferenceSource;
    };
  };
}

export interface DiscoveryBundle {
  schema_version: "1.0.0-draft";
  source: {
    name: string;
    server_url: string;
    transport: "streamable_http" | "native-applescript";
    captured_at: string;
    server: {
      name?: string;
      version?: string;
      title?: string;
    };
    auth: {
      type: "bearer" | "none";
      header?: string;
      prefix?: string;
      token_env?: string;
      token_command?: string;
    };
    capture_config_redacted: Record<string, unknown>;
  };
  raw_capture: {
    tools: unknown[];
    [key: string]: unknown;
  };
  normalized_bundle: {
    operations: NormalizedOperation[];
    warnings: DiscoveryWarning[];
  };
}

export interface DiffOperationResult {
  operation: string;
  endpoint_match: boolean;
  parameter_names_match: boolean;
  missing_parameters: string[];
  extra_parameters: string[];
}

export interface DifferentialReport {
  summary: {
    source_operation_count: number;
    adapter_operation_count: number;
    missing_operations: string[];
    extra_operations: string[];
    notes?: string[];
  };
  operations: DiffOperationResult[];
}

export interface ConformanceReport {
  passed: boolean;
  checks: Array<{
    name: string;
    passed: boolean;
    detail: string;
  }>;
}
