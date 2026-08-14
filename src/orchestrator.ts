import { Connection } from "jsforce";
import { SalesforceSession } from "./auth/salesforceAuth";
import { analyzeFlowFromFile } from "./stages/analyze/flowAnalyzer";
import { generateTestSpec } from "./stages/generate/testCaseGenerator";
import { runScreenFlowTestCase } from "./stages/execute/screenFlowExecutor";
import { captureDmlForRun } from "./stages/report/dmlCapture";
import { writeRunToSalesforce } from "./stages/report/salesforceReporter";
import { FlowDmlElement } from "./types/flowModel";
import { FlowTestRunResult, TestCaseExecutionResult } from "./types/runResult";

/**
 * Sequences the four pipeline stages for a single test run (design doc
 * addendum: local-file pivot, screen-flow-only scope for v1).
 *
 * Stage 1 now reads a local .flow-meta.xml file instead of calling the
 * Salesforce Metadata API. Stages 2-4 are unchanged in shape: execution
 * and DML capture still need the live, per-visit-authenticated Salesforce
 * connection, since Playwright has to open the flow in a real org and DML
 * capture has to query real resulting records.
 */
export async function runFlowTest(
  conn: Connection,
  session: SalesforceSession,
  flowFilePath: string,
  runningUserId: string
): Promise<FlowTestRunResult> {
  const startTime = new Date().toISOString();

  // Stage 1 — local file, no Salesforce call
  const flowModel = analyzeFlowFromFile(flowFilePath);

  // Stage 2
  const spec = await generateTestSpec(flowModel);

  // Stage 3 — screen-flow-only for v1 (record-triggered support deferred
  // per the scope narrowing agreed for this pivot)
  const caseResults: TestCaseExecutionResult[] = [];
  for (const testCase of spec.testCases) {
    caseResults.push(await runScreenFlowTestCase(conn, session, flowModel.flowApiName, testCase));
  }

  const endTime = new Date().toISOString();

  // Stage 4a — DML capture, derived from the DML elements found on the
  // traversed path (RecordCreate/RecordUpdate/RecordDelete nodes)
  const dmlElements: FlowDmlElement[] = flowModel.path.filter(
    (n): n is FlowDmlElement => n.kind === "RecordCreate" || n.kind === "RecordUpdate" || n.kind === "RecordDelete"
  );
  const capturedRecords = await captureDmlForRun(conn, dmlElements, startTime, endTime, runningUserId);

  const runResult: FlowTestRunResult = {
    flowApiName: flowModel.flowApiName,
    flowLabel: flowModel.flowLabel,
    flowType: "ScreenFlow",
    sourcePath: flowModel.sourcePath,
    environment: conn.instanceUrl ?? "unknown",
    executedBy: runningUserId,
    startTime,
    endTime,
    testPlanMarkdown: spec.testPlanMarkdown,
    caseResults,
    capturedRecords,
  };

  // Stage 4b — write results back to Salesforce
  await writeRunToSalesforce(conn, runResult);

  return runResult;
}
