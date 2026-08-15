import { FlowModel, FlowScreen, FlowDecision, FlowField, FlowGraphNode } from "../../types/flowModel";
import { TestCase, ScreenTestStep, ExpectedAssertion } from "../../types/testSpec";
import { ScenarioProposal } from "./llmProvider";
import { buildScreenInputs, generateBoundaryValue } from "./testDataGenerator";
import { evaluateConditionGroup, buildEvaluationContext, solveInputsForOutcome, KnownValue } from "./conditionEvaluator";
import { walkPath } from "../analyze/flowAnalyzer";

/**
 * Turns a VALIDATED ScenarioProposal (see scenarioValidator.ts — nothing
 * here trusts a proposal that hasn't already passed that check) into a
 * real, runnable TestCase — reusing the same deterministic machinery
 * (buildScreenInputs, conditionEvaluator) the structural generator uses, so
 * an LLM-sourced case is built the exact same honest way as a
 * deterministic one. Never invents an assertion the flow's own metadata
 * doesn't support proving.
 */

const MAX_LLM_CASES_PER_RUN = 20;

export interface CompileResult {
  testCase?: TestCase;
  skippedReason?: string;
}

function findFieldScreen(flowModel: FlowModel, apiName: string): FlowScreen | undefined {
  for (const node of Object.values(flowModel.nodes)) {
    if (node.kind === "Screen" && node.fields.some((f) => f.apiName === apiName)) return node;
  }
  return undefined;
}

function computeKnownValues(screens: FlowScreen[], overrides: Record<string, KnownValue>): Record<string, KnownValue> {
  const values: Record<string, KnownValue> = {};
  for (const screen of screens) {
    for (const input of buildScreenInputs(screen.fields, overrides)) {
      values[input.apiName] = input.value as KnownValue;
    }
  }
  return values;
}

/** Same present/absent-driven step-building as testCaseGenerator.ts's
 *  buildStepsForScenario, without generating Present/Absent assertions for
 *  every conditional field — the LLM-targeted scenario's own assertion is
 *  added separately by the caller; this only decides what to fill vs. skip. */
function buildStepsFromPath(pathNodes: FlowGraphNode[], screens: FlowScreen[], overrides: Record<string, KnownValue>): ScreenTestStep[] {
  const knownValues = computeKnownValues(screens, overrides);
  const ctx = buildEvaluationContext(pathNodes, knownValues);

  return screens.map((screen) => {
    const excluded = new Set<string>();
    for (const field of screen.fields) {
      if (field.kind === "UnsupportedCustomComponent") {
        excluded.add(field.apiName);
        continue;
      }
      if (!field.visibilityRule) continue;
      if (evaluateConditionGroup(field.visibilityRule, ctx) === false) excluded.add(field.apiName);
    }
    const inputs = buildScreenInputs(screen.fields, overrides).filter((i) => !excluded.has(i.apiName));
    return { screenApiName: screen.apiName, inputs, assertions: [] };
  });
}

function compileDecisionBranch(flowModel: FlowModel, proposal: ScenarioProposal): CompileResult {
  if (!proposal.targetApiName || !proposal.targetOutcomeApiName) {
    return { skippedReason: "DecisionBranch proposal is missing targetApiName/targetOutcomeApiName" };
  }
  const decisionNode = flowModel.nodes[proposal.targetApiName];
  if (!decisionNode || decisionNode.kind !== "Decision") {
    return { skippedReason: `"${proposal.targetApiName}" is not a Decision element in this flow` };
  }
  const outcome = (decisionNode as FlowDecision).outcomes.find((o) => o.apiName === proposal.targetOutcomeApiName);
  if (!outcome) return { skippedReason: `outcome "${proposal.targetOutcomeApiName}" not found on Decision "${proposal.targetApiName}"` };

  const pathNodes = walkPath(flowModel.nodes, flowModel.startElementApiName, {
    decisionOutcome: new Map([[proposal.targetApiName, proposal.targetOutcomeApiName]]),
  });
  const decisionIndex = pathNodes.findIndex((n) => n.apiName === proposal.targetApiName);
  if (decisionIndex === -1) return { skippedReason: `Decision "${proposal.targetApiName}" isn't reachable from the flow's start element` };

  const controllable = new Map<string, FlowField>();
  for (let i = 0; i <= decisionIndex; i++) {
    const n = pathNodes[i];
    if (n.kind === "Screen") for (const f of n.fields) controllable.set(f.apiName, f);
  }
  const solved = solveInputsForOutcome(outcome.conditionGroup, controllable);
  if (!solved.solvable) return { skippedReason: `outcome "${outcome.label}" can't be driven deterministically: ${solved.reason}` };

  const overrides: Record<string, KnownValue> = { ...solved.assignments, ...(proposal.suggestedInputs ?? {}) };
  const screens = pathNodes.filter((n): n is FlowScreen => n.kind === "Screen");
  const steps = buildStepsFromPath(pathNodes, screens, overrides);

  return { testCase: { id: `llm__${proposal.id}`, description: `[LLM] ${proposal.description}`, steps, scenarioSource: "llm" } };
}

function compileFieldVisibility(flowModel: FlowModel, proposal: ScenarioProposal): CompileResult {
  if (!proposal.targetApiName) return { skippedReason: "FieldVisibility proposal is missing targetApiName" };
  const screen = findFieldScreen(flowModel, proposal.targetApiName);
  if (!screen) return { skippedReason: `field "${proposal.targetApiName}" not found on any screen` };

  const pathNodes = walkPath(flowModel.nodes, flowModel.startElementApiName, {});
  if (!pathNodes.some((n) => n.apiName === screen.apiName)) {
    return { skippedReason: `screen "${screen.apiName}" isn't reachable on the flow's default path` };
  }
  const screens = pathNodes.filter((n): n is FlowScreen => n.kind === "Screen");
  const overrides: Record<string, KnownValue> = { ...(proposal.suggestedInputs ?? {}) };
  const knownValues = computeKnownValues(screens, overrides);
  const ctx = buildEvaluationContext(pathNodes, knownValues);

  const field = screen.fields.find((f) => f.apiName === proposal.targetApiName)!;
  const assertions: ExpectedAssertion[] = [];
  if (field.visibilityRule) {
    const isVisible = evaluateConditionGroup(field.visibilityRule, ctx);
    if (isVisible === true) {
      assertions.push({ type: "FieldPresent", targetApiName: field.apiName, targetLabel: field.label, description: proposal.expectedOutcome });
    } else if (isVisible === false) {
      assertions.push({ type: "FieldAbsent", targetApiName: field.apiName, targetLabel: field.label, description: proposal.expectedOutcome });
    }
  }

  const steps = buildStepsFromPath(pathNodes, screens, overrides);
  const targetStep = steps.find((s) => s.screenApiName === screen.apiName);
  if (targetStep) targetStep.assertions = assertions;

  return { testCase: { id: `llm__${proposal.id}`, description: `[LLM] ${proposal.description}`, steps, scenarioSource: "llm" } };
}

function compileRequiredFieldBoundary(flowModel: FlowModel, proposal: ScenarioProposal): CompileResult {
  if (!proposal.targetApiName) return { skippedReason: "RequiredFieldBoundary proposal is missing targetApiName" };
  const screen = findFieldScreen(flowModel, proposal.targetApiName);
  if (!screen) return { skippedReason: `field "${proposal.targetApiName}" not found on any screen` };
  const field = screen.fields.find((f) => f.apiName === proposal.targetApiName)!;

  const pathNodes = walkPath(flowModel.nodes, flowModel.startElementApiName, {});
  if (!pathNodes.some((n) => n.apiName === screen.apiName)) {
    return { skippedReason: `screen "${screen.apiName}" isn't reachable on the flow's default path` };
  }
  const screens = pathNodes.filter((n): n is FlowScreen => n.kind === "Screen");
  const overrides: Record<string, KnownValue> = { ...(proposal.suggestedInputs ?? {}) };

  const steps: ScreenTestStep[] = screens.map((s) => {
    const inputs = buildScreenInputs(s.fields, overrides);
    if (s.apiName !== screen.apiName) return { screenApiName: s.apiName, inputs, assertions: [] };
    const blanked = inputs.map((i) => (i.apiName === field.apiName ? { ...i, value: "", isBoundaryOrInvalid: true } : i));
    return {
      screenApiName: s.apiName,
      inputs: blanked,
      assertions: [{ type: "FieldRequiredEnforced", targetApiName: field.apiName, targetLabel: field.label, description: proposal.expectedOutcome }],
    };
  });

  return { testCase: { id: `llm__${proposal.id}`, description: `[LLM] ${proposal.description}`, steps, scenarioSource: "llm" } };
}

function compileDataTypeBoundary(flowModel: FlowModel, proposal: ScenarioProposal): CompileResult {
  if (!proposal.targetApiName) return { skippedReason: "DataTypeBoundary proposal is missing targetApiName" };
  const screen = findFieldScreen(flowModel, proposal.targetApiName);
  if (!screen) return { skippedReason: `field "${proposal.targetApiName}" not found on any screen` };
  const field = screen.fields.find((f) => f.apiName === proposal.targetApiName)!;

  const pathNodes = walkPath(flowModel.nodes, flowModel.startElementApiName, {});
  if (!pathNodes.some((n) => n.apiName === screen.apiName)) {
    return { skippedReason: `screen "${screen.apiName}" isn't reachable on the flow's default path` };
  }
  const screens = pathNodes.filter((n): n is FlowScreen => n.kind === "Screen");
  const overrides: Record<string, KnownValue> = { ...(proposal.suggestedInputs ?? {}) };
  const boundaryInput = generateBoundaryValue(field, proposal.boundaryKind ?? "Other");

  const steps: ScreenTestStep[] = screens.map((s) => {
    const inputs = buildScreenInputs(s.fields, overrides);
    if (s.apiName !== screen.apiName) return { screenApiName: s.apiName, inputs, assertions: [] };
    const swapped = inputs.map((i) => (i.apiName === field.apiName ? boundaryInput : i));
    // Exploratory: whether a boundary value like this actually gets rejected
    // depends on validation the flow's metadata doesn't expose to us (e.g. a
    // formula-based validation rule) — no assertion is invented here. The
    // point is exercising the input and capturing screenshots for review,
    // not claiming a pass/fail verdict we can't back up.
    return { screenApiName: s.apiName, inputs: swapped, assertions: [] };
  });

  return {
    testCase: {
      id: `llm__${proposal.id}`,
      description: `[LLM, exploratory — review screenshots] ${proposal.description}`,
      steps,
      scenarioSource: "llm",
    },
  };
}

function compileGeneral(flowModel: FlowModel, proposal: ScenarioProposal): CompileResult {
  const pathNodes = walkPath(flowModel.nodes, flowModel.startElementApiName, {});
  const screens = pathNodes.filter((n): n is FlowScreen => n.kind === "Screen");
  const overrides: Record<string, KnownValue> = { ...(proposal.suggestedInputs ?? {}) };
  const steps = buildStepsFromPath(pathNodes, screens, overrides);
  return {
    testCase: { id: `llm__${proposal.id}`, description: `[LLM, exploratory] ${proposal.description}`, steps, scenarioSource: "llm" },
  };
}

export function compileScenario(flowModel: FlowModel, proposal: ScenarioProposal): CompileResult {
  switch (proposal.targetKind) {
    case "DecisionBranch":
      return compileDecisionBranch(flowModel, proposal);
    case "FieldVisibility":
      return compileFieldVisibility(flowModel, proposal);
    case "RequiredFieldBoundary":
      return compileRequiredFieldBoundary(flowModel, proposal);
    case "DataTypeBoundary":
      return compileDataTypeBoundary(flowModel, proposal);
    case "General":
    default:
      return compileGeneral(flowModel, proposal);
  }
}

/** Compiles every validated proposal, capping total LLM-sourced cases per
 *  run (each compiled case is a real, slow browser run) and deduping by
 *  compiled TestCase id. Returns notes for anything skipped or dropped, for
 *  testPlanMarkdown. */
export function compileScenarios(flowModel: FlowModel, proposals: ScenarioProposal[]): { cases: TestCase[]; notes: string[] } {
  const cases: TestCase[] = [];
  const notes: string[] = [];
  const seenIds = new Set<string>();

  for (const proposal of proposals) {
    if (cases.length >= MAX_LLM_CASES_PER_RUN) {
      notes.push(`LLM proposed more scenarios than the ${MAX_LLM_CASES_PER_RUN}-case-per-run cap — remaining proposals were not compiled.`);
      break;
    }
    const result = compileScenario(flowModel, proposal);
    if (result.skippedReason) {
      notes.push(`LLM-proposed scenario "${proposal.id}" was not compiled: ${result.skippedReason}.`);
      continue;
    }
    if (result.testCase) {
      if (seenIds.has(result.testCase.id)) continue;
      seenIds.add(result.testCase.id);
      cases.push(result.testCase);
    }
  }

  return { cases, notes };
}
