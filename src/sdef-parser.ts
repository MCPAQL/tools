/**
 * .sdef (Scripting Dictionary) XML parser for macOS application interrogation.
 *
 * Parses Apple's .sdef XML format into a normalized structure compatible with
 * the MCP-AQL discovery bundle format. This enables the interrogation pipeline
 * to work with native macOS applications in addition to MCP servers.
 *
 * References:
 * - Apple Scripting Definition File Format:
 *   https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/ScriptableCocoaApplications/SApps_about_apps/SAppsAboutApps.html
 * - .sdef schema: /System/Library/DTDs/sdef.dtd
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readFile } from "node:fs/promises";

import type {
  DangerLevel,
  DiscoveryParam,
  DiscoveryWarning,
  EndpointCategory,
  InferenceSource,
  NormalizedOperation,
} from "./types.js";
import { normalizeSnakeCase } from "./shared.js";

// --- SDEF XML types ---

/**
 * Parsed representation of an .sdef suite.
 */
export interface SdefSuite {
  name: string;
  code: string;
  description: string;
  classes: SdefClass[];
  commands: SdefCommand[];
  enumerations: SdefEnumeration[];
}

export interface SdefClass {
  name: string;
  code: string;
  description: string;
  plural: string;
  properties: SdefProperty[];
  elements: SdefElement[];
}

export interface SdefProperty {
  name: string;
  code: string;
  type: string;
  description: string;
  access: "r" | "w" | "rw";
}

export interface SdefElement {
  type: string;
  access: "r" | "w" | "rw";
}

export interface SdefCommand {
  name: string;
  code: string;
  description: string;
  directParameter?: SdefDirectParameter;
  parameters: SdefCommandParam[];
  result?: SdefCommandResult;
}

export interface SdefDirectParameter {
  type: string;
  description: string;
  optional: boolean;
}

export interface SdefCommandParam {
  name: string;
  code: string;
  type: string;
  description: string;
  optional: boolean;
}

export interface SdefCommandResult {
  type: string;
  description: string;
}

export interface SdefEnumeration {
  name: string;
  code: string;
  enumerators: Array<{ name: string; code: string; description: string }>;
}

/**
 * Result of parsing an .sdef file.
 */
export interface SdefParseResult {
  application: string;
  suites: SdefSuite[];
}

// --- Minimal XML parser (no dependencies) ---

interface XmlNode {
  tag: string;
  attributes: Record<string, string>;
  children: XmlNode[];
  text: string;
}

/**
 * Minimal XML parser sufficient for .sdef files.
 * Does NOT handle CDATA, processing instructions, namespaces, or entities beyond &amp;/&lt;/&gt;/&quot;.
 * This is intentionally limited to avoid external dependencies.
 */
function parseXml(xml: string): XmlNode {
  // Strip XML declaration and DOCTYPE
  const cleaned = xml
    .replace(/<\?xml[^?]*\?>/g, "")
    .replace(/<!DOCTYPE[^>]*>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();

  const root = parseElement(cleaned, 0);
  return root.node;
}

function parseElement(
  xml: string,
  pos: number,
): { node: XmlNode; endPos: number } {
  // Skip whitespace
  while (pos < xml.length && /\s/.test(xml[pos])) pos++;

  if (xml[pos] !== "<") {
    throw new Error(`Expected '<' at position ${pos}, got '${xml[pos]}'`);
  }

  pos++; // skip <
  const tagStart = pos;

  // Read tag name
  while (pos < xml.length && !/[\s/>]/.test(xml[pos])) pos++;
  const tag = xml.slice(tagStart, pos);

  // Read attributes
  const attributes: Record<string, string> = {};
  while (pos < xml.length) {
    while (pos < xml.length && /\s/.test(xml[pos])) pos++;

    if (xml[pos] === "/" && xml[pos + 1] === ">") {
      // Self-closing tag
      return { node: { tag, attributes, children: [], text: "" }, endPos: pos + 2 };
    }

    if (xml[pos] === ">") {
      pos++;
      break;
    }

    // Read attribute name
    const attrStart = pos;
    while (pos < xml.length && !/[=\s/>]/.test(xml[pos])) pos++;
    const attrName = xml.slice(attrStart, pos);

    while (pos < xml.length && /\s/.test(xml[pos])) pos++;

    if (xml[pos] === "=") {
      pos++;
      while (pos < xml.length && /\s/.test(xml[pos])) pos++;

      const quote = xml[pos];
      if (quote === '"' || quote === "'") {
        pos++;
        const valueStart = pos;
        while (pos < xml.length && xml[pos] !== quote) pos++;
        attributes[attrName] = decodeXmlEntities(xml.slice(valueStart, pos));
        pos++; // skip closing quote
      }
    } else {
      attributes[attrName] = "true";
    }
  }

  // Read children and text content
  const children: XmlNode[] = [];
  let text = "";

  while (pos < xml.length) {
    // Skip whitespace
    const textStart = pos;
    while (pos < xml.length && xml[pos] !== "<") pos++;
    const segment = xml.slice(textStart, pos).trim();
    if (segment) text += segment;

    if (pos >= xml.length) break;

    // Check for closing tag
    if (xml[pos] === "<" && xml[pos + 1] === "/") {
      // Skip </tag>
      pos += 2;
      while (pos < xml.length && xml[pos] !== ">") pos++;
      pos++; // skip >
      break;
    }

    // Parse child element
    const child = parseElement(xml, pos);
    children.push(child.node);
    pos = child.endPos;
  }

  return { node: { tag, attributes, children, text: decodeXmlEntities(text) }, endPos: pos };
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function findChildren(node: XmlNode, tag: string): XmlNode[] {
  return node.children.filter((child) => child.tag === tag);
}

function findChild(node: XmlNode, tag: string): XmlNode | undefined {
  return node.children.find((child) => child.tag === tag);
}

function attr(node: XmlNode, name: string, defaultValue = ""): string {
  return node.attributes[name] ?? defaultValue;
}

// --- SDEF parsing ---

function parseProperty(node: XmlNode): SdefProperty {
  const accessStr = attr(node, "access", "rw");
  const access = accessStr === "r" ? "r" : accessStr === "w" ? "w" : "rw";

  return {
    name: attr(node, "name"),
    code: attr(node, "code"),
    type: attr(node, "type", "text"),
    description: attr(node, "description"),
    access,
  };
}

function parseClassElement(node: XmlNode): SdefElement {
  const accessStr = attr(node, "access", "rw");
  return {
    type: attr(node, "type"),
    access: accessStr === "r" ? "r" : accessStr === "w" ? "w" : "rw",
  };
}

function parseClass(node: XmlNode): SdefClass {
  return {
    name: attr(node, "name"),
    code: attr(node, "code"),
    description: attr(node, "description"),
    plural: attr(node, "plural", attr(node, "name") + "s"),
    properties: findChildren(node, "property").map(parseProperty),
    elements: findChildren(node, "element").map(parseClassElement),
  };
}

function parseCommandParam(node: XmlNode): SdefCommandParam {
  return {
    name: attr(node, "name"),
    code: attr(node, "code"),
    type: attr(node, "type", "text"),
    description: attr(node, "description"),
    optional: attr(node, "optional") === "yes",
  };
}

function parseCommand(node: XmlNode): SdefCommand {
  const directParam = findChild(node, "direct-parameter");
  const result = findChild(node, "result");

  return {
    name: attr(node, "name"),
    code: attr(node, "code"),
    description: attr(node, "description"),
    directParameter: directParam
      ? {
          type: attr(directParam, "type", "specifier"),
          description: attr(directParam, "description"),
          optional: attr(directParam, "optional") === "yes",
        }
      : undefined,
    parameters: findChildren(node, "parameter").map(parseCommandParam),
    result: result
      ? {
          type: attr(result, "type", "any"),
          description: attr(result, "description"),
        }
      : undefined,
  };
}

function parseEnumeration(node: XmlNode): SdefEnumeration {
  return {
    name: attr(node, "name"),
    code: attr(node, "code"),
    enumerators: findChildren(node, "enumerator").map((e) => ({
      name: attr(e, "name"),
      code: attr(e, "code"),
      description: attr(e, "description"),
    })),
  };
}

function parseSuite(node: XmlNode): SdefSuite {
  return {
    name: attr(node, "name"),
    code: attr(node, "code"),
    description: attr(node, "description"),
    classes: findChildren(node, "class").concat(findChildren(node, "class-extension")).map(parseClass),
    commands: findChildren(node, "command").map(parseCommand),
    enumerations: findChildren(node, "enumeration").map(parseEnumeration),
  };
}

/**
 * Parse an .sdef XML file into a structured representation.
 */
export async function parseSdefFile(sdefPath: string): Promise<SdefParseResult> {
  const xml = await readFile(sdefPath, "utf8");
  return parseSdefXml(xml, sdefPath);
}

/**
 * Parse .sdef XML content into a structured representation.
 */
export function parseSdefXml(xml: string, source = "unknown"): SdefParseResult {
  const root = parseXml(xml);

  if (root.tag !== "dictionary") {
    throw new Error(`Expected root element 'dictionary', got '${root.tag}' in ${source}.`);
  }

  const application = attr(root, "title", source);
  const suites = findChildren(root, "suite").map(parseSuite);

  return { application, suites };
}

// --- CRUDE classification ---

/**
 * Classify an sdef command into a CRUDE endpoint.
 */
export function classifySdefCommand(command: SdefCommand): {
  endpoint: EndpointCategory;
  confidence: "high" | "medium" | "low";
  reviewReasons: string[];
} {
  const name = command.name.toLowerCase();
  const desc = command.description.toLowerCase();
  const reviewReasons: string[] = [];

  // Strong name-based signals
  if (name === "get" || name === "count" || name.startsWith("get ")) {
    return { endpoint: "READ", confidence: "high", reviewReasons };
  }

  if (name === "set" || name.startsWith("set ")) {
    return { endpoint: "UPDATE", confidence: "high", reviewReasons };
  }

  if (name === "make" || name === "create" || name.startsWith("make ")) {
    return { endpoint: "CREATE", confidence: "high", reviewReasons };
  }

  if (name === "delete" || name === "remove" || name.startsWith("delete ") || name.startsWith("remove ")) {
    return { endpoint: "DELETE", confidence: "high", reviewReasons };
  }

  if (name === "move" || name === "duplicate" || name === "copy") {
    reviewReasons.push(`Command '${command.name}' involves object manipulation.`);
    return { endpoint: "EXECUTE", confidence: "medium", reviewReasons };
  }

  // Description-based signals
  if (desc.includes("return") || desc.includes("get") || desc.includes("retrieve") || desc.includes("list")) {
    reviewReasons.push("Description suggests read behavior.");
    return { endpoint: "READ", confidence: "medium", reviewReasons };
  }

  if (desc.includes("create") || desc.includes("make") || desc.includes("new")) {
    reviewReasons.push("Description suggests creation behavior.");
    return { endpoint: "CREATE", confidence: "medium", reviewReasons };
  }

  if (desc.includes("modify") || desc.includes("change") || desc.includes("update") || desc.includes("set")) {
    reviewReasons.push("Description suggests update behavior.");
    return { endpoint: "UPDATE", confidence: "medium", reviewReasons };
  }

  if (desc.includes("delete") || desc.includes("remove") || desc.includes("destroy")) {
    reviewReasons.push("Description suggests destructive behavior.");
    return { endpoint: "DELETE", confidence: "medium", reviewReasons };
  }

  // Default to EXECUTE for unknown commands
  reviewReasons.push(`No strong semantic signal for command '${command.name}'; defaulting to EXECUTE.`);
  return { endpoint: "EXECUTE", confidence: "low", reviewReasons };
}

/**
 * Classify a class property access as a CRUD operation.
 */
function classifyPropertyAccess(
  className: string,
  property: SdefProperty,
): { readOp: NormalizedOperation | null; writeOp: NormalizedOperation | null } {
  const classSnake = normalizeSnakeCase(className);
  const propSnake = normalizeSnakeCase(property.name);

  const readOp: NormalizedOperation | null =
    property.access === "r" || property.access === "rw"
      ? {
          source_tool_name: `${className}.${property.name}`,
          operation_name: `get_${classSnake}_${propSnake}`,
          description: property.description || `Get ${property.name} of ${className}.`,
          endpoint: "READ",
          endpoint_confidence: "high",
          danger_level: "safe",
          needs_review: false,
          review_reasons: [],
          params: [
            {
              name: `${classSnake}_specifier`,
              original_name: `${classSnake}_specifier`,
              type: "string",
              required: true,
              description: `Specifier for the target ${className} (e.g., name or index).`,
              source_path: `sdef.class.${className}.property.${property.name}`,
            },
          ],
          maps_to: `native-applescript:get_property:${className}.${property.name}`,
          returns: {
            type: "object",
            name: "PropertyValue",
            description: `The ${property.name} of the ${className}.`,
          },
          provenance: {
            name: `${className}.${property.name}`,
            description: property.description || undefined,
            input_schema_present: true,
            inference_sources: {
              operation_name: "deterministic_normalization",
              endpoint: "heuristic_classification",
              danger_level: "heuristic_classification",
              maps_to: "deterministic_normalization",
            },
          },
        }
      : null;

  const writeOp: NormalizedOperation | null =
    property.access === "w" || property.access === "rw"
      ? {
          source_tool_name: `${className}.${property.name}`,
          operation_name: `set_${classSnake}_${propSnake}`,
          description: property.description
            ? `Set ${property.description.charAt(0).toLowerCase()}${property.description.slice(1)}`
            : `Set ${property.name} of ${className}.`,
          endpoint: "UPDATE",
          endpoint_confidence: "high",
          danger_level: "reversible",
          needs_review: false,
          review_reasons: [],
          params: [
            {
              name: `${classSnake}_specifier`,
              original_name: `${classSnake}_specifier`,
              type: "string",
              required: true,
              description: `Specifier for the target ${className}.`,
              source_path: `sdef.class.${className}.property.${property.name}`,
            },
            {
              name: "value",
              original_name: "value",
              type: mapSdefTypeToJsonType(property.type),
              required: true,
              description: `New value for ${property.name}.`,
              source_path: `sdef.class.${className}.property.${property.name}`,
            },
          ],
          maps_to: `native-applescript:set_property:${className}.${property.name}`,
          returns: {
            type: "object",
            name: "UpdateResult",
            description: `Result of setting ${property.name}.`,
          },
          provenance: {
            name: `${className}.${property.name}`,
            description: property.description || undefined,
            input_schema_present: true,
            inference_sources: {
              operation_name: "deterministic_normalization",
              endpoint: "heuristic_classification",
              danger_level: "heuristic_classification",
              maps_to: "deterministic_normalization",
            },
          },
        }
      : null;

  return { readOp, writeOp };
}

function mapSdefTypeToJsonType(sdefType: string): string {
  const typeMap: Record<string, string> = {
    text: "string",
    "Unicode text": "string",
    integer: "integer",
    real: "number",
    boolean: "boolean",
    date: "string",
    list: "array",
    record: "object",
    specifier: "string",
    any: "string",
    file: "string",
    "alias": "string",
    number: "number",
  };

  return typeMap[sdefType] ?? "string";
}

function classifyDanger(endpoint: EndpointCategory): DangerLevel {
  switch (endpoint) {
    case "READ":
      return "safe";
    case "CREATE":
    case "UPDATE":
      return "reversible";
    case "DELETE":
      return "destructive";
    case "EXECUTE":
      return "dangerous";
  }
}

/**
 * Convert an sdef command to a NormalizedOperation.
 */
function commandToOperation(
  command: SdefCommand,
  application: string,
  warnings: DiscoveryWarning[],
): NormalizedOperation {
  const { endpoint, confidence, reviewReasons } = classifySdefCommand(command);
  const operationName = normalizeSnakeCase(command.name);

  const params: DiscoveryParam[] = [];

  if (command.directParameter) {
    params.push({
      name: "target",
      original_name: "direct-parameter",
      type: mapSdefTypeToJsonType(command.directParameter.type),
      required: !command.directParameter.optional,
      description: command.directParameter.description || `The direct parameter.`,
      source_path: `sdef.command.${command.name}.direct-parameter`,
    });
  }

  for (const param of command.parameters) {
    const paramName = normalizeSnakeCase(param.name);
    params.push({
      name: paramName,
      original_name: param.name,
      type: mapSdefTypeToJsonType(param.type),
      required: !param.optional,
      description: param.description || `Parameter '${param.name}'.`,
      source_path: `sdef.command.${command.name}.parameter.${param.name}`,
    });

    if (paramName !== param.name) {
      warnings.push({
        code: "PARAM_NAME_NORMALIZED",
        severity: "info",
        message: `Parameter '${param.name}' was normalized to '${paramName}'.`,
        tool: command.name,
        field: param.name,
        heuristic: "snake_case_normalization",
      });
    }
  }

  for (const reason of reviewReasons) {
    warnings.push({
      code: "REVIEW_REQUIRED",
      severity: confidence === "low" ? "warning" : "info",
      message: reason,
      tool: command.name,
      heuristic: "endpoint_classification",
    });
  }

  const mapsTo = `native-applescript:command:${command.name}`;

  return {
    source_tool_name: command.name,
    operation_name: operationName,
    description: command.description || `Execute the '${command.name}' command in ${application}.`,
    endpoint,
    endpoint_confidence: confidence,
    danger_level: classifyDanger(endpoint),
    needs_review: reviewReasons.length > 0,
    review_reasons: reviewReasons,
    params,
    maps_to: mapsTo,
    returns: {
      type: "object",
      name: "NativeResult",
      description: command.result?.description ?? `Result of the '${command.name}' command.`,
    },
    provenance: {
      name: command.name,
      description: command.description || undefined,
      input_schema_present: params.length > 0,
      inference_sources: {
        operation_name: operationName === command.name ? "direct_source_metadata" : "deterministic_normalization",
        description: command.description ? "direct_source_metadata" : "heuristic_classification",
        endpoint: "heuristic_classification",
        danger_level: "heuristic_classification",
        maps_to: "deterministic_normalization",
      },
    },
  };
}

/**
 * Convert a parsed .sdef file into a discovery bundle's normalized operations.
 * This is the main entry point for the sdef interrogation pipeline.
 *
 * @param sdef - The parsed sdef structure
 * @param options - Configuration options
 * @returns Operations and warnings suitable for a DiscoveryBundle
 */
export function sdefToOperations(
  sdef: SdefParseResult,
  options?: {
    /** Include property-level get/set operations. Default: true */
    includeProperties?: boolean;
    /** Include class element listing operations. Default: true */
    includeElements?: boolean;
    /** Suites to include (by name). Default: all */
    suiteFilter?: string[];
  },
): {
  operations: NormalizedOperation[];
  warnings: DiscoveryWarning[];
} {
  const includeProperties = options?.includeProperties ?? true;
  const includeElements = options?.includeElements ?? true;
  const suiteFilter = options?.suiteFilter ? new Set(options.suiteFilter) : null;

  const operations: NormalizedOperation[] = [];
  const warnings: DiscoveryWarning[] = [];

  for (const suite of sdef.suites) {
    if (suiteFilter && !suiteFilter.has(suite.name)) {
      continue;
    }

    // Process commands
    for (const command of suite.commands) {
      operations.push(commandToOperation(command, sdef.application, warnings));
    }

    // Process classes
    for (const cls of suite.classes) {
      if (includeProperties) {
        for (const prop of cls.properties) {
          const { readOp, writeOp } = classifyPropertyAccess(cls.name, prop);
          if (readOp) operations.push(readOp);
          if (writeOp) operations.push(writeOp);
        }
      }

      if (includeElements) {
        for (const element of cls.elements) {
          const classSnake = normalizeSnakeCase(cls.name);
          const elementSnake = normalizeSnakeCase(element.type);

          operations.push({
            source_tool_name: `${cls.name}.${element.type}`,
            operation_name: `list_${classSnake}_${elementSnake}s`,
            description: `List ${element.type} elements of ${cls.name}.`,
            endpoint: "READ",
            endpoint_confidence: "high",
            danger_level: "safe",
            needs_review: false,
            review_reasons: [],
            params: [
              {
                name: `${classSnake}_specifier`,
                original_name: `${classSnake}_specifier`,
                type: "string",
                required: true,
                description: `Specifier for the target ${cls.name}.`,
                source_path: `sdef.class.${cls.name}.element.${element.type}`,
              },
            ],
            maps_to: `native-applescript:list_elements:${cls.name}.${element.type}`,
            returns: {
              type: "object",
              name: "ElementList",
              description: `List of ${element.type} elements.`,
            },
            provenance: {
              name: `${cls.name}.${element.type}`,
              input_schema_present: true,
              inference_sources: {
                operation_name: "deterministic_normalization",
                endpoint: "heuristic_classification",
                danger_level: "heuristic_classification",
                maps_to: "deterministic_normalization",
              },
            },
          });
        }
      }
    }
  }

  return { operations, warnings };
}
