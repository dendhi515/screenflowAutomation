import { FlowModel, FlowScreen, FlowField, FlowGraphNode, FlowDecision, FlowPath } from "../../types/flowModel";
import { TestSpec, TestCase, ScreenTestStep, ExpectedAssertion } from "../../types/testSpec";
import { generateFieldInputs, buildScreenInputs, fillableFields } from "./testDataGenerator";
import { evaluateConditionGroup, solveInputsForOutcome, buildEvaluationContext, mergeAssignments, KnownValue } from "./conditionEvaluator";
import { isLlmConfigured, LlmScenarioProvider } from "./llmProvider";
import { ClaudeScenarioProvider } from "./providers/claudeProvider";
import { GroqScenarioProvider } from "./providers/groqProvider";
import { validateScenarioProposals } from "./scenarioValidator";
import { compileScenarios } from "./scenarioCompiler";
import { config } from "../../config";

/**
 * Stage 2b — deterministic test case generation.
 *
 * Generates one TestCase set per FlowPath (flowModel.paths — branch
 * coverage, see flowAnalyzer.ts). For each path:
 *  1. Solve the assignment values needed to actually route into it (its
 *     Decision outcomes), via conditionEvaluator's solveInputsForOutcome —
 *     an unsolvable route means the path can't be reliably driven, so it's
 *     dropped with a note rather than tested on a guess.
 *  2. Layer one additional scenario per conditional (visibilityRule) field
 *     on the path, whose own solved assignment doesn't contradict the
 *     path's base routing — each such scenario doubles as proof the field
 *     becomes visible and, since every OTHER conditional field on the path
 *     is re-evaluated in that same scenario's context, also exercises
 *     whichever fields it makes newly hidden.
 *  3. One required-field boundary case per unconditionally-required field.
 *
 * This is deliberately the coverage baseline that always runs — see
 * providers/claudeProvider.ts (added on top later) for LLM-proposed
 * scenarios layered on top of this, additively and failure-isolated.
 */

function controllableFieldsUpTo(pathNodes: FlowGraphNode[], indexInclusive: number): Map<string, FlowField> {
  const map = new Map<string, FlowField>();
  for (let i = 0; i <= indexInclusive; i++) {
    const node = pathNodes[i];
    if (node.kind === "Screen") {
      for (const f of node.fields) map.set(f.apiName, f);
    }
  }
  return map;
}

function scenarioKey(scenario: Record<string, KnownValue>): string {
  return Object.keys(scenario)
    .sort()
    .map((k) => `${k}=${scenario[k]}`)
    .join("&");
}

function describeScenarioDelta(scenario: Record<string, KnownValue>, base: Record<string, KnownValue>): string {
  const deltaKeys = Object.keys(scenario).filter((k) => !(k in base) || String(base[k]) !== String(scenario[k]));
  if (deltaKeys.length === 0) return "happy-path";
  return deltaKeys.map((k) => `${k}=${scenario[k]}`).join("_");
}

/** The value every field is actually going to be filled with in this
 *  scenario — scenario override where one exists, else the same default
 *  valid value buildScreenInputs would use. Needed so the evaluation
 *  context reflects what's really about to be typed into the browser, not
 *  just the fields a scenario deliberately targets. */
function computeKnownValuesForScenario(screens: FlowScreen[], scenario: Record<string, KnownValue>): Record<string, KnownValue> {
  const values: Record<string, KnownValue> = {};
  for (const screen of screens) {
    for (const input of buildScreenInputs(screen.fields, scenario)) {
      values[input.apiName] = input.value as KnownValue;
    }
  }
  return values;
}

function buildStepsForScenario(path: FlowPath, screens: FlowScreen[], scenario: Record<string, KnownValue>, unsupportedNotes: string[]): ScreenTestStep[] {
  const knownValues = computeKnownValuesForScenario(screens, scenario);
  const ctx = buildEvaluationContext(path.nodes, knownValues);

  return screens.map((screen) => {
    const excluded = new Set<string>();
    const assertions: ExpectedAssertion[] = [];

    for (const field of screen.fields) {
      if (field.kind === "UnsupportedCustomComponent") {
        unsupportedNotes.push(
          `Screen "${screen.label}" field "${field.apiName}" uses an unsupported custom component (${field.unsupportedComponentName}) — needs manual test data, not auto-filled.`
        );
        excluded.add(field.apiName);
        continue;
      }
      if (!field.visibilityRule) continue;

      const isVisible = evaluateConditionGroup(field.visibilityRule, ctx);
      if (isVisible === true) {
        assertions.push({
          type: "FieldPresent",
          targetApiName: field.apiName,
          targetLabel: field.label,
          description: `${field.label} should be visible in this scenario`,
        });
      } else if (isVisible === false) {
        assertions.push({
          type: "FieldAbsent",
          targetApiName: field.apiName,
          targetLabel: field.label,
          description: `${field.label} should be hidden in this scenario`,
        });
        excluded.add(field.apiName);
      } else {
        unsupportedNotes.push(
          `Field "${field.apiName}" on screen "${screen.label}" has a visibility condition that couldn't be statically evaluated for this scenario — left unasserted rather than guessed.`
        );
      }
    }

    const inputs = buildScreenInputs(screen.fields, scenario).filter((i) => !excluded.has(i.apiName));
    return { screenApiName: screen.apiName, inputs, assertions };
  });
}

function buildRequiredFieldBoundaryCase(
  path: FlowPath,
  screens: FlowScreen[],
  targetField: FlowField,
  targetScreen: FlowScreen,
  baseOverrides: Record<string, KnownValue>
): TestCase {
  const steps: ScreenTestStep[] = screens.map((screen) => {
    const inputs = buildScreenInputs(screen.fields, baseOverrides);
    if (screen.apiName !== targetScreen.apiName) {
      return { screenApiName: screen.apiName, inputs, assertions: [] };
    }
    const { boundary } = generateFieldInputs(screen.fields);
    const boundaryInput = boundary.find((b) => b.apiName === targetField.apiName);
    const finalInputs = boundaryInput ? inputs.map((i) => (i.apiName === targetField.apiName ? boundaryInput : i)) : inputs;
    return {
      screenApiName: screen.apiName,
      inputs: finalInputs,
      assertions: [
        {
          type: "FieldRequiredEnforced",
          targetApiName: targetField.apiName,
          targetLabel: targetField.label,
          description: `Screen "${screen.label}" should block Next/Finish when required field ${targetField.apiName} is blank`,
        },
      ],
    };
  });

  return {
    id: `${path.id}__${targetField.apiName}-required-enforced`,
    description: `[${path.description}] Leave required field "${targetField.label}" blank on screen "${targetScreen.label}" and verify navigation is blocked`,
    steps,
    pathId: path.id,
    scenarioSource: "deterministic",
  };
}

function generateCasesForPath(path: FlowPath, unsupportedNotes: string[], analysisNotes: string[]): TestCase[] {
  const screens = path.nodes.filter((n): n is FlowScreen => n.kind === "Screen");

  // Base overrides: the assignments needed to actually route into this path
  // via its Decision outcomes. If any is unsolvable or contradictory, this
  // path can't be reliably driven — drop it entirely rather than guess.
  let baseOverrides: Record<string, KnownValue> = {};
  for (const [decisionApiName, outcomeApiName] of Object.entries(path.decisionOutcomeTaken)) {
    const decisionIndex = path.nodes.findIndex((n) => n.apiName === decisionApiName);
    const decisionNode = path.nodes[decisionIndex] as FlowDecision | undefined;
    const outcome = decisionNode?.outcomes.find((o) => o.apiName === outcomeApiName);
    if (!decisionNode || !outcome) continue; // shouldn't happen — path was built from this exact outcome

    const controllable = controllableFieldsUpTo(path.nodes, decisionIndex);
    const solved = solveInputsForOutcome(outcome.conditionGroup, controllable);
    if (!solved.solvable) {
      analysisNotes.push(
        `Path "${path.description}" needs Decision "${decisionNode.label}" to take outcome "${outcome.label}", but that can't be driven deterministically (${solved.reason}) — this path was not tested; add manual coverage.`
      );
      return [];
    }
    const merged = mergeAssignments(baseOverrides, solved.assignments);
    if ("contradiction" in merged) {
      analysisNotes.push(
        `Path "${path.description}" has contradictory routing requirements across its decisions (${merged.contradiction}) — this path was not tested.`
      );
      return [];
    }
    baseOverrides = merged.merged;
  }

  // One additional scenario per conditional field whose own visibility
  // condition can be solved without contradicting the path's own routing.
  const scenarioKeys = new Set<string>([scenarioKey(baseOverrides)]);
  const scenarios: Record<string, KnownValue>[] = [baseOverrides];

  for (let i = 0; i < path.nodes.length; i++) {
    const node = path.nodes[i];
    if (node.kind !== "Screen") continue;
    for (const field of node.fields) {
      if (!field.visibilityRule) continue;
      const controllable = controllableFieldsUpTo(path.nodes, i);
      const solved = solveInputsForOutcome(field.visibilityRule, controllable);
      if (!solved.solvable) {
        unsupportedNotes.push(
          `Field "${field.apiName}" on screen "${node.label}" has a visibility condition that can't be driven deterministically (${solved.reason}) — no scenario generated to prove it visible.`
        );
        continue;
      }
      const merged = mergeAssignments(baseOverrides, solved.assignments);
      if ("contradiction" in merged) {
        unsupportedNotes.push(
          `Field "${field.apiName}" on screen "${node.label}"'s visibility condition contradicts this path's own routing requirements (${merged.contradiction}) — it can never become visible on this path.`
        );
        continue;
      }
      const key = scenarioKey(merged.merged);
      if (scenarioKeys.has(key)) continue;
      scenarioKeys.add(key);
      scenarios.push(merged.merged);
    }
  }

  const cases: TestCase[] = scenarios.map((scenario) => {
    const label = describeScenarioDelta(scenario, baseOverrides);
    const steps = buildStepsForScenario(path, screens, scenario, unsupportedNotes);
    return {
      id: `${path.id}__${label}`,
      description:
        label === "happy-path"
          ? `[${path.description}] Complete the flow with valid data`
          : `[${path.description}] Run with ${label} and verify conditional field visibility`,
      steps,
      pathId: path.id,
      scenarioSource: "deterministic",
    };
  });

  // Required-field boundary cases — only for fields that are ALWAYS
  // required whenever this path reaches their screen (no visibilityRule of
  // their own). Conditionally-required fields are covered implicitly by the
  // scenarios above already requiring them once visible.
  for (const screen of screens) {
    for (const field of fillableFields(screen.fields)) {
      if (field.required && !field.visibilityRule) {
        cases.push(buildRequiredFieldBoundaryCase(path, screens, field, screen, baseOverrides));
      }
    }
  }

  return cases;
}

function buildTestPlanMarkdown(flowModel: FlowModel, unsupportedNotes: string[], analysisNotes: string[]): string {
  const screens = Object.values(flowModel.nodes).filter((n): n is FlowScreen => n.kind === "Screen");

  const pathsSection = flowModel.paths.map((p) => `- **${p.id}**: ${p.description}`).join("\n");

  const screensSection = screens
    .map(
      (s) =>
        `## Screen: ${s.label}\n` +
        s.fields
          .map((f) => {
            const bits = [
              f.required ? "required" : null,
              f.visibilityRule ? "conditionally visible" : null,
              f.kind === "UnsupportedCustomComponent" ? "UNSUPPORTED custom component" : null,
              f.kind === "Lookup" ? `lookup on ${f.lookupObjectApiName ?? "unknown object"} — auto-selects first search match, not a literal value` : null,
            ].filter(Boolean);
            return `- ${f.label}${bits.length ? ` (${bits.join(", ")})` : ""}`;
          })
          .join("\n")
    )
    .join("\n\n");

  const unsupportedSection =
    unsupportedNotes.length > 0 ? `\n\n## Needs manual attention\n${[...new Set(unsupportedNotes)].map((n) => `- ${n}`).join("\n")}` : "";
  const analysisSection =
    analysisNotes.length > 0 ? `\n\n## Not analyzed / not testable automatically\n${[...new Set(analysisNotes)].map((n) => `- ${n}`).join("\n")}` : "";

  return [`# Test plan — ${flowModel.flowLabel}`, "", `## Paths covered (branch coverage)`, pathsSection, "", screensSection, unsupportedSection, analysisSection].join(
    "\n"
  );
}

function buildDeterministicSpec(flowModel: FlowModel): TestSpec {
  const unsupportedNotes: string[] = [];
  const analysisNotes: string[] = [...flowModel.analysisNotes];

  const testCases: TestCase[] = [];
  for (const path of flowModel.paths) {
    testCases.push(...generateCasesForPath(path, unsupportedNotes, analysisNotes));
  }

  return {
    flowApiName: flowModel.flowApiName,
    flowType: "ScreenFlow",
    generatedBy: "deterministic",
    testPlanMarkdown: buildTestPlanMarkdown(flowModel, unsupportedNotes, analysisNotes),
    testCases,
  };
}

/** apiNames already exercised by deterministic generation — passed to the
 *  LLM so it proposes ADDITIONAL scenarios rather than duplicating them. */
function computeCoveredTargets(flowModel: FlowModel, deterministicCases: TestCase[]): string[] {
  const covered = new Set<string>();
  for (const tc of deterministicCases) {
    for (const step of tc.steps ?? []) {
      for (const assertion of step.assertions) covered.add(assertion.targetApiName);
    }
  }
  for (const path of flowModel.paths) {
    for (const decisionApiName of Object.keys(path.decisionOutcomeTaken)) covered.add(decisionApiName);
  }
  for (const node of Object.values(flowModel.nodes)) {
    if (node.kind === "RecordCreate" || node.kind === "RecordUpdate" || node.kind === "RecordDelete") covered.add(node.apiName);
  }
  return [...covered];
}

function createLlmProvider(): LlmScenarioProvider | undefined {
  if (config.llm.provider === "anthropic") {
    return new ClaudeScenarioProvider(config.llm.apiKey, config.llm.model, config.llm.effort);
  }
  if (config.llm.provider === "groq") {
    return new GroqScenarioProvider(config.llm.apiKey, config.llm.model);
  }
  console.warn(`LLM_PROVIDER "${config.llm.provider}" is not recognized (implemented: "anthropic", "groq") — continuing with deterministic coverage only.`);
  return undefined;
}

/**
 * Deterministic generation always runs first and is the coverage baseline
 * this function returns even if everything below fails. LLM-proposed
 * scenarios (if configured) are validated (scenarioValidator.ts) and
 * compiled (scenarioCompiler.ts) on top, additively — any failure at any
 * step here degrades to deterministic-only, never throws.
 */
export async function generateTestSpec(flowModel: FlowModel): Promise<TestSpec> {
  const deterministicSpec = buildDeterministicSpec(flowModel);

  if (!isLlmConfigured(config.llm.provider, config.llm.apiKey)) {
    return deterministicSpec;
  }

  try {
    const provider = createLlmProvider();
    if (!provider) return deterministicSpec;

    const coveredTargets = computeCoveredTargets(flowModel, deterministicSpec.testCases);
    const proposals = await provider.proposeScenarios({ flowModel, coveredTargets });
    if (proposals.length === 0) return deterministicSpec;

    const { valid, rejected } = validateScenarioProposals(flowModel, proposals);
    const { cases: llmCases, notes: compileNotes } = compileScenarios(flowModel, valid);

    const unusedNotes = [...rejected.map((r) => `LLM-proposed scenario "${r.proposal.id ?? "(no id)"}" was rejected: ${r.reason}.`), ...compileNotes];

    let testPlanMarkdown = deterministicSpec.testPlanMarkdown;
    if (llmCases.length > 0) {
      testPlanMarkdown += `\n\n## LLM-proposed scenarios\n${llmCases.map((c) => `- ${c.id}: ${c.description}`).join("\n")}`;
    }
    if (unusedNotes.length > 0) {
      testPlanMarkdown += `\n\n## LLM proposals not used\n${[...new Set(unusedNotes)].map((n) => `- ${n}`).join("\n")}`;
    }

    return {
      ...deterministicSpec,
      generatedBy: llmCases.length > 0 ? "deterministic+llm" : "deterministic",
      testCases: [...deterministicSpec.testCases, ...llmCases],
      testPlanMarkdown,
    };
  } catch (err) {
    console.warn(
      `LLM scenario proposal step failed unexpectedly (${err instanceof Error ? err.message : String(err)}) — continuing with deterministic coverage only.`
    );
    return deterministicSpec;
  }
}
