/**
 * The structured model produced by Stage 1 (flow analysis).
 * Every downstream stage (test data, test case generation, execution,
 * DML capture) consumes this — never the raw Flow XML directly.
 *
 * v2: modeled as a graph traversed from `start`, not a flat ordered list.
 * Document order in the XML has no guaranteed relationship to runtime
 * order once branching exists — see design doc addendum on the local-file
 * pivot. v1 scope only ever produces a linear path (no Decision elements
 * yet), but the graph shape is correct from the start so branching is an
 * incremental addition later, not a rewrite.
 */

export type FlowType = "ScreenFlow"; // record-triggered support deferred per scope narrowing

/** A structured visibility/decision condition — this is NOT a free-text
 *  formula. Flow represents "Field B visible when Field A = X" as a
 *  discrete condition object, which is what makes this tractable without
 *  a general formula parser. */
export interface FlowCondition {
  /** API name of the field/resource/variable being compared. */
  leftValueReference: string;
  operator: "EqualTo" | "NotEqualTo" | "IsNull" | "IsBlank" | "Contains" | string;
  rightValueLiteral?: string | number | boolean;
}

export interface FlowVisibilityRule {
  /** e.g. "1", "1 AND 2", "and", "or" — how conditions combine. */
  conditionLogic: string;
  conditions: FlowCondition[];
}

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

export type FlowGraphNode = FlowScreen | FlowDmlElement;

export interface FlowModel {
  flowApiName: string;
  flowLabel: string;
  flowType: FlowType;
  sourcePath: string; // local file this was parsed from
  startElementApiName: string;
  /** All nodes reachable from start, keyed by their apiName. */
  nodes: Record<string, FlowGraphNode>;
  /** Nodes in traversal order from start — for v1 (no Decision elements)
   *  this is the single linear path; becomes one-of-many paths once
   *  Decision/branch support is added. */
  path: FlowGraphNode[];
}
