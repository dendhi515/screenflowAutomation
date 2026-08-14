import { Router } from "express";
import { connectionFor } from "../auth/salesforceAuth";
import { runFlowTest } from "../orchestrator";

export const testRunRouter = Router();

/** Triggers the full 4-stage pipeline for a user-selected flow. */
testRunRouter.post("/", async (req, res) => {
  const session = req.session.salesforce;
  const runningUserId = req.session.runningUserId;
  if (!session || !runningUserId) {
    return res.status(401).json({ error: "Not authenticated — visit /oauth/login first" });
  }

  const { flowFilePath } = req.body as { flowFilePath?: string };
  if (!flowFilePath) {
    return res.status(400).json({ error: "flowFilePath is required (path to a local .flow-meta.xml file)" });
  }

  try {
    const conn = connectionFor(session);
    const result = await runFlowTest(conn, session, flowFilePath, runningUserId);
    res.json({ result });
  } catch (err) {
    console.error("Test run failed:", err); // full stack trace for local debugging
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
