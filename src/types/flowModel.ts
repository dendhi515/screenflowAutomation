/**
 * The structured model produced by Stage 1 (flow analysis).
 * Every downstream stage (test data, test case generation, execution,
 * DML capture) consumes this — never the raw Flow XML directly.
 *
 * v3: full graph model. Every node carries a uniform `next: string[]` (every
 * apiName it could hand control to) so the graph can be walked/BFS'd
 * identically regardless of node kind. `FlowModel.paths` holds multiple
 * traversals — one base path plus one per non-default Decision outcome and
 * one per Loop at 1 iteration (branch coverage, not exhaustive path
 * coverage — see flowAnalyzer.ts `enumeratePaths`). Loop iteration modeling
 * only supports 0 or 1 iterations by design — see flowAnalyzer.ts `walkPath`.
 */

export type FlowType = "ScreenFlow"; // record-triggered support deferred per scope narrowing

/** A structured visibility/decision condition — this is NOT a free-text
 *  formula. Flow represents "Field B visible when Field A = X" as a
 *  discrete condition object, which is what makes this tractable without
 *  a general formula parser. */
export interface FlowCondition {
  /** API name of the field/resource/variable being compared. */
  leftValueReference: string;
  operator:
    | "EqualTo"
    | "NotEqualTo"
    | "IsNull"
    | "IsBlank"
    | "Contains"
    | "StartsWith"
    | "EndsWith"
    | "GreaterThan"
    | "GreaterThanOrEqualTo"
    | "LessThan"
    | "LessThanOrEqualTo"
    | string;
  rightValueLiteral?: string | number | boolean;
}

/** One or more conditions combined via `conditionLogic` ("1", "1 AND 2",
 *  "(1 AND 2) OR 3", or the literal strings "and"/"or"). Used both by a
 *  screen field's visibilityRule and by a Decision outcome's own rule —
 *  same shape, same evaluator (see stages/generate/conditionEvaluator.ts). */
export interface FlowConditionGroup {
  conditionLogic: string;
  conditions: FlowCondition[];
}

/** Alias kept so existing "visibilityRule" call sites/imports don't break. */
export type FlowVisibilityRule = FlowConditionGroup;

export type FlowFieldKind =
  | "Text"
  | "Number"
  | "Currency"
  | "Date"
  | "DateTime"
  | "Boolean"
  | "Dropdown"
  | "RadioButtons"
  | "MultiSelectPicklist"
  | "DisplayText"
  | "Email"
  | "Lookup"
  | "UnsupportedCustomComponent";

export interface FlowField {
  apiName: string;
  label: string;
  kind: FlowFieldKind;
  required: boolean;
  visibilityRule?: FlowVisibilityRule;
  /** Resolved against the flow's top-level <choices> resources — the raw
   *  <choiceReferences> in a field are just pointers to those resources by
   *  name, not the actual selectable values (see design doc addendum). */
  choices?: { apiName: string; label: string; value: string }[];
  /** Set when kind === "UnsupportedCustomComponent" — the raw component
   *  reference from the metadata, so a human can look it up. Design doc
   *  decision: flag and skip safely rather than guess at a generic fill. */
  unsupportedComponentName?: string;
  /** Set when kind === "Lookup" — the object the lookup searches, read from
   *  the component's own inputParameters (objectApiName), not guessed. */
  lookupObjectApiName?: string;
  /** Set when kind === "Lookup" and the component's own inputParameters
   *  configure a fieldApiName — the field the Lookup actually searches and
   *  displays by, which is not always the target object's standard Name
   *  field. Confirmed for real: a Lookup on RefreshPackage__FlowAutomate__c
   *  used fieldApiName="RefreshPackage__Account__c" because that object's
   *  own Name field is an autonumber (e.g. "A-0001"), not a human-searchable
   *  string — searching by Name there never matched anything real, while
   *  searching by this configured field (confirmed by manually testing the
   *  flow directly in Flow Builder) does. */
  lookupSearchFieldApiName?: string;
}

export interface FlowScreen {
  kind: "Screen";
  apiName: string;
  label: string;
  fields: FlowField[];
  allowBack: boolean;
  allowFinish: boolean;
  /** Element(s) this screen can navigate to next. Always length 1 for a
   *  screen (screens don't branch themselves — Decision elements do). */
  next: string[];
}

export type DmlOperation = "Insert" | "Update" | "Delete";

export interface FlowFieldAssignment {
  targetField: string;
  /** The flow resource (screen field API name or variable) whose value
   *  gets assigned — not a literal, since input values come from the user. */
  sourceReference: string;
}

export interface FlowDmlElement {
  kind: "RecordCreate" | "RecordUpdate" | "RecordDelete";
  apiName: string;
  operation: DmlOperation;
  objectApiName: string;
  assignments: FlowFieldAssignment[];
  next: string[];
}

/** One outcome ("rule" in the raw metadata) of a Decision element. Evaluated
 *  first-match-wins at runtime, but for our purposes (branch coverage /
 *  path enumeration) each outcome is just a named condition group with its
 *  own connector target. */
export interface FlowDecisionOutcome {
  apiName: string;
  label: string;
  conditionGroup: FlowConditionGroup;
  next: string;
}

export interface FlowDecision {
  kind: "Decision";
  apiName: string;
  label: string;
  outcomes: FlowDecisionOutcome[];
  defaultNext?: string;
  defaultLabel?: string;
  /** Every outcome's next plus defaultNext, deduped — for reachability BFS. */
  next: string[];
}

export interface FlowLoop {
  kind: "Loop";
  apiName: string;
  label: string;
  collectionReference: string;
  /** nextValueConnector — where the loop body starts. */
  nextValueTarget?: string;
  /** noMoreValuesConnector — where control goes once the loop exits. */
  noMoreValuesTarget?: string;
  next: string[];
}

export interface FlowSubflow {
  kind: "Subflow";
  apiName: string;
  label: string;
  /** <flowName> — the called flow's API name. Its internals (screens, DML,
   *  branching) are NOT analyzed — flagged in testPlanMarkdown instead of
   *  guessed at. See flowAnalyzer.ts / design decision on subflow scope. */
  calledFlowApiName: string;
  inputAssignments: FlowFieldAssignment[];
  next: string[];
}

export interface FlowRecordLookup {
  kind: "RecordLookup";
  apiName: string;
  label: string;
  objectApiName: string;
  /** Only set when storeOutputAutomatically is false — an explicitly named
   *  output variable. Its value is inherently org-data-dependent and can
   *  never be statically known by the evaluator (see conditionEvaluator.ts) —
   *  any condition depending on it resolves to `undefined`, not guessed. */
  outputVariable?: string;
  next: string[];
}

export interface FlowAssignmentItem {
  targetReference: string;
  /** "Assign" is the only operator the evaluator can reason about statically
   *  (a straight literal/reference copy). Anything else makes the target
   *  variable's value unknown going forward. */
  operator: string;
  value?:
    | { kind: "literal"; literal: string | number | boolean }
    | { kind: "elementReference"; reference: string };
}

export interface FlowAssignment {
  kind: "Assignment";
  apiName: string;
  label: string;
  assignmentItems: FlowAssignmentItem[];
  next: string[];
}

export type FlowGraphNode =
  | FlowScreen
  | FlowDmlElement
  | FlowDecision
  | FlowLoop
  | FlowSubflow
  | FlowRecordLookup
  | FlowAssignment;

/** One traversal of the graph from start to an end/unmodeled node.
 *  `id` is "base" for the default path, "<decisionApiName>__<outcomeApiName>"
 *  for a decision-branch path, or "<loopApiName>__1x" for a loop-iteration
 *  path — see flowAnalyzer.ts `enumeratePaths`. */
export interface FlowPath {
  id: string;
  description: string;
  nodes: FlowGraphNode[];
  /** decisionApiName -> outcomeApiName forced on this path (empty on "base"). */
  decisionOutcomeTaken: Record<string, string>;
  /** loopApiName -> iteration count forced on this path (0 or 1; empty on "base"). */
  loopIterationCounts: Record<string, number>;
}

export interface FlowModel {
  flowApiName: string;
  flowLabel: string;
  flowType: FlowType;
  sourcePath: string; // local file this was parsed from
  startElementApiName: string;
  /** All nodes reachable from start, keyed by their apiName. */
  nodes: Record<string, FlowGraphNode>;
  /** Every path generated for this flow — branch coverage, not exhaustive
   *  path coverage. Always has at least one entry ("base"). */
  paths: FlowPath[];
  /** Human-readable notes about things intentionally not analyzed (subflow
   *  internals, unsolvable decision outcomes, RecordLookup-dependent
   *  branches, etc.) — folded into testPlanMarkdown by the generator. */
  analysisNotes: string[];
}
