import { Connection } from "jsforce";
import { SalesforceSession } from "./auth/salesforceAuth";
import { analyzeFlowFromFile } from "./stages/analyze/flowAnalyzer";
import { generateTestSpec } from "./stages/generate/testCaseGenerator";
import { runScreenFlowTestCase } from "./stages/execute/screenFlowExecutor";
import { captureDmlForRun, FieldNameResolver } from "./stages/report/dmlCapture";
import { reconcileRecordAssertions } from "./stages/report/recordAssertionReconciler";
import { writeRunToSalesforce } from "./stages/report/salesforceReporter";
import { buildObjectNameResolver } from "./salesforce/namespaceResolver";
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
 *
 * DML capture runs PER TEST CASE, not once for the whole run — test cases
 * already execute strictly sequentially below, so each one naturally has
 * its own disjoint time window. That's what makes RecordFieldEquals
 * disambiguation in recordAssertionReconciler.ts tractable (see
 * dmlCapture.ts doc comment). The object/field name resolvers are built
 * once here and reused across every test case's capture call, so this
 * doesn't multiply describe() calls by the number of test cases.
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

  // Every DML element anywhere in the graph — a given test case may
  // traverse any path, so watching the full node set (not just one path)
  // is what keeps capture correct regardless of which path a case exercises.
  const dmlElements: FlowDmlElement[] = Object.values(flowModel.nodes).filter(
    (n): n is FlowDmlElement => n.kind === "RecordCreate" || n.kind === "RecordUpdate" || n.kind === "RecordDelete"
  );

  const resolveObjectName = await buildObjectNameResolver(conn);
  const fieldResolverCache = new Map<string, FieldNameResolver>();

  // Stage 3 — screen-flow-only for v1 (record-triggered support deferred
  // per the scope narrowing agreed for this pivot)
  const caseResults: TestCaseExecutionResult[] = [];
  for (const testCase of spec.testCases) {
    const caseStart = new Date().toISOString();
    const result = await runScreenFlowTestCase(conn, session, flowModel.flowApiName, testCase);
    const caseEnd = new Date().toISOString();

    // Stage 4a — DML capture, scoped to this test case's own execution
    // window (see module doc comment above on why per-case, not per-run).
    const capturedRecords =
      dmlElements.length > 0
        ? await captureDmlForRun(conn, dmlElements, caseStart, caseEnd, runningUserId, testCase.id, resolveObjectName, fieldResolverCache)
        : [];

    caseResults.push({ ...result, capturedRecords });
  }

  const endTime = new Date().toISOString();

  // Resolve any RecordFieldEquals assertions the executor couldn't verify
  // live, now that each case's own capturedRecords are attached.
  const reconciledCaseResults = reconcileRecordAssertions(caseResults);

  const capturedRecords = reconciledCaseResults.flatMap((r) => r.capturedRecords ?? []);

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
    caseResults: reconciledCaseResults,
    capturedRecords,
  };

  // Stage 4b — write results back to Salesforce
  await writeRunToSalesforce(conn, runResult);

  return runResult;
}
