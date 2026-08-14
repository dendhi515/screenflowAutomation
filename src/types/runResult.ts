/** Output of Stage 3 (execution) and Stage 4 (DML capture + report),
 *  shaped to map directly onto the Salesforce data model (design doc
 *  Section 7: Flow_Test_Run__c / Flow_Test_Case_Result__c / Flow_Test_Run_Record__c). */

export type TestCaseStatus = "Passed" | "Failed" | "Skipped";
export type DmlOperation = "Insert" | "Update" | "Delete";

export interface TestCaseExecutionResult {
  testCaseId: string;
  screenApiName?: string;
  description: string;
  status: TestCaseStatus;
  failureReason?: string;
  executedAt: string; // ISO timestamp
  screenshotPaths?: string[]; // local paths, uploaded as Salesforce Files at report time
}

export interface CapturedDmlRecord {
  objectApiName: string;
  recordId: string;
  operation: DmlOperation;
  fieldSnapshot: Record<string, unknown>;
  recordUrl: string;
}

export interface FlowTestRunResult {
  flowApiName: string;
  flowLabel: string;
  flowType: "ScreenFlow";
  /** No longer populated from a live version query — the flow definition
   *  comes from a local file now (design doc addendum: local-file pivot).
   *  Kept optional rather than removed since Flow_Version__c still exists
   *  on the Salesforce object; left null when unknown. */
  flowVersion?: number;
  sourcePath: string;
  environment: string;
  executedBy: string;
  startTime: string; // ISO timestamp — also the DML correlation window start
  endTime: string;
  testPlanMarkdown: string;
  caseResults: TestCaseExecutionResult[];
  capturedRecords: CapturedDmlRecord[];
}
