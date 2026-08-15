import { FlowModel } from "../../types/flowModel";

/**
 * Pluggable LLM interface. The model only PROPOSES scenarios — it never
 * writes runnable Playwright logic directly. scenarioValidator.ts checks
 * every apiName/choice/outcome a proposal references against the real
 * FlowModel, and scenarioCompiler.ts turns validated proposals into actual
 * TestCases, reusing the same deterministic machinery
 * (testDataGenerator.ts, conditionEvaluator.ts) the structural generator
 * uses. Deterministic generation (testCaseGenerator.ts) always runs first
 * as the coverage baseline and never depends on this; a provider must
 * degrade gracefully (return []) on any failure rather than throw — see
 * providers/claudeProvider.ts.
 */

export type BoundaryKind = "MaxLength" | "InvalidFormat" | "Negative" | "FarFutureDate" | "EmptyRequired" | "Other";

export interface ScenarioProposal {
  id: string;
  description: string;
  targetKind: "FieldVisibility" | "DecisionBranch" | "RequiredFieldBoundary" | "DataTypeBoundary" | "General";
  /** A field, decision, or DML element apiName — validated against the real
   *  FlowModel before anything is trusted. */
  targetApiName?: string;
  /** Only for targetKind === "DecisionBranch" — which outcome to drive. */
  targetOutcomeApiName?: string;
  /** apiName -> value overrides for specific fields — validated field-by-
   *  field (and choice-by-choice, where applicable) before use. */
  suggestedInputs?: Record<string, string | number | boolean>;
  /** Only for targetKind === "DataTypeBoundary" — see testDataGenerator.ts
   *  generateBoundaryValue(). */
  boundaryKind?: BoundaryKind;
  /** Free text rationale — logged/surfaced in testPlanMarkdown only, never
   *  compiled into an assertion verbatim (assertions are still built
   *  deterministically by scenarioCompiler.ts). */
  expectedOutcome: string;
}

export interface ScenarioCoverageSummary {
  /** apiNames already covered by deterministic generation, so the model
   *  proposes ADDITIONAL scenarios rather than duplicating them. */
  coveredTargets: string[];
  flowModel: FlowModel;
}

export interface LlmScenarioProvider {
  proposeScenarios(input: ScenarioCoverageSummary): Promise<ScenarioProposal[]>;
}

export function isLlmConfigured(providerName: string, apiKey: string): boolean {
  return Boolean(providerName && apiKey);
}
