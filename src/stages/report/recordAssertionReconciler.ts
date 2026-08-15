import { CapturedDmlRecord, TestCaseExecutionResult } from "../../types/runResult";

/**
 * Stage 4 (post-execution) — resolves RecordFieldEquals assertions that
 * screenFlowExecutor.ts couldn't evaluate live (no Salesforce connection
 * mid-browser-run) against the DML actually captured for that specific test
 * case (orchestrator.ts now captures DML per test case, not once for the
 * whole run — see dmlCapture.ts doc comment on why that's what makes this
 * tractable).
 *
 * Zero matching candidates and multiple matching candidates are DIFFERENT
 * failure classes, deliberately not conflated: zero is real signal the
 * flow's DML never fired (or a field got silently dropped by namespace
 * resolution) — that's a Failed case. Multiple is a harness limitation (we
 * can't tell which record the flow actually produced) — that's Skipped,
 * not a confirmed defect.
 */

/** Field snapshot keys are the org's REAL (possibly namespace-prefixed)
 *  field API names, resolved at capture time — but a RecordFieldEquals
 *  assertion's targetApiName is the raw name from the flow's own metadata.
 *  Same suffix-matching fallback namespaceResolver.ts uses elsewhere. */
function findFieldValue(fieldSnapshot: Record<string, unknown>, targetApiName: string): { found: true; value: unknown } | { found: false } {
  if (targetApiName in fieldSnapshot) return { found: true, value: fieldSnapshot[targetApiName] };
  const suffixMatch = Object.keys(fieldSnapshot).find((k) => k.endsWith(`__${targetApiName}`));
  if (suffixMatch) return { found: true, value: fieldSnapshot[suffixMatch] };
  return { found: false };
}

function candidatesFor(records: CapturedDmlRecord[], objectApiName: string | undefined, targetApiName: string): CapturedDmlRecord[] {
  return records.filter((r) => {
    if (objectApiName && r.objectApiName !== objectApiName) return false;
    return findFieldValue(r.fieldSnapshot, targetApiName).found;
  });
}

export function reconcileRecordAssertions(caseResults: TestCaseExecutionResult[]): TestCaseExecutionResult[] {
  return caseResults.map((result) => {
    if (result.status !== "Passed" || !result.pendingRecordAssertions || result.pendingRecordAssertions.length === 0) {
      return result;
    }

    const capturedRecords = result.capturedRecords ?? [];

    for (const assertion of result.pendingRecordAssertions) {
      const candidates = candidatesFor(capturedRecords, assertion.objectApiName, assertion.targetApiName);

      if (candidates.length === 0) {
        return {
          ...result,
          status: "Failed",
          failureReason: `Expected DML on ${assertion.objectApiName ?? "the target object"} to produce a record with ${assertion.targetApiName} = "${assertion.expectedValue}", but no matching record was captured within this test case's execution window. Either the flow's DML step didn't fire, or namespace resolution dropped the field — check console warnings from namespaceResolver.ts for this run.`,
        };
      }

      if (candidates.length > 1) {
        return {
          ...result,
          status: "Skipped",
          failureReason: `Could not disambiguate between ${candidates.length} candidate records for "${assertion.targetApiName}" on ${assertion.objectApiName ?? "the target object"} — harness limitation, not a confirmed flow defect.`,
        };
      }

      const actual = findFieldValue(candidates[0].fieldSnapshot, assertion.targetApiName);
      const actualValue = actual.found ? actual.value : undefined;
      if (String(actualValue) !== String(assertion.expectedValue)) {
        return {
          ...result,
          status: "Failed",
          failureReason: `Expected ${assertion.targetApiName} on the resulting ${assertion.objectApiName ?? "record"} to equal "${assertion.expectedValue}" but found "${actualValue}".`,
        };
      }
    }

    return result; // every pending assertion resolved and matched — stays Passed
  });
}
