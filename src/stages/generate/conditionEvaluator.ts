import { FlowCondition, FlowConditionGroup, FlowField, FlowGraphNode } from "../../types/flowModel";

/**
 * Shared condition logic, used both for screen field visibilityRules and
 * Decision outcome conditions (same {conditionLogic, conditions} shape).
 * Replaces the ad hoc single-condition evaluateCondition() that used to
 * live in testCaseGenerator.ts.
 *
 * Two distinct jobs live here, because "is this true?" and "what input
 * makes this true?" are different problems:
 *  - evaluateConditionGroup: forward evaluation — given known values, is
 *    the group true, false, or unprovable?
 *  - solveInputsForOutcome: inverse solving — what field values would make
 *    this group true, if anything controllable can?
 */

export type KnownValue = string | number | boolean;

export interface EvaluationContext {
  /** Field/variable apiName -> known value for a specific scenario. Absent
   *  key = truly unknown/unprovable (org data, unresolved lookup, a
   *  non-literal assignment) — NOT the same as an empty string, which means
   *  "known to be blank". */
  knownValues: Map<string, KnownValue>;
}

export type ConditionResult = true | false | undefined; // undefined = "can't statically prove"

/** Builds an EvaluationContext for one path/scenario: seeds the given
 *  screen-field values, then folds in every literal-value Assignment node
 *  on the path IN ORDER (later overwrites earlier; a non-literal or
 *  non-"Assign" assignment removes the key going forward, since its value
 *  is no longer statically known). */
export function buildEvaluationContext(pathNodes: FlowGraphNode[], fieldValues: Record<string, KnownValue>): EvaluationContext {
  const knownValues = new Map<string, KnownValue>(Object.entries(fieldValues));
  for (const node of pathNodes) {
    if (node.kind !== "Assignment") continue;
    for (const item of node.assignmentItems) {
      if (item.operator !== "Assign" || !item.value) {
        knownValues.delete(item.targetReference);
        continue;
      }
      if (item.value.kind === "literal") {
        knownValues.set(item.targetReference, item.value.literal);
      } else {
        const referenced = knownValues.get(item.value.reference);
        if (referenced !== undefined) knownValues.set(item.targetReference, referenced);
        else knownValues.delete(item.targetReference);
      }
    }
  }
  return { knownValues };
}

// ---------------------------------------------------------------------------
// conditionLogic parsing — shared by both forward evaluation and solving.
// ---------------------------------------------------------------------------

type Token = { type: "NUM"; value: number } | { type: "AND" | "OR" | "LPAREN" | "RPAREN" };
type Expr = { kind: "leaf"; index: number } | { kind: "and"; left: Expr; right: Expr } | { kind: "or"; left: Expr; right: Expr };

function tokenize(logic: string): Token[] {
  const tokens: Token[] = [];
  const re = /\(|\)|AND|OR|\d+/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(logic)) !== null) {
    const t = match[0];
    if (t === "(") tokens.push({ type: "LPAREN" });
    else if (t === ")") tokens.push({ type: "RPAREN" });
    else if (/^and$/i.test(t)) tokens.push({ type: "AND" });
    else if (/^or$/i.test(t)) tokens.push({ type: "OR" });
    else tokens.push({ type: "NUM", value: Number(t) });
  }
  return tokens;
}

/** Recursive-descent parser: orExpr := andExpr (OR andExpr)*, andExpr :=
 *  primary (AND primary)*, primary := NUMBER | '(' orExpr ')'. Standard AND-
 *  binds-tighter-than-OR precedence, parentheses override. */
class LogicParser {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  parse(): Expr {
    const expr = this.parseOr();
    if (this.pos < this.tokens.length) {
      throw new Error(`Unexpected trailing token at position ${this.pos}`);
    }
    return expr;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.peek()?.type === "OR") {
      this.pos++;
      left = { kind: "or", left, right: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parsePrimary();
    while (this.peek()?.type === "AND") {
      this.pos++;
      left = { kind: "and", left, right: this.parsePrimary() };
    }
    return left;
  }

  private parsePrimary(): Expr {
    const t = this.peek();
    if (!t) throw new Error("Unexpected end of conditionLogic expression");
    if (t.type === "LPAREN") {
      this.pos++;
      const expr = this.parseOr();
      const close = this.tokens[this.pos];
      if (close?.type !== "RPAREN") throw new Error("Expected ')' in conditionLogic expression");
      this.pos++;
      return expr;
    }
    if (t.type === "NUM") {
      this.pos++;
      return { kind: "leaf", index: t.value };
    }
    throw new Error(`Unexpected token in conditionLogic expression at position ${this.pos}`);
  }
}

/** Normalizes Flow's literal "and"/"or" conditionLogic values (which apply
 *  across ALL conditions, unnumbered) into the same numbered-index syntax
 *  as an explicit conditionLogic string, then parses it. */
function parseConditionLogic(conditionLogic: string, conditionCount: number): Expr {
  const normalized = conditionLogic.trim();
  let logicToParse = normalized;
  if (/^and$/i.test(normalized)) {
    logicToParse = Array.from({ length: conditionCount }, (_, i) => i + 1).join(" AND ");
  } else if (/^or$/i.test(normalized)) {
    logicToParse = Array.from({ length: conditionCount }, (_, i) => i + 1).join(" OR ");
  }
  return new LogicParser(tokenize(logicToParse)).parse();
}

// ---------------------------------------------------------------------------
// Forward evaluation
// ---------------------------------------------------------------------------

function evaluateComparison(operator: string, left: KnownValue, right: string | number | boolean | undefined): ConditionResult {
  if (right === undefined) return undefined;
  const leftNum = Number(left);
  const rightNum = Number(right);
  let cmp: number | undefined;
  if (!Number.isNaN(leftNum) && !Number.isNaN(rightNum)) {
    cmp = leftNum - rightNum;
  } else {
    const leftDate = Date.parse(String(left));
    const rightDate = Date.parse(String(right));
    if (!Number.isNaN(leftDate) && !Number.isNaN(rightDate)) cmp = leftDate - rightDate;
  }
  if (cmp === undefined) return undefined; // neither numeric nor date-parseable on both sides — flag, don't guess at coercion
  switch (operator) {
    case "GreaterThan":
      return cmp > 0;
    case "GreaterThanOrEqualTo":
      return cmp >= 0;
    case "LessThan":
      return cmp < 0;
    case "LessThanOrEqualTo":
      return cmp <= 0;
    default:
      return undefined;
  }
}

export function evaluateSingleCondition(condition: FlowCondition, ctx: EvaluationContext): ConditionResult {
  const leftKnown = ctx.knownValues.has(condition.leftValueReference);
  const left = ctx.knownValues.get(condition.leftValueReference);

  switch (condition.operator) {
    case "IsNull":
    case "IsBlank":
      if (!leftKnown) return undefined;
      return left === "" || left === undefined;
    case "EqualTo":
      if (!leftKnown) return undefined;
      return String(left) === String(condition.rightValueLiteral);
    case "NotEqualTo":
      if (!leftKnown) return undefined;
      return String(left) !== String(condition.rightValueLiteral);
    case "Contains":
      if (!leftKnown) return undefined;
      return String(left).includes(String(condition.rightValueLiteral));
    case "StartsWith":
      if (!leftKnown) return undefined;
      return String(left).startsWith(String(condition.rightValueLiteral));
    case "EndsWith":
      if (!leftKnown) return undefined;
      return String(left).endsWith(String(condition.rightValueLiteral));
    case "GreaterThan":
    case "GreaterThanOrEqualTo":
    case "LessThan":
    case "LessThanOrEqualTo":
      if (!leftKnown || left === undefined) return undefined;
      return evaluateComparison(condition.operator, left, condition.rightValueLiteral);
    default:
      console.warn(`Condition operator "${condition.operator}" on ${condition.leftValueReference} is not evaluated — leaving unasserted rather than guessing.`);
      return undefined;
  }
}

function kleeneAnd(a: ConditionResult, b: ConditionResult): ConditionResult {
  if (a === false || b === false) return false;
  if (a === true && b === true) return true;
  return undefined;
}

function kleeneOr(a: ConditionResult, b: ConditionResult): ConditionResult {
  if (a === true || b === true) return true;
  if (a === false && b === false) return false;
  return undefined;
}

function evaluateExpr(expr: Expr, group: FlowConditionGroup, ctx: EvaluationContext): ConditionResult {
  if (expr.kind === "leaf") {
    const condition = group.conditions[expr.index - 1];
    if (!condition) return undefined; // conditionLogic references an index that doesn't exist — malformed, don't guess
    return evaluateSingleCondition(condition, ctx);
  }
  const left = evaluateExpr(expr.left, group, ctx);
  const right = evaluateExpr(expr.right, group, ctx);
  return expr.kind === "and" ? kleeneAnd(left, right) : kleeneOr(left, right);
}

/** Three-valued (Kleene) logic, not JS &&/|| — their short-circuit semantics
 *  don't match `undefined` correctly (e.g. OR(true, undefined) must resolve
 *  `true`, not `undefined`, since one true disjunct is already enough). */
export function evaluateConditionGroup(group: FlowConditionGroup, ctx: EvaluationContext): ConditionResult {
  if (group.conditions.length === 0) return true; // an empty rule is vacuously true — matches Flow's own behavior for a conditionless rule
  try {
    const expr = parseConditionLogic(group.conditionLogic, group.conditions.length);
    return evaluateExpr(expr, group, ctx);
  } catch (err) {
    console.warn(`Could not parse conditionLogic "${group.conditionLogic}": ${err instanceof Error ? err.message : String(err)} — leaving unevaluated.`);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Inverse solving — "what inputs make this outcome happen?"
// ---------------------------------------------------------------------------

export type SolveResult = { solvable: true; assignments: Record<string, KnownValue> } | { solvable: false; reason: string };

export function mergeAssignments(a: Record<string, KnownValue>, b: Record<string, KnownValue>): { merged: Record<string, KnownValue> } | { contradiction: string } {
  const merged = { ...a };
  for (const [key, value] of Object.entries(b)) {
    if (key in merged && String(merged[key]) !== String(value)) {
      return { contradiction: `"${key}" would need to be both "${merged[key]}" and "${value}" simultaneously` };
    }
    merged[key] = value;
  }
  return { merged };
}

function solveLeaf(condition: FlowCondition, controllableFields: Map<string, FlowField>, warnings: string[]): SolveResult {
  const field = controllableFields.get(condition.leftValueReference);
  if (!field) {
    return {
      solvable: false,
      reason: `"${condition.leftValueReference}" is not a controllable field on this path (set on a later screen, not a screen field, or otherwise not something a test can directly input).`,
    };
  }
  switch (condition.operator) {
    case "EqualTo": {
      if (condition.rightValueLiteral === undefined) {
        return { solvable: false, reason: `EqualTo condition on ${condition.leftValueReference} has no comparison value.` };
      }
      return { solvable: true, assignments: { [condition.leftValueReference]: condition.rightValueLiteral } };
    }
    case "NotEqualTo": {
      const alternative = field.choices?.find((c) => String(c.value) !== String(condition.rightValueLiteral));
      if (alternative) {
        return { solvable: true, assignments: { [condition.leftValueReference]: alternative.value } };
      }
      warnings.push(
        `NotEqualTo condition on ${condition.leftValueReference}: no alternate real choice value was found — using a synthesized non-matching literal, which may not be realistic input for a manual reviewer.`
      );
      return { solvable: true, assignments: { [condition.leftValueReference]: `__ne_${String(condition.rightValueLiteral)}` } };
    }
    case "IsBlank":
    case "IsNull":
      return { solvable: true, assignments: { [condition.leftValueReference]: "" } };
    default:
      return {
        solvable: false,
        reason: `Operator "${condition.operator}" on ${condition.leftValueReference} can't be deterministically driven to a known-satisfying value — flagged rather than guessed.`,
      };
  }
}

function solveExpr(expr: Expr, group: FlowConditionGroup, controllableFields: Map<string, FlowField>, warnings: string[]): SolveResult {
  if (expr.kind === "leaf") {
    const condition = group.conditions[expr.index - 1];
    if (!condition) return { solvable: false, reason: `conditionLogic references condition ${expr.index}, which doesn't exist.` };
    return solveLeaf(condition, controllableFields, warnings);
  }

  const left = solveExpr(expr.left, group, controllableFields, warnings);
  const right = solveExpr(expr.right, group, controllableFields, warnings);

  if (expr.kind === "and") {
    if (!left.solvable) return left;
    if (!right.solvable) return right;
    const mergeResult = mergeAssignments(left.assignments, right.assignments);
    if ("contradiction" in mergeResult) {
      return { solvable: false, reason: `Contradiction: ${mergeResult.contradiction}.` };
    }
    return { solvable: true, assignments: mergeResult.merged };
  }

  // OR — only one disjunct needs to be true; prefer the first solvable one
  // in source order for determinism.
  if (left.solvable) return left;
  if (right.solvable) return right;
  return { solvable: false, reason: `Neither side of an OR could be solved (${left.reason}) or (${right.reason}).` };
}

/**
 * Given a condition group (a field's visibilityRule, or a Decision
 * outcome's own conditions) and the fields a test can actually set at this
 * point in the path, returns the field values that would make the group
 * true — or a reason it can't be driven deterministically. Never guesses:
 * an unsolvable outcome should be dropped from generation, not faked.
 */
export function solveInputsForOutcome(group: FlowConditionGroup, controllableFields: Map<string, FlowField>): SolveResult {
  if (group.conditions.length === 0) return { solvable: true, assignments: {} };
  try {
    const expr = parseConditionLogic(group.conditionLogic, group.conditions.length);
    const warnings: string[] = [];
    const result = solveExpr(expr, group, controllableFields, warnings);
    if (result.solvable && warnings.length > 0) console.warn(warnings.join(" "));
    return result;
  } catch (err) {
    return { solvable: false, reason: `Could not parse conditionLogic "${group.conditionLogic}": ${err instanceof Error ? err.message : String(err)}` };
  }
}
