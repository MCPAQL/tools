#!/usr/bin/env bash
set -euo pipefail

required_vars=(
  ANTHROPIC_API_KEY
  GITHUB_PERSONAL_ACCESS_TOKEN
  GITHUB_BENCHMARK_OWNER
  GITHUB_BENCHMARK_REPO
  GITHUB_BENCHMARK_ASSIGNEE
  GITHUB_BENCHMARK_REVIEWER
  MCPAQL_GITHUB_ADAPTER_SERVER
  MCPAQL_GITHUB_ADAPTER_SCHEMA
  MCPAQL_GITHUB_ADAPTER_PROVENANCE
  RAW_GITHUB_MCP_COMMAND
  GITHUB_TOOLSETS
)

missing=0

for name in "${required_vars[@]}"; do
  if [[ -n "${!name:-}" ]]; then
    printf '%s=set\n' "$name"
  else
    printf '%s=missing\n' "$name"
    missing=1
  fi
done

for path_var in MCPAQL_GITHUB_ADAPTER_SERVER MCPAQL_GITHUB_ADAPTER_SCHEMA MCPAQL_GITHUB_ADAPTER_PROVENANCE; do
  path_value="${!path_var:-}"
  if [[ -n "$path_value" && ! -f "$path_value" ]]; then
    printf '%s_path=missing_file:%s\n' "$path_var" "$path_value"
    missing=1
  fi
done

toolsets="${GITHUB_TOOLSETS:-}"
if [[ -n "$toolsets" && "$toolsets" != "all" ]]; then
  for required_toolset in default actions labels; do
    if [[ ",$toolsets," != *",$required_toolset,"* ]]; then
      printf 'GITHUB_TOOLSETS_missing=%s\n' "$required_toolset"
      missing=1
    fi
  done
fi

if [[ "$missing" -ne 0 ]]; then
  printf 'github-llm-benchmark-env=not-ready\n'
  exit 1
fi

printf 'github-llm-benchmark-env=ready\n'
