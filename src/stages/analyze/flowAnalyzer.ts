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
  FlowConditionGroup,
  FlowCondition,
  FlowDecision,
  FlowDecisionOutcome,
  FlowLoop,
  FlowSubflow,
  FlowRecordLookup,
  FlowAssignment,
  FlowAssignmentItem,
  FlowPath,
  DmlOperation,
} from "../../types/flowModel";

/**
 * Stage 1 — Flow analysis (full graph rebuild).
 * Reads a .flow-meta.xml file from disk and parses it into the FlowModel
 * graph. Deterministic parsing only — no LLM involvement here by design.
 *
 * Every node kind carries a uniform `next: string[]` (every apiName it could
 * hand control to), so the graph can be BFS'd/walked identically regardless
 * of whether it's a Screen, Decision, Loop, Subflow, RecordLookup, or
 * Assignment. `FlowModel.paths` holds multiple traversals — branch coverage
 * (one base path, one per non-default Decision outcome, one per Loop at 1
 * iteration), not exhaustive path/cartesian coverage — see `enumeratePaths`.
 *
 * Repeatable Flow elements (screens, fields, choices, conditions, rules,
 * ...) collapse to a single object instead of an array in the XML when
 * there's only one occurrence — the isArray callback below forces the known
 * repeatable tag names to always parse as arrays.
 */

const REPEATABLE_TAGS = new Set([
  "screens",
  "fields",
  "recordCreates",
  "recordUpdates",
  "recordDeletes",
  "decisions",
  "rules",
  "loops",
  "subflows",
  "recordLookups",
  "assignments",
  "assignmentItems",
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

/** Shared by field visibilityRule AND Decision outcome ("rule") parsing —
 *  both are just a {conditionLogic, conditions} group in the raw metadata. */
function parseConditionGroup(raw: any): FlowConditionGroup | undefined {
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
    visibilityRule: parseConditionGroup(raw.visibilityRule),
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

function parseDmlAssignments(raw: any): FlowFieldAssignment[] {
  return asArray(raw.inputAssignments).map((a: any) => ({
    targetField: a.field,
    sourceReference: a.value?.elementReference ?? "",
  }));
}

function parseDmlElement(raw: any, operation: DmlOperation, kind: FlowDmlElement["kind"]): FlowDmlElement {
  return {
    kind,
    apiName: raw.name,
    operation,
    objectApiName: raw.object,
    assignments: parseDmlAssignments(raw),
    next: raw.connector?.targetReference ? [raw.connector.targetReference] : [],
  };
}

function parseDecisionOutcome(raw: any): FlowDecisionOutcome | undefined {
  const conditionGroup = parseConditionGroup(raw);
  const next = raw.connector?.targetReference;
  if (!conditionGroup || !next) return undefined; // no conditions or no route — can't use this outcome, skip rather than guess
  return { apiName: raw.name, label: raw.label ?? raw.name, conditionGroup, next };
}

function parseDecision(raw: any): FlowDecision {
  const outcomes = asArray(raw.rules)
    .map(parseDecisionOutcome)
    .filter((o): o is FlowDecisionOutcome => Boolean(o));
  const defaultNext: string | undefined = raw.defaultConnector?.targetReference;
  const next = [...new Set([...outcomes.map((o) => o.next), ...(defaultNext ? [defaultNext] : [])])];
  return {
    kind: "Decision",
    apiName: raw.name,
    label: raw.label ?? raw.name,
    outcomes,
    defaultNext,
    defaultLabel: raw.defaultConnectorLabel,
    next,
  };
}

function parseLoop(raw: any): FlowLoop {
  const nextValueTarget: string | undefined = raw.nextValueConnector?.targetReference;
  const noMoreValuesTarget: string | undefined = raw.noMoreValuesConnector?.targetReference;
  const next = [nextValueTarget, noMoreValuesTarget].filter((v): v is string => Boolean(v));
  return {
    kind: "Loop",
    apiName: raw.name,
    label: raw.label ?? raw.name,
    collectionReference: raw.collectionReference,
    nextValueTarget,
    noMoreValuesTarget,
    next,
  };
}

function parseSubflowInputAssignments(raw: any): FlowFieldAssignment[] {
  // Subflow <inputAssignments> use <name>, not <field> like recordCreates'
  // inputAssignments do — a real, confirmed metadata-shape difference
  // between the two, not an oversight.
  return asArray(raw.inputAssignments).map((a: any) => ({
    targetField: a.name,
    sourceReference: String(extractRightValueLiteral(a.value) ?? a.value?.elementReference ?? ""),
  }));
}

function parseSubflow(raw: any): FlowSubflow {
  return {
    kind: "Subflow",
    apiName: raw.name,
    label: raw.label ?? raw.name,
    calledFlowApiName: raw.flowName,
    inputAssignments: parseSubflowInputAssignments(raw),
    next: raw.connector?.targetReference ? [raw.connector.targetReference] : [],
  };
}

function parseRecordLookup(raw: any): FlowRecordLookup {
  const storeAuto = raw.storeOutputAutomatically === "true" || raw.storeOutputAutomatically === true;
  // outputReference is only meaningful (and only present) when the lookup's
  // result isn't stored automatically into an SObject-typed variable — see
  // FlowRecordLookup.outputVariable doc comment on why this can never be
  // statically evaluated by the condition evaluator regardless.
  const outputVariable = !storeAuto && raw.outputReference ? String(raw.outputReference) : undefined;
  return {
    kind: "RecordLookup",
    apiName: raw.name,
    label: raw.label ?? raw.name,
    objectApiName: raw.object,
    outputVariable,
    next: raw.connector?.targetReference ? [raw.connector.targetReference] : [],
  };
}

function parseAssignmentValue(raw: any): FlowAssignmentItem["value"] {
  if (!raw) return undefined;
  if (raw.elementReference !== undefined) return { kind: "elementReference", reference: String(raw.elementReference) };
  const literal = extractRightValueLiteral(raw);
  if (literal !== undefined) return { kind: "literal", literal };
  return undefined;
}

function parseAssignmentItem(raw: any): FlowAssignmentItem {
  return { targetReference: raw.assignToReference, operator: raw.operator, value: parseAssignmentValue(raw.value) };
}

function parseAssignment(raw: any): FlowAssignment {
  return {
    kind: "Assignment",
    apiName: raw.name,
    label: raw.label ?? raw.name,
    assignmentItems: asArray(raw.assignmentItems).map(parseAssignmentItem),
    next: raw.connector?.targetReference ? [raw.connector.targetReference] : [],
  };
}

/** Every node kind exposes a uniform `next: string[]`, so the graph can be
 *  BFS'd identically regardless of kind. Stops (and records a note) at any
 *  apiName that isn't a modeled element — an unsupported Flow element type —
 *  rather than guessing what it does. */
export function computeReachableNodes(nodes: Record<string, FlowGraphNode>, start: string, notes: string[] = []): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [start];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = nodes[id];
    if (!node) {
      notes.push(
        `Reached "${id}" which isn't a modeled Flow element type — traversal stops there rather than guessing what it does. If this is unexpected, that element type needs a parser added.`
      );
      continue;
    }
    for (const n of node.next) if (!seen.has(n)) queue.push(n);
  }
  return seen;
}

export interface WalkOverrides {
  /** decisionApiName -> outcomeApiName to force at that decision; anything
   *  not listed here takes its defaultNext. */
  decisionOutcome?: Map<string, string>;
  /** loopApiName -> desired iteration count. Only 0 (default, if absent) and
   *  1 are correctly supported — see the visit-count comment below. */
  loopIterations?: Map<string, number>;
}

function nextTarget(node: FlowGraphNode, apiName: string, overrides: WalkOverrides, visitCountSoFar: number): string | undefined {
  switch (node.kind) {
    case "Decision": {
      const forced = overrides.decisionOutcome?.get(apiName);
      if (forced) {
        const outcome = node.outcomes.find((o) => o.apiName === forced);
        if (outcome) return outcome.next;
        // Forced an outcome name that doesn't exist on this decision —
        // defensive fallback to default rather than throwing mid-walk.
      }
      return node.defaultNext;
    }
    case "Loop": {
      const desired = overrides.loopIterations?.get(apiName) ?? 0;
      return visitCountSoFar <= desired ? node.nextValueTarget : node.noMoreValuesTarget;
    }
    default:
      return node.next[0];
  }
}

/**
 * Walks the graph from `startApiName`, producing one linear node sequence.
 * Shared by deterministic path enumeration (`enumeratePaths`) and later by
 * LLM-scenario compilation, which can pass multi-entry overrides to combine
 * several decisions/loops into one custom path without needing a second
 * algorithm.
 *
 * Loop iteration modeling only correctly supports 0 or 1 iterations: a node
 * not covered by an override gets a visit cap of exactly 1 (the cycle
 * guard), and an overridden loop gets `iterations + 1` visits to itself
 * (the extra visit is the one that finally takes the exit connector). For
 * `iterations = 1`, every node structurally inside the loop body is walked
 * exactly once before control returns to the loop node for its exit check,
 * so the blanket visit cap of 1 for non-loop nodes is correct at this
 * scope. Supporting iterations >= 2 would require a separate loop-body-
 * membership analysis to know which nodes to relax the cap for — real,
 * deliberately deferred work, not needed for 0-vs-1-iteration coverage.
 */
export function walkPath(nodes: Record<string, FlowGraphNode>, startApiName: string, overrides: WalkOverrides, maxSteps = 1000): FlowGraphNode[] {
  const result: FlowGraphNode[] = [];
  const visitCount = new Map<string, number>();
  let current: string | undefined = startApiName;
  let steps = 0;

  while (current && steps++ < maxSteps) {
    const node = nodes[current];
    if (!node) break; // unmodeled element type — stop, same as computeReachableNodes

    const isOverriddenLoop = node.kind === "Loop" && overrides.loopIterations?.has(current);
    const maxAllowedVisits = isOverriddenLoop ? overrides.loopIterations!.get(current)! + 1 : 1;

    const countSoFar = (visitCount.get(current) ?? 0) + 1;
    if (countSoFar > maxAllowedVisits) break; // natural loop exit, or a real cycle we refuse to keep walking
    visitCount.set(current, countSoFar);
    result.push(node);

    current = nextTarget(node, current, overrides, countSoFar);
  }
  return result;
}

/**
 * Branch coverage, not exhaustive path/cartesian coverage: one base path
 * (every decision at default, every loop at 0 iterations), plus one path
 * per non-default Decision outcome (holding every other decision at
 * default) and one path per Loop at 1 iteration. This is linear in the
 * number of outcomes/loops rather than multiplicative — full cartesian
 * coverage of N decisions with M outcomes each explodes fast and mostly
 * re-covers branches already individually exercised. Scenarios genuinely
 * needing two decisions in specific states *simultaneously* are handled by
 * LLM-proposed scenarios passing a multi-entry override straight into
 * `walkPath` (see scenarioCompiler.ts) — deterministic coverage stays
 * cheap, combinatorial cases are opt-in.
 */
export function enumeratePaths(nodes: Record<string, FlowGraphNode>, start: string, maxPaths = 50, notes: string[] = []): FlowPath[] {
  const reachable = computeReachableNodes(nodes, start, notes);
  const paths: FlowPath[] = [];

  const baseNodes = walkPath(nodes, start, {});
  paths.push({
    id: "base",
    description: "Default path — every decision at its default outcome, every loop at 0 iterations",
    nodes: baseNodes,
    decisionOutcomeTaken: {},
    loopIterationCounts: {},
  });
  const seenSequences = new Set<string>([baseNodes.map((n) => n.apiName).join(">")]);

  outer: for (const apiName of reachable) {
    const node = nodes[apiName];
    if (!node) continue;

    if (node.kind === "Decision") {
      for (const outcome of node.outcomes) {
        if (paths.length >= maxPaths) {
          notes.push(`enumeratePaths: hit maxPaths cap (${maxPaths}) — some decision/loop branches were not enumerated.`);
          break outer;
        }
        const nodesForPath = walkPath(nodes, start, { decisionOutcome: new Map([[apiName, outcome.apiName]]) });
        const sig = nodesForPath.map((n) => n.apiName).join(">");
        if (seenSequences.has(sig)) continue; // identical resulting path — redundant, skip
        seenSequences.add(sig);
        paths.push({
          id: `${apiName}__${outcome.apiName}`,
          description: `Decision "${node.label}" takes outcome "${outcome.label}"`,
          nodes: nodesForPath,
          decisionOutcomeTaken: { [apiName]: outcome.apiName },
          loopIterationCounts: {},
        });
      }
    } else if (node.kind === "Loop") {
      if (paths.length >= maxPaths) {
        notes.push(`enumeratePaths: hit maxPaths cap (${maxPaths}) — some decision/loop branches were not enumerated.`);
        break;
      }
      const nodesForPath = walkPath(nodes, start, { loopIterations: new Map([[apiName, 1]]) });
      const sig = nodesForPath.map((n) => n.apiName).join(">");
      if (seenSequences.has(sig)) continue;
      seenSequences.add(sig);
      paths.push({
        id: `${apiName}__1x`,
        description: `Loop "${node.label}" runs 1 iteration`,
        nodes: nodesForPath,
        decisionOutcomeTaken: {},
        loopIterationCounts: { [apiName]: 1 },
      });
    }
  }

  return paths;
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
  const analysisNotes: string[] = [];

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
  for (const d of asArray(raw.decisions)) {
    const el = parseDecision(d);
    nodes[el.apiName] = el;
  }
  for (const l of asArray(raw.loops)) {
    const el = parseLoop(l);
    nodes[el.apiName] = el;
  }
  for (const sf of asArray(raw.subflows)) {
    const el = parseSubflow(sf);
    nodes[el.apiName] = el;
    // Subflow internals (its screens, DML, branching) aren't analyzed —
    // flag-and-skip is a deliberate scope decision, not an oversight. See
    // flowModel.ts FlowSubflow doc comment.
    analysisNotes.push(`Subflow "${el.label}" calls "${el.calledFlowApiName}" — not analyzed here; add manual test coverage for it separately.`);
  }
  for (const rl of asArray(raw.recordLookups)) {
    const el = parseRecordLookup(rl);
    nodes[el.apiName] = el;
  }
  for (const a of asArray(raw.assignments)) {
    const el = parseAssignment(a);
    nodes[el.apiName] = el;
  }

  const startElementApiName: string = raw.start?.connector?.targetReference;
  if (!startElementApiName) {
    throw new Error(`${resolved}: could not find a start element / connector.`);
  }

  const paths = enumeratePaths(nodes, startElementApiName, 50, analysisNotes);

  return {
    flowApiName,
    flowLabel: raw.label ?? flowApiName,
    flowType: "ScreenFlow",
    sourcePath: resolved,
    startElementApiName,
    nodes,
    paths,
    analysisNotes,
  };
}
