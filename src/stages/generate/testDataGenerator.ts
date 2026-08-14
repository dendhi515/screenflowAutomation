import { FlowField } from "../../types/flowModel";
import { FieldInput } from "../../types/testSpec";

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
