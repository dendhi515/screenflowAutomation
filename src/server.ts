import express from "express";
import session from "express-session";
import cors from "cors";
import path from "path";
import { config, assertSalesforceConfigured } from "./config";
import { authRouter } from "./routes/auth";
import { testRunRouter } from "./routes/testRun";

assertSalesforceConfigured();

const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// In-memory session store — deliberate for v1: nothing about the org
// connection persists between visits (design doc Section 4.1 / Section 5).
// Restarting the service clears every active session, which is the point.
app.use(
  session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax" },
  })
);

app.use("/oauth", authRouter);
app.use("/api/test-runs", testRunRouter);

app.get("/health", (_req, res) => res.json({ ok: true }));

// Serves screenshots captured during execution (screenFlowExecutor.ts) so
// the dev UI can show them inline — real evidence of what the browser saw,
// not just a pass/fail boolean.
app.use("/screenshots", express.static(path.join(process.cwd(), "screenshots")));

// Minimal local dev UI — a single static page with a login link and a
// button to trigger a test run via fetch (same-origin, so the session
// cookie from /oauth/login is sent automatically — no manual cookie
// copying needed). Not a real front-end (design doc Section 6 defers
// that), just enough to drive the pipeline without curl/Postman friction.
app.use(express.static(path.join(__dirname, "..", "public")));

app.listen(config.port, () => {
  console.log(`sf-flow-test-automation orchestration service listening on http://localhost:${config.port}`);
  console.log(`Start auth at http://localhost:${config.port}/oauth/login`);
});
