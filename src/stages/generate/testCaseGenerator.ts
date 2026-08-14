import { FlowModel, FlowScreen, FlowField, FlowCondition } from "../../types/flowModel";
import { TestSpec, TestCase, ScreenTestStep, ExpectedAssertion, FieldInput } from "../../types/testSpec";
import { generateFieldInputs, fillableFields } from "./testDataGenerator";
import { config } from "../../config";
import { isLlmConfigured } from "./llmProvider";

/**
 * Stage 2b — test case generation (design doc addendum: local-file pivot).
 *
 * Visibility conditions are structured (leftValueReference/operator/
 * rightValue), not free-text formulas — see the design discussion. This
 * generator evaluates EqualTo/NotEqualTo conditions itself so it knows
 * what SHOULD happen before Playwright checks what DOES happen. Any other
 * operator is left unasserted with a logged warning rather than guessed —
 * consistent with the "flag, don't fake" approach used for unsupported
 * custom components.
 *
 * If an LLM provider is configured, generateTestSpec delegates test case
 * *wording* / plan narrative to it later; the deterministic path below
 * remains the source of truth for what gets asserted, since visibility
 * correctness shouldn't depend on an LLM getting a formula right.
 */

function screensInPath(flowModel: FlowModel): FlowScreen[] {
  return flowModel.path.filter((n): n is FlowScreen => n.kind === "Screen");
}

function evaluateCondition(condition: FlowCondition, driverValue: string): boolean | undefined {
  const expected = String(condition.rightValueLiteral);
  switch (condition.operator) {
    case "EqualTo":
      return driverValue === expected;
    case "NotEqualTo":
      return driverValue !== expected;
    default:
      console.warn(
        `Visibility operator "${condition.operator}" on ${condition.leftValueReference} is not evaluated — leaving unasserted rather than guessing.`
      );
      return undefined;
  }
}

interface ConditionalField {
  screen: FlowScreen;
  field: FlowField;
  driverApiName: string;
}

function collectConditionalFields(screens: FlowScreen[]): ConditionalField[] {
  const result: ConditionalField[] = [];
  for (const screen of screens) {
    for (const field of screen.fields) {
      const rule = field.visibilityRule;
      if (rule && rule.conditions.length === 1) {
        // v1 scope: single-condition rules only (matches the demo flow and
        // the scoped-down request). Multi-condition conditionLogic (AND/OR
        // combinations) is real Flow behavior but deferred — see design doc.
        result.push({ screen, field, driverApiName: rule.conditions[0].leftValueReference });
      } else if (rule) {
        console.warn(`Field ${field.apiName} has a multi-condition visibility rule — deferred, leaving unasserted.`);
      }
    }
  }
  return result;
}

/** Distinct literal values worth testing for a given driver field, taken
 *  from the literals actually referenced by conditions that depend on it. */
function distinctDriverValues(conditionalFields: ConditionalField[], driverApiName: string): string[] {
  const values = new Set<string>();
  for (const cf of conditionalFields) {
    if (cf.driverApiName !== driverApiName) continue;
    const literal = cf.field.visibilityRule?.conditions[0].rightValueLiteral;
    if (literal !== undefined) values.add(String(literal));
  }
  return [...values];
}

function buildStepsForScenario(
  screens: FlowScreen[],
  conditionalFields: ConditionalField[],
  driverApiName: string,
  driverValue: string,
  unsupportedNotes: string[]
): { steps: ScreenTestStep[]; description: string } {
  const steps: ScreenTestStep[] = [];

  for (const screen of screens) {
    const { valid } = generateFieldInputs(screen.fields);
    const assertions: ExpectedAssertion[] = [];
    const excludedApiNames = new Set<string>();

    for (const field of screen.fields) {
      if (field.kind === "UnsupportedCustomComponent") {
        unsupportedNotes.push(
          `Screen "${screen.label}" field "${field.apiName}" uses an unsupported custom component (${field.unsupportedComponentName}) — needs manual test data, not auto-filled.`
        );
        excludedApiNames.add(field.apiName);
        continue;
      }

      const conditional = conditionalFields.find((cf) => cf.field.apiName === field.apiName);
      if (!conditional || conditional.driverApiName !== driverApiName) continue;

      const condition = field.visibilityRule!.conditions[0];
      const isVisible = evaluateCondition(condition, driverValue);
      if (isVisible === undefined) continue; // unsupported operator — already warned

      if (isVisible) {
        assertions.push({
          type: "FieldPresent",
          targetApiName: field.apiName,
          targetLabel: field.label,
          description: `${field.label} should be visible when ${driverApiName} = "${driverValue}"`,
        });
      } else {
        assertions.push({
          type: "FieldAbsent",
          targetApiName: field.apiName,
          targetLabel: field.label,
          description: `${field.label} should be hidden when ${driverApiName} = "${driverValue}"`,
        });
        excludedApiNames.add(field.apiName); // don't attempt to fill a field we expect to be hidden
      }
    }

    const inputs: FieldInput[] = valid
      .filter((i) => !excludedApiNames.has(i.apiName))
      .map((i) => (i.apiName === driverApiName ? { ...i, value: driverValue } : i));

    steps.push({ screenApiName: screen.apiName, inputs, assertions });
  }

  return { steps, description: `Run flow with ${driverApiName} = "${driverValue}" and verify conditional field visibility` };
}

function buildRequiredFieldBoundaryCase(screens: FlowScreen[], targetField: FlowField, targetScreen: FlowScreen): TestCase {
  const steps: ScreenTestStep[] = screens.map((screen) => {
    const { valid, boundary } = generateFieldInputs(screen.fields);
    if (screen.apiName !== targetScreen.apiName) {
      return { screenApiName: screen.apiName, inputs: valid, assertions: [] };
    }
    const boundaryInput = boundary.find((b) => b.apiName === targetField.apiName);
    const inputs = valid.map((i) => (i.apiName === targetField.apiName && boundaryInput ? boundaryInput : i));
    return {
      screenApiName: screen.apiName,
      inputs,
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
    id: `${targetField.apiName}-required-enforced`,
    description: `Leave required field "${targetField.label}" blank on screen "${targetScreen.label}" and verify navigation is blocked`,
    steps,
  };
}

function buildDeterministicSpec(flowModel: FlowModel): TestSpec {
  const screens = screensInPath(flowModel);
  const conditionalFields = collectConditionalFields(screens);
  const unsupportedNotes: string[] = [];

  const testCases: TestCase[] = [];

  const drivers = [...new Set(conditionalFields.map((cf) => cf.driverApiName))];
  if (drivers.length === 0) {
    // No conditional fields at all — one straightforward happy-path case.
    const steps: ScreenTestStep[] = screens.map((screen) => {
      const { valid } = generateFieldInputs(screen.fields);
      return { screenApiName: screen.apiName, inputs: valid, assertions: [] };
    });
    testCases.push({ id: "happy-path", description: "Complete the flow with valid data on every screen", steps });
  } else {
    for (const driver of drivers) {
      for (const value of distinctDriverValues(conditionalFields, driver)) {
        const { steps, description } = buildStepsForScenario(screens, conditionalFields, driver, value, unsupportedNotes);
        testCases.push({ id: `${driver}-${value}`, description, steps });
      }
    }
  }

  // One boundary case per always-visible required field (fields whose
  // visibility itself depends on a condition are more involved to isolate
  // and are covered implicitly by the scenario cases above already
  // requiring them when visible).
  for (const screen of screens) {
    for (const field of fillableFields(screen.fields)) {
      if (field.required && !field.visibilityRule) {
        testCases.push(buildRequiredFieldBoundaryCase(screens, field, screen));
      }
    }
  }

  const unsupportedSection =
    unsupportedNotes.length > 0 ? `\n\n## Needs manual attention\n${[...new Set(unsupportedNotes)].map((n) => `- ${n}`).join("\n")}` : "";

  const testPlanMarkdown = [
    `# Test plan — ${flowModel.flowLabel}`,
    "",
    ...screens.map(
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
    ),
    unsupportedSection,
  ].join("\n");

  return {
    flowApiName: flowModel.flowApiName,
    flowType: "ScreenFlow",
    generatedBy: "deterministic-fallback",
    testPlanMarkdown,
    testCases,
  };
}

export async function generateTestSpec(flowModel: FlowModel): Promise<TestSpec> {
  if (isLlmConfigured(config.llm.provider, config.llm.apiKey)) {
    console.warn(`LLM provider "${config.llm.provider}" configured but not yet wired up — using deterministic generator.`);
  }
  return buildDeterministicSpec(flowModel);
}
