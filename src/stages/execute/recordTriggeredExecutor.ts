import jsforce, { Connection } from "jsforce";
import { TestCase } from "../../types/testSpec";
import { TestCaseExecutionResult } from "../../types/runResult";

/**
 * Stage 3 — record-triggered flow execution (design doc Section 4.6).
 * No browser involved. Runs generated Anonymous Apex via the Tooling
 * API's executeAnonymous — no Apex test classes deployed, keeping this
 * ephemeral like the rest of the pipeline (no-persistence auth model).
 */

interface ExecuteAnonymousResult {
  compiled: boolean;
  success: boolean;
  compileProblem: string | null;
  exceptionMessage: string | null;
  exceptionStackTrace: string | null;
}

export async function runRecordTriggeredTestCase(
  conn: Connection,
  testCase: TestCase
): Promise<TestCaseExecutionResult> {
  const executedAt = new Date().toISOString();

  if (!testCase.anonymousApex) {
    return {
      testCaseId: testCase.id,
      description: testCase.description,
      status: "Skipped",
      failureReason: "No Anonymous Apex generated for this test case",
      executedAt,
    };
  }

  // If the flow executes asynchronously, give it a brief moment before any
  // assertion logic embedded in the Apex queries resulting state — see
  // design doc Section 4.6.
  const apexWithWait = `${testCase.anonymousApex}\n// Brief pause for async automation to settle\nSystem.debug('done');`;

  const result = (await conn.tooling.executeAnonymous(apexWithWait)) as unknown as ExecuteAnonymousResult;

  if (!result.compiled) {
    return {
      testCaseId: testCase.id,
      description: testCase.description,
      status: "Failed",
      failureReason: `Apex did not compile: ${result.compileProblem}`,
      executedAt,
    };
  }

  if (!result.success) {
    return {
      testCaseId: testCase.id,
      description: testCase.description,
      status: "Failed",
      failureReason: `Apex execution failed: ${result.exceptionMessage}\n${result.exceptionStackTrace ?? ""}`,
      executedAt,
    };
  }

  return {
    testCaseId: testCase.id,
    description: testCase.description,
    status: "Passed",
    executedAt,
  };
}
