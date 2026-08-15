/** Output of Stage 2 (test data + test case generation). */

export type ExpectedAssertionType =
  | "FieldPresent"
  | "FieldAbsent"
  | "FieldRequiredEnforced"
  | "FieldValueEquals"
  | "RecordFieldEquals";

export interface FieldInput {
  apiName: string;
  /** How the executor should find the field in the rendered screen — kept
   *  as label text / API name, not a CSS path (design doc Section 4.4). */
  locatorLabel: string;
  value: string | number | boolean;
  isBoundaryOrInvalid: boolean;
  /** "Fill" (default) types/checks the value directly. "LookupSelect" types
   *  the value as a search term into a lookup field and clicks the first
   *  matching result — there's no literal value to set on a lookup, only a
   *  search term, and whether a match exists depends on real data in the
   *  target org (see screenFlowExecutor.ts). */
  interactionKind?: "Fill" | "LookupSelect";
  /** Set when interactionKind === "LookupSelect" — the object the lookup
   *  searches (from the flow's own component config, see flowModel.ts
   *  FlowField.lookupObjectApiName). The executor queries a real record
   *  from this object and searches by its actual Name, rather than typing
   *  a generic guess and hoping something matches. */
  lookupObjectApiName?: string;
  /** Set when interactionKind === "LookupSelect" and the flow's own Lookup
   *  component configures a fieldApiName — the field to actually search and
   *  display by, which isn't always the target object's standard Name field
   *  (see FlowField.lookupSearchFieldApiName in flowModel.ts). */
  lookupSearchFieldApiName?: string;
}

export interface ExpectedAssertion {
  type: ExpectedAssertionType;
  targetApiName: string;
  /** The rendered label Playwright should actually search for — Salesforce
   *  renders field labels, not API names, so locating by targetApiName
   *  alone would never match anything. */
  targetLabel: string;
  expectedValue?: string | number | boolean;
  description: string;
  /** Set only for RecordFieldEquals — the object the DML element that should
   *  produce this record targets, so recordAssertionReconciler.ts can match
   *  it against capturedRecords without re-deriving it from the flow graph. */
  objectApiName?: string;
}

export interface ScreenTestStep {
  screenApiName: string;
  inputs: FieldInput[];
  assertions: ExpectedAssertion[];
}

export interface TestCase {
  id: string;
  description: string;
  /** Only populated for screen flows. */
  steps?: ScreenTestStep[];
  /** Only populated for record-triggered flows — Anonymous Apex body. */
  anonymousApex?: string;
  /** Which path (flowModel.paths[].id) this case was generated against —
   *  absent for cases not tied to a specific path (shouldn't normally happen). */
  pathId?: string;
  /** Whether this case came from the deterministic structural generator or
   *  was proposed by the LLM and compiled/validated on top of it. */
  scenarioSource: "deterministic" | "llm";
}

export interface TestSpec {
  flowApiName: string;
  flowType: "ScreenFlow";
  generatedBy: "deterministic" | "deterministic+llm";
  testPlanMarkdown: string; // human-readable Gherkin/BDD plan for QA/business review
  testCases: TestCase[];
}
