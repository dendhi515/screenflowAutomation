/** Local verification tool — not part of the running service, no server
 *  or Salesforce connection required. Run with:
 *  npx ts-node --transpile-only src/devSmokeTest.ts
 *  Exercises Stage 1 (parse) + Stage 2 (generate) against examples/
 *  Demo_Contact_Intake.flow-meta.xml so you can sanity-check the parser
 *  and test-case generator against a new flow file before wiring up
 *  Playwright/Salesforce at all. Point `filePath` below at a different
 *  .flow-meta.xml to try it against a real retrieved flow. */
import path from "path";
import { analyzeFlowFromFile } from "./stages/analyze/flowAnalyzer";
import { generateTestSpec } from "./stages/generate/testCaseGenerator";

async function main() {
  const filePath = path.join(__dirname, "..", "examples", "Demo_Contact_Intake.flow-meta.xml");
  const model = analyzeFlowFromFile(filePath);

  console.log("=== FlowModel ===");
  console.log("flowApiName:", model.flowApiName);
  console.log("path (traversal order):", model.path.map((n) => `${n.kind}:${n.apiName}`));
  console.log(
    "fields per screen:",
    model.path
      .filter((n) => n.kind === "Screen")
      .map((s: any) => ({
        screen: s.apiName,
        fields: s.fields.map((f: any) => ({ name: f.apiName, kind: f.kind, required: f.required, visibility: f.visibilityRule })),
      }))
  );

  const spec = await generateTestSpec(model);
  console.log("\n=== TestSpec ===");
  console.log("test case count:", spec.testCases.length);
  for (const tc of spec.testCases) {
    console.log(`\n- ${tc.id}: ${tc.description}`);
    for (const step of tc.steps ?? []) {
      console.log(`  screen ${step.screenApiName}`);
      console.log(
        "    inputs:",
        step.inputs.map((i) => `${i.apiName}=${i.value}`)
      );
      console.log(
        "    assertions:",
        step.assertions.map((a) => `${a.type}(${a.targetLabel})`)
      );
    }
  }

  console.log("\n=== Test plan markdown ===\n");
  console.log(spec.testPlanMarkdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
