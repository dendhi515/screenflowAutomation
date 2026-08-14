import jsforce, { Connection } from "jsforce";
import { FlowTestRunResult } from "../../types/runResult";
import { buildObjectNameResolver, buildFieldNameResolver, resolveFieldPayload } from "../../salesforce/namespaceResolver";

/**
 * Stage 4 — reporting (design doc Section 4.8).
 * Writes the run into the three custom objects defined in the design doc
 * Section 7: Flow_Test_Run__c -> Flow_Test_Case_Result__c (detail) and
 * Flow_Test_Run__c -> Flow_Test_Run_Record__c (DML capture rows).
 *
 * This org has a registered namespace ("RefreshPackage"), which Salesforce
 * auto-prefixes onto every custom object/field deployed here — including
 * these reporting objects themselves, even though the metadata we deployed
 * declared plain names. Discovered against the real org, not assumed to be
 * universal: an unmanaged/non-namespaced org would keep the plain names.
 * Resolved at runtime via namespaceResolver rather than hardcoding
 * "RefreshPackage__" so this still works in either kind of org.
 */

export async function writeRunToSalesforce(conn: Connection, run: FlowTestRunResult): Promise<string> {
  const passedCount = run.caseResults.filter((r) => r.status === "Passed").length;
  const failedCount = run.caseResults.filter((r) => r.status === "Failed").length;

  const resolveObjectName = await buildObjectNameResolver(conn);
  const runObjectName = resolveObjectName("Flow_Test_Run__c");
  const caseObjectName = resolveObjectName("Flow_Test_Case_Result__c");
  const recordObjectName = resolveObjectName("Flow_Test_Run_Record__c");

  const resolveRunField = await buildFieldNameResolver(conn, runObjectName);
  const runRecord = await conn.sobject(runObjectName).create(
    resolveFieldPayload(resolveRunField, {
      Flow_API_Name__c: run.flowApiName,
      Flow_Label__c: run.flowLabel,
      Flow_Type__c: "Screen Flow",
      Flow_Version__c: run.flowVersion ?? null,
      Environment__c: run.environment,
      Executed_By__c: run.executedBy,
      Status__c: "Completed",
      Start_Time__c: run.startTime,
      End_Time__c: run.endTime,
      Total_Test_Cases__c: run.caseResults.length,
      Passed_Count__c: passedCount,
      Failed_Count__c: failedCount,
      Test_Plan__c: run.testPlanMarkdown,
    })
  );

  if (!runRecord.success) {
    throw new Error(`Failed to create ${runObjectName}: ${JSON.stringify(runRecord)}`);
  }
  const runId = runRecord.id;

  // The lookup/master-detail field back to the parent is itself named
  // "Flow_Test_Run__c" on both child objects — resolve it the same way as
  // any other field, not assumed to equal runObjectName's resolved name
  // (it happens to match here, but that's not guaranteed in general).
  if (run.caseResults.length > 0) {
    const resolveCaseField = await buildFieldNameResolver(conn, caseObjectName);
    await conn.sobject(caseObjectName).create(
      run.caseResults.map((r) =>
        resolveFieldPayload(resolveCaseField, {
          Flow_Test_Run__c: runId,
          Screen_API_Name__c: r.screenApiName ?? null,
          Test_Case_Description__c: r.description,
          Status__c: r.status,
          Failure_Reason__c: r.failureReason ?? null,
          Executed_At__c: r.executedAt,
        })
      )
    );
    // TODO: upload r.screenshotPaths as ContentVersion + ContentDocumentLink
    // against each Flow_Test_Case_Result__c once screenshot capture is wired in.
  }

  if (run.capturedRecords.length > 0) {
    const resolveRecordField = await buildFieldNameResolver(conn, recordObjectName);
    await conn.sobject(recordObjectName).create(
      run.capturedRecords.map((rec) =>
        resolveFieldPayload(resolveRecordField, {
          Flow_Test_Run__c: runId,
          Object_API_Name__c: rec.objectApiName,
          Record_Id__c: rec.recordId,
          Operation__c: rec.operation,
          Field_Snapshot__c: JSON.stringify(rec.fieldSnapshot),
          Record_URL__c: rec.recordUrl,
        })
      )
    );
  }

  return runId;
}
