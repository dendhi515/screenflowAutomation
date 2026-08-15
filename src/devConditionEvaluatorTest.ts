/** Standalone verification for conditionEvaluator.ts's conditionLogic
 *  parser + three-valued evaluator + inverse solver — no server, no
 *  Salesforce, no Playwright. Run with:
 *  npx ts-node --transpile-only src/devConditionEvaluatorTest.ts
 *
 *  This is the highest-risk new logic in the flow-graph rebuild (a bug here
 *  silently produces test cases that look like branch coverage without
 *  actually exercising the branch), so it gets exercised directly against
 *  known-answer cases rather than only indirectly through a full flow. */
import { FlowConditionGroup, FlowField } from "./types/flowModel";
import { evaluateConditionGroup, solveInputsForOutcome, EvaluationContext } from "./stages/generate/conditionEvaluator";

let failures = 0;

function ctx(values: Record<string, string | number | boolean>): EvaluationContext {
  return { knownValues: new Map(Object.entries(values)) };
}

function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"} — ${label} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

function group(conditionLogic: string, conditions: FlowConditionGroup["conditions"]): FlowConditionGroup {
  return { conditionLogic, conditions };
}

// --- conditionLogic "1" (single condition) ---
{
  const g = group("1", [{ leftValueReference: "A", operator: "EqualTo", rightValueLiteral: "x" }]);
  check('"1", A=x', evaluateConditionGroup(g, ctx({ A: "x" })), true);
  check('"1", A=y', evaluateConditionGroup(g, ctx({ A: "y" })), false);
  check('"1", A unknown', evaluateConditionGroup(g, ctx({})), undefined);
}

// --- conditionLogic "and" (bare, applies across all conditions) ---
{
  const g = group("and", [
    { leftValueReference: "A", operator: "EqualTo", rightValueLiteral: "x" },
    { leftValueReference: "B", operator: "EqualTo", rightValueLiteral: "y" },
  ]);
  check('"and", both true', evaluateConditionGroup(g, ctx({ A: "x", B: "y" })), true);
  check('"and", one false', evaluateConditionGroup(g, ctx({ A: "x", B: "z" })), false);
  check('"and", one unknown one true -> undefined', evaluateConditionGroup(g, ctx({ A: "x" })), undefined);
}

// --- conditionLogic "or" (bare) ---
{
  const g = group("or", [
    { leftValueReference: "A", operator: "EqualTo", rightValueLiteral: "x" },
    { leftValueReference: "B", operator: "EqualTo", rightValueLiteral: "y" },
  ]);
  check('"or", both false', evaluateConditionGroup(g, ctx({ A: "z", B: "z" })), false);
  check('"or", one true one unknown -> true', evaluateConditionGroup(g, ctx({ A: "x" })), true);
  check('"or", one false one unknown -> undefined', evaluateConditionGroup(g, ctx({ A: "z" })), undefined);
}

// --- conditionLogic "(1 AND 2) OR 3" ---
{
  const g = group("(1 AND 2) OR 3", [
    { leftValueReference: "A", operator: "EqualTo", rightValueLiteral: "x" },
    { leftValueReference: "B", operator: "EqualTo", rightValueLiteral: "y" },
    { leftValueReference: "C", operator: "EqualTo", rightValueLiteral: "z" },
  ]);
  check("(1 AND 2) OR 3, 1&2 true", evaluateConditionGroup(g, ctx({ A: "x", B: "y", C: "nope" })), true);
  check("(1 AND 2) OR 3, only 3 true, 1/2 unknown", evaluateConditionGroup(g, ctx({ C: "z" })), true);
  check("(1 AND 2) OR 3, 1 true 2 unknown 3 false -> undefined", evaluateConditionGroup(g, ctx({ A: "x", C: "nope" })), undefined);
  check("(1 AND 2) OR 3, all false", evaluateConditionGroup(g, ctx({ A: "nope", B: "nope", C: "nope" })), false);
}

// --- solveInputsForOutcome ---
{
  const dropdownField: FlowField = {
    apiName: "A",
    label: "A",
    kind: "Dropdown",
    required: false,
    choices: [
      { apiName: "c1", label: "X", value: "x" },
      { apiName: "c2", label: "Y", value: "y" },
    ],
  };
  const controllable = new Map<string, FlowField>([["A", dropdownField]]);

  const eq = group("1", [{ leftValueReference: "A", operator: "EqualTo", rightValueLiteral: "x" }]);
  check("solve EqualTo", solveInputsForOutcome(eq, controllable), { solvable: true, assignments: { A: "x" } });

  const neq = group("1", [{ leftValueReference: "A", operator: "NotEqualTo", rightValueLiteral: "x" }]);
  check("solve NotEqualTo picks real alternate choice", solveInputsForOutcome(neq, controllable), { solvable: true, assignments: { A: "y" } });

  const uncontrollable = group("1", [{ leftValueReference: "Z", operator: "EqualTo", rightValueLiteral: "x" }]);
  const uncontrollableResult = solveInputsForOutcome(uncontrollable, controllable);
  check("solve uncontrollable field is unsolvable", uncontrollableResult.solvable, false);

  const contradiction = group("1 AND 2", [
    { leftValueReference: "A", operator: "EqualTo", rightValueLiteral: "x" },
    { leftValueReference: "A", operator: "EqualTo", rightValueLiteral: "y" },
  ]);
  const contradictionResult = solveInputsForOutcome(contradiction, controllable);
  check("solve contradiction (same field, two values) is unsolvable", contradictionResult.solvable, false);

  const orField: FlowConditionGroup = group("1 OR 2", [
    { leftValueReference: "Z", operator: "EqualTo", rightValueLiteral: "x" }, // unsolvable — Z not controllable
    { leftValueReference: "A", operator: "EqualTo", rightValueLiteral: "x" }, // solvable
  ]);
  check("solve OR falls back to the solvable side", solveInputsForOutcome(orField, controllable), { solvable: true, assignments: { A: "x" } });
}

console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
