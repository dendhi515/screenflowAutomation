import { FlowModel, FlowScreen, FlowDecision, FlowLoop, FlowDmlElement } from "../../../types/flowModel";

/**
 * Shared across every LlmScenarioProvider implementation (claudeProvider.ts,
 * groqProvider.ts, ...) — the condensed flow view, prompt, and response
 * schema are provider-agnostic. Only the request/response mechanics (which
 * SDK or fetch call, which structured-output mode, error handling for that
 * provider's SDK) belong in the provider-specific files.
 */

/** Hard size gate — skip the call entirely rather than send an enormous,
 *  slow, expensive request for a very large flow. Deterministic coverage
 *  still runs regardless. */
export const MAX_CONDENSED_FIELDS = 200;

interface CondensedField {
  apiName: string;
  label: string;
  kind: string;
  required: boolean;
  visibilityRule?: { conditionLogic: string; conditions: string[] };
  choices?: string[];
}

interface CondensedScreen {
  apiName: string;
  label: string;
  fields: CondensedField[];
}

interface CondensedDecision {
  apiName: string;
  label: string;
  outcomes: { apiName: string; label: string; conditionLogic: string; conditions: string[] }[];
  hasDefaultOutcome: boolean;
}

interface CondensedLoop {
  apiName: string;
  label: string;
  collectionReference: string;
}

interface CondensedDmlElement {
  apiName: string;
  operation: string;
  objectApiName: string;
  assignedFields: string[];
}

export interface CondensedFlowModel {
  flowApiName: string;
  flowLabel: string;
  screens: CondensedScreen[];
  decisions: CondensedDecision[];
  loops: CondensedLoop[];
  dmlElements: CondensedDmlElement[];
  paths: { id: string; description: string }[];
  notes: string[];
}

function condenseCondition(c: { leftValueReference: string; operator: string; rightValueLiteral?: string | number | boolean }): string {
  return `${c.leftValueReference} ${c.operator} ${c.rightValueLiteral ?? ""}`.trim();
}

export function condenseFlowModel(flowModel: FlowModel): CondensedFlowModel {
  const nodes = Object.values(flowModel.nodes);

  const screens: CondensedScreen[] = nodes
    .filter((n): n is FlowScreen => n.kind === "Screen")
    .map((s) => ({
      apiName: s.apiName,
      label: s.label,
      fields: s.fields.map((f) => ({
        apiName: f.apiName,
        label: f.label,
        kind: f.kind,
        required: f.required,
        visibilityRule: f.visibilityRule
          ? { conditionLogic: f.visibilityRule.conditionLogic, conditions: f.visibilityRule.conditions.map(condenseCondition) }
          : undefined,
        choices: f.choices?.map((c) => c.value),
      })),
    }));

  const decisions: CondensedDecision[] = nodes
    .filter((n): n is FlowDecision => n.kind === "Decision")
    .map((d) => ({
      apiName: d.apiName,
      label: d.label,
      outcomes: d.outcomes.map((o) => ({
        apiName: o.apiName,
        label: o.label,
        conditionLogic: o.conditionGroup.conditionLogic,
        conditions: o.conditionGroup.conditions.map(condenseCondition),
      })),
      hasDefaultOutcome: Boolean(d.defaultNext),
    }));

  const loops: CondensedLoop[] = nodes
    .filter((n): n is FlowLoop => n.kind === "Loop")
    .map((l) => ({ apiName: l.apiName, label: l.label, collectionReference: l.collectionReference }));

  const dmlElements: CondensedDmlElement[] = nodes
    .filter((n): n is FlowDmlElement => n.kind === "RecordCreate" || n.kind === "RecordUpdate" || n.kind === "RecordDelete")
    .map((d) => ({ apiName: d.apiName, operation: d.operation, objectApiName: d.objectApiName, assignedFields: d.assignments.map((a) => a.targetField) }));

  return {
    flowApiName: flowModel.flowApiName,
    flowLabel: flowModel.flowLabel,
    screens,
    decisions,
    loops,
    dmlElements,
    paths: flowModel.paths.map((p) => ({ id: p.id, description: p.description })),
    notes: flowModel.analysisNotes,
  };
}

export const SYSTEM_PROMPT = `You are assisting a Salesforce Screen Flow test-generation pipeline. You will be given a condensed structural model of a Flow (screens, fields, decisions, loops, DML) and a list of apiNames already covered by deterministic test generation.

Propose ADDITIONAL test scenarios a QA engineer would want that the deterministic pass would not think of — especially:
- Newly-added or unusual fields worth double-checking (required-ness, data type, interaction with other fields).
- Business-logic edge cases implied by field labels, choice values, or decision conditions.
- Data-type boundary conditions beyond generic empty/negative checks (e.g. max-length text, malformed email, far-future dates).

Rules:
- Never propose a scenario whose targetApiName is already in coveredTargets.
- Every apiName, choice value, and outcome name you reference MUST come verbatim from the provided model. Never invent one.
- If nothing meaningful remains to propose, return an empty scenarios array.
- Keep descriptions and expectedOutcome concise — one or two sentences.
- Respond with ONLY a single JSON object of the exact shape {"scenarios": [...]} — no prose, no markdown fences, nothing before or after it.`;

export const SCENARIO_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    scenarios: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          description: { type: "string" },
          targetKind: { type: "string", enum: ["FieldVisibility", "DecisionBranch", "RequiredFieldBoundary", "DataTypeBoundary", "General"] },
          targetApiName: { type: "string" },
          targetOutcomeApiName: { type: "string" },
          suggestedInputs: { type: "object" },
          boundaryKind: { type: "string", enum: ["MaxLength", "InvalidFormat", "Negative", "FarFutureDate", "EmptyRequired", "Other"] },
          expectedOutcome: { type: "string" },
        },
        required: ["id", "description", "targetKind", "expectedOutcome"],
        additionalProperties: false,
      },
    },
  },
  required: ["scenarios"],
  additionalProperties: false,
} as const;
