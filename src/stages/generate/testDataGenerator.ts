import { FlowField } from "../../types/flowModel";
import { FieldInput } from "../../types/testSpec";
import { KnownValue } from "./conditionEvaluator";
import { BoundaryKind } from "./llmProvider";

/**
 * Stage 2a — test data generation (design doc Section 4.3).
 * Deterministic and metadata-driven, not LLM-driven. Fields flagged
 * UnsupportedCustomComponent are skipped here — they're handled by the
 * test case generator, which records them as a "needs manual test data"
 * gap rather than fabricating an interaction.
 */

function validValueFor(field: FlowField): string | number | boolean {
  if (field.choices && field.choices.length > 0) {
    return field.choices[0].value;
  }
  switch (field.kind) {
    case "Number":
    case "Currency":
      return 100;
    case "Boolean":
      return true;
    case "Date":
      return new Date().toISOString().slice(0, 10);
    case "DateTime":
      return new Date().toISOString();
    case "Email":
      return `test.${field.apiName}.${Date.now()}@example.com`.toLowerCase();
    case "Lookup":
      // Fallback only — the executor queries a real record from the
      // lookup's target object (field.lookupObjectApiName) and searches by
      // its actual Name instead of guessing. This value is only used if
      // that query can't run or returns nothing.
      return "a";
    case "Text":
    default:
      return `Test ${field.apiName} ${Date.now()}`;
  }
}

function boundaryOrInvalidValueFor(field: FlowField): string | number | boolean {
  switch (field.kind) {
    case "Number":
    case "Currency":
      return -1;
    case "Boolean":
      return false;
    case "Date":
      return "0001-01-01";
    case "Text":
    default:
      return ""; // exercises required-field enforcement when field.required is true
  }
}

export function fillableFields(fields: FlowField[]): FlowField[] {
  return fields.filter((f) => f.kind !== "UnsupportedCustomComponent" && f.kind !== "DisplayText");
}

/** One valid-input set and, for required fields, one boundary/invalid set. */
export function generateFieldInputs(fields: FlowField[]): { valid: FieldInput[]; boundary: FieldInput[] } {
  const usable = fillableFields(fields);

  const valid: FieldInput[] = usable.map((f) => ({
    apiName: f.apiName,
    locatorLabel: f.label,
    value: validValueFor(f),
    isBoundaryOrInvalid: false,
    interactionKind: f.kind === "Lookup" ? "LookupSelect" : "Fill",
    lookupObjectApiName: f.kind === "Lookup" ? f.lookupObjectApiName : undefined,
    lookupSearchFieldApiName: f.kind === "Lookup" ? f.lookupSearchFieldApiName : undefined,
  }));

  const boundary: FieldInput[] = usable
    .filter((f) => f.required)
    .map((f) => ({
      apiName: f.apiName,
      locatorLabel: f.label,
      value: boundaryOrInvalidValueFor(f),
      isBoundaryOrInvalid: true,
      interactionKind: f.kind === "Lookup" ? "LookupSelect" : "Fill",
      lookupObjectApiName: f.kind === "Lookup" ? f.lookupObjectApiName : undefined,
      lookupSearchFieldApiName: f.kind === "Lookup" ? f.lookupSearchFieldApiName : undefined,
    }));

  return { valid, boundary };
}

const FAR_FUTURE_DATE = "9999-12-31";
const MAX_LENGTH_TEXT = "X".repeat(300); // well past any realistic Salesforce text field's 255-char default max

/** Named boundary-value recipes beyond the single hardcoded one
 *  generateFieldInputs uses — only ever invoked from scenarioCompiler.ts
 *  when an LLM-proposed scenario names a specific boundaryKind. The
 *  deterministic generator's own boundary generation (above) is untouched. */
export function generateBoundaryValue(field: FlowField, kind: BoundaryKind): FieldInput {
  let value: string | number | boolean;
  switch (kind) {
    case "MaxLength":
      value = field.kind === "Text" || field.kind === "Email" ? MAX_LENGTH_TEXT : boundaryOrInvalidValueFor(field);
      break;
    case "InvalidFormat":
      value = field.kind === "Email" ? "not-an-email" : field.kind === "Date" || field.kind === "DateTime" ? "not-a-date" : "!!!invalid!!!";
      break;
    case "Negative":
      value = field.kind === "Number" || field.kind === "Currency" ? -999999 : boundaryOrInvalidValueFor(field);
      break;
    case "FarFutureDate":
      value = field.kind === "Date" ? FAR_FUTURE_DATE : field.kind === "DateTime" ? `${FAR_FUTURE_DATE}T00:00:00.000Z` : boundaryOrInvalidValueFor(field);
      break;
    case "EmptyRequired":
      value = "";
      break;
    case "Other":
    default:
      value = boundaryOrInvalidValueFor(field);
      break;
  }
  return {
    apiName: field.apiName,
    locatorLabel: field.label,
    value,
    isBoundaryOrInvalid: true,
    interactionKind: field.kind === "Lookup" ? "LookupSelect" : "Fill",
    lookupObjectApiName: field.kind === "Lookup" ? field.lookupObjectApiName : undefined,
    lookupSearchFieldApiName: field.kind === "Lookup" ? field.lookupSearchFieldApiName : undefined,
  };
}

/** Builds inputs for one screen, using `overrides` (from
 *  conditionEvaluator's solveInputsForOutcome) wherever a field's apiName
 *  is present in it, and falling back to the same default valid value used
 *  by generateFieldInputs otherwise. This is what lets a solved assignment
 *  map (e.g. "Contact_Type must be 'New' to reach this path") actually turn
 *  into a real, fillable input rather than just describing the requirement. */
export function buildScreenInputs(fields: FlowField[], overrides: Record<string, KnownValue> = {}): FieldInput[] {
  return fillableFields(fields).map((f) => {
    const overrideValue = overrides[f.apiName];
    const value = overrideValue !== undefined ? overrideValue : validValueFor(f);
    return {
      apiName: f.apiName,
      locatorLabel: f.label,
      value,
      isBoundaryOrInvalid: false,
      interactionKind: f.kind === "Lookup" ? "LookupSelect" : "Fill",
      lookupObjectApiName: f.kind === "Lookup" ? f.lookupObjectApiName : undefined,
      lookupSearchFieldApiName: f.kind === "Lookup" ? f.lookupSearchFieldApiName : undefined,
    };
  });
}
