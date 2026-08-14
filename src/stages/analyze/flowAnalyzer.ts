import fs from "fs";
import path from "path";
import { XMLParser } from "fast-xml-parser";
import {
  FlowModel,
  FlowGraphNode,
  FlowScreen,
  FlowField,
  FlowFieldKind,
  FlowDmlElement,
  FlowFieldAssignment,
  FlowVisibilityRule,
  FlowCondition,
  DmlOperation,
} from "../../types/flowModel";

/**
 * Stage 1 — Flow analysis (design doc addendum: local-file pivot).
 * Reads a .flow-meta.xml file from disk and parses it into the FlowModel
 * graph. Deterministic parsing only — no LLM involvement here by design.
 *
 * Repeatable Flow elements (screens, fields, choices, conditions, ...)
 * collapse to a single object instead of an array in the XML when there's
 * only one occurrence — the isArray callback below forces the known
 * repeatable tag names to always parse as arrays, which is what makes this
 * reliable across flows of any size rather than just the example file.
 */

const REPEATABLE_TAGS = new Set([
  "screens",
  "fields",
  "recordCreates",
  "recordUpdates",
  "recordDeletes",
  "inputAssignments",
  "inputParameters",
  "choiceReferences",
  "choices",
  "conditions",
]);

/**
 * Salesforce's own standard screen components (Email, Lookup, Address,
 * Phone, Name, etc.) are serialized in Flow metadata identically to a
 * genuinely custom, user-built LWC — both are `fieldType: ComponentInstance`
 * with an `extensionName`. That's a real metadata quirk discovered against
 * an actual flow (RefreshPackage__Flow_test), not an assumption.
 *
 * We only whitelist the extensions we've actually implemented fill/assert
 * behavior for below. Anything else — including other flowruntime:*
 * components we haven't wired up yet, and true custom LWCs — still falls
 * through to UnsupportedCustomComponent rather than guessing. Extend this
 * map when a new flowruntime:* component needs real support.
 */
const KNOWN_FLOWRUNTIME_KINDS: Record<string, FlowFieldKind> = {
  "flowruntime:email": "Email",
  "flowruntime:lookup": "Lookup",
};

const parser = new XMLParser({
  ignoreAttributes: true,
  isArray: (tagName) => REPEATABLE_TAGS.has(tagName),
});

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function mapFieldKind(fieldType: string, dataType: string | undefined, extensionName: string | undefined): FlowFieldKind {
  switch (fieldType) {
    case "DropdownBox":
      return "Dropdown";
    case "RadioButtons":
      return "RadioButtons";
    case "MultiSelectPicklist":
    case "MultiSelectCheckboxes":
      return "MultiSelectPicklist";
    case "DisplayText":
      return "DisplayText";
    case "InputField":
      switch (dataType) {
        case "Number":
          return "Number";
        case "Currency":
          return "Currency";
        case "Date":
          return "Date";
        case "DateTime":
          return "DateTime";
        case "Boolean":
          return "Boolean";
        case "String":
        default:
          return "Text";
      }
    case "ComponentInstance": {
      const known = extensionName ? KNOWN_FLOWRUNTIME_KINDS[extensionName] : undefined;
      if (known) return known;
      // Design doc decision: flag unrecognized/custom component fields as
      // unsupported rather than guess at a generic fill strategy. Applies
      // equally to true custom LWCs and to flowruntime:* extensions we
      // haven't implemented support for yet.
      return "UnsupportedCustomComponent";
    }
    default:
      return "UnsupportedCustomComponent";
  }
}

function parseInputParameters(raw: any): Record<string, string> {
  const result: Record<string, string> = {};
  for (const p of asArray(raw.inputParameters)) {
    const literal = extractRightValueLiteral(p.value) ?? p.value?.elementReference;
    if (p.name && literal !== undefined) result[p.name] = String(literal);
  }
  return result;
}

function extractRightValueLiteral(rightValue: any): string | number | boolean | undefined {
  if (!rightValue) return undefined;
  if (rightValue.stringValue !== undefined) return String(rightValue.stringValue);
  if (rightValue.numberValue !== undefined) return Number(rightValue.numberValue);
  if (rightValue.booleanValue !== undefined) return String(rightValue.booleanValue) === "true";
  if (rightValue.dateValue !== undefined) return String(rightValue.dateValue);
  return undefined;
}

function parseVisibilityRule(raw: any): FlowVisibilityRule | undefined {
  if (!raw) return undefined;
  const conditions: FlowCondition[] = asArray(raw.conditions).map((c: any) => ({
    leftValueReference: c.leftValueReference,
    operator: c.operator,
    rightValueLiteral: extractRightValueLiteral(c.rightValue),
  }));
  if (conditions.length === 0) return undefined;
  return { conditionLogic: String(raw.conditionLogic ?? "1"), conditions };
}

type ChoiceMap = Map<string, { apiName: string; label: string; value: string }>;

function parseChoices(raw: any): ChoiceMap {
  const map: ChoiceMap = new Map();
  for (const c of asArray(raw.choices)) {
    const value = extractRightValueLiteral(c.value);
    map.set(c.name, { apiName: c.name, label: c.choiceText ?? c.name, value: value !== undefined ? String(value) : c.name });
  }
  return map;
}

/**
 * The outer <isRequired> tag on a screen field is NOT authoritative for
 * ComponentInstance (custom/standard LWC-backed, e.g. flowruntime:*)
 * fields. Confirmed against a real flow: Account and Email both had
 * <isRequired>true</isRequired>, but neither had a "Required" entry in
 * the component's own inputParameters, Flow Builder displayed "Required"
 * as blank for the Lookup component, and the running flow let Next
 * proceed with both fields blank. The component's own inputParameters is
 * what Builder shows and what the runtime actually enforces for these
 * fields — the outer flag looks like a leftover default. Standard field
 * types (InputField, DropdownBox, etc.) aren't affected — no evidence
 * their <isRequired> is unreliable, so it's left as the source of truth
 * there.
 */
function resolveRequired(raw: any, inputParams: Record<string, string>): boolean {
  const outerRequired = raw.isRequired === "true" || raw.isRequired === true;
  if (raw.fieldType !== "ComponentInstance") {
    return outerRequired;
  }
  const requiredParamKey = Object.keys(inputParams).find((k) => k.toLowerCase() === "required");
  if (requiredParamKey) {
    return inputParams[requiredParamKey].toLowerCase() === "true";
  }
  if (outerRequired) {
    console.warn(
      `Field "${raw.name}" (${raw.extensionName ?? "component"}) has <isRequired>true</isRequired> at the screen-field level, but no "Required" parameter configured on the component itself — treating as NOT required. This matches Builder's displayed state and observed runtime behavior for component-backed fields; the outer flag isn't reliable for these.`
    );
  }
  return false;
}

function parseField(raw: any, choices: ChoiceMap): FlowField {
  const kind = mapFieldKind(raw.fieldType, raw.dataType, raw.extensionName);
  const inputParams = parseInputParameters(raw);
  const choiceRefs = asArray<string>(raw.choiceReferences);
  const resolvedChoices = choiceRefs.map((ref) => {
    const resolved = choices.get(ref);
    if (!resolved) {
      console.warn(`Field ${raw.name} references choice "${ref}" which wasn't found in <choices> — using the reference name as a literal fallback.`);
      return { apiName: ref, label: ref, value: ref };
    }
    return resolved;
  });

  const field: FlowField = {
    apiName: raw.name,
    label: raw.fieldText ?? raw.name,
    kind,
    required: resolveRequired(raw, inputParams),
    visibilityRule: parseVisibilityRule(raw.visibilityRule),
    choices: resolvedChoices.length > 0 ? resolvedChoices : undefined,
  };
  if (kind === "UnsupportedCustomComponent") {
    field.unsupportedComponentName = raw.extensionName ?? raw.fieldType ?? "unknown";
  }
  if (kind === "Lookup") {
    field.lookupObjectApiName = inputParams.objectApiName;
    field.lookupSearchFieldApiName = inputParams.fieldApiName;
  }
  return field;
}

function parseScreen(raw: any, choices: ChoiceMap): FlowScreen {
  return {
    kind: "Screen",
    apiName: raw.name,
    label: raw.label ?? raw.name,
    fields: asArray(raw.fields).map((f: any) => parseField(f, choices)),
    allowBack: raw.allowBack === "true" || raw.allowBack === true,
    allowFinish: raw.allowFinish === "true" || raw.allowFinish === true,
    next: raw.connector?.targetReference ? [raw.connector.targetReference] : [],
  };
}

function parseDmlElement(raw: any, operation: DmlOperation, kind: FlowDmlElement["kind"]): FlowDmlElement {
  const assignments: FlowFieldAssignment[] = asArray(raw.inputAssignments).map((a: any) => ({
    targetField: a.field,
    sourceReference: a.value?.elementReference ?? "",
  }));
  return {
    kind,
    apiName: raw.name,
    operation,
    objectApiName: raw.object,
    assignments,
    next: raw.connector?.targetReference ? [raw.connector.targetReference] : [],
  };
}

/**
 * Reads and parses a .flow-meta.xml file from disk. The Flow's API name is
 * derived from the filename (Salesforce convention: <ApiName>.flow-meta.xml)
 * since the metadata body itself doesn't carry its own API name.
 */
export function analyzeFlowFromFile(filePath: string): FlowModel {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Flow file not found: ${resolved}`);
  }

  const xml = fs.readFileSync(resolved, "utf-8");
  const parsed = parser.parse(xml);
  const raw = parsed.Flow;
  if (!raw) {
    throw new Error(`${resolved} does not look like a Flow metadata file (no <Flow> root element).`);
  }

  const flowApiName = path.basename(resolved).replace(/\.flow-meta\.xml$/, "");

  const choices = parseChoices(raw);

  const nodes: Record<string, FlowGraphNode> = {};
  for (const s of asArray(raw.screens)) {
    const screen = parseScreen(s, choices);
    nodes[screen.apiName] = screen;
  }
  for (const rc of asArray(raw.recordCreates)) {
    const el = parseDmlElement(rc, "Insert", "RecordCreate");
    nodes[el.apiName] = el;
  }
  for (const ru of asArray(raw.recordUpdates)) {
    const el = parseDmlElement(ru, "Update", "RecordUpdate");
    nodes[el.apiName] = el;
  }
  for (const rd of asArray(raw.recordDeletes)) {
    const el = parseDmlElement(rd, "Delete", "RecordDelete");
    nodes[el.apiName] = el;
  }

  const startElementApiName: string = raw.start?.connector?.targetReference;
  if (!startElementApiName) {
    throw new Error(`${resolved}: could not find a start element / connector.`);
  }

  // Walk the graph from start. v1 scope has no Decision elements, so every
  // node has at most one outgoing connector — this produces a single linear
  // path. The moment a node has multiple `next` targets (a Decision), this
  // loop is the exact place branching support gets added later.
  const path_: FlowGraphNode[] = [];
  const visited = new Set<string>();
  let currentApiName: string | undefined = startElementApiName;
  while (currentApiName && !visited.has(currentApiName)) {
    const node: FlowGraphNode | undefined = nodes[currentApiName];
    if (!node) break; // reached an element type not modeled yet (e.g. Decision) — stop rather than guess
    visited.add(currentApiName);
    path_.push(node);
    currentApiName = node.next[0];
  }

  return {
    flowApiName,
    flowLabel: raw.label ?? flowApiName,
    flowType: "ScreenFlow",
    sourcePath: resolved,
    startElementApiName,
    nodes,
    path: path_,
  };
}
