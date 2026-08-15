/** Local verification tool — not part of the running service, no server
 *  or Salesforce connection required. Run with:
 *  npx ts-node --transpile-only src/devSmokeTest.ts [path-to-flow-meta.xml]
 *  Exercises Stage 1 (parse) + Stage 2 (generate). Defaults to
 *  examples/Demo_Contact_Intake.flow-meta.xml (single linear path — no
 *  Decision/Loop); pass examples/Demo_Approval_Routing.flow-meta.xml (or a
 *  real retrieved flow) as an argument to see branch-coverage path
 *  enumeration in action. */
import path from "path";
import { analyzeFlowFromFile } from "./stages/analyze/flowAnalyzer";
import { generateTestSpec } from "./stages/generate/testCaseGenerator";

async function main() {
  const filePathArg = process.argv[2];
  const filePath = filePathArg ? path.resolve(filePathArg) : path.join(__dirname, "..", "examples", "Demo_Contact_Intake.flow-meta.xml");
  const model = analyzeFlowFromFile(filePath);

  console.log("=== FlowModel ===");
  console.log("flowApiName:", model.flowApiName);
  console.log(
    "paths:",
    model.paths.map((p) => ({ id: p.id, description: p.description, nodes: p.nodes.map((n) => `${n.kind}:${n.apiName}`) }))
  );
  if (model.analysisNotes.length > 0) {
    console.log("analysis notes:", model.analysisNotes);
  }
  console.log(
    "fields per screen (base path):",
    (model.paths.find((p) => p.id === "base")?.nodes ?? [])
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
