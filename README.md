# sf-flow-test-automation

Orchestration service for the Salesforce flow test automation project. See
`Salesforce_Flow_Test_Automation_Design_Doc.docx` for the full design —
this README only covers running the scaffold.

**v1 scope is deliberately narrow: screen flows only**, one flow at a
time, from a local `.flow-meta.xml` file. Record-triggered flows,
Decision-branch traversal, loops, subflows, and dependent picklists are
explicitly deferred — see "Known gaps" below and the design doc addendum
on the local-file pivot.

## What's here

Four pipeline stages, sequenced by `src/orchestrator.ts`:

1. **Analyze** (`src/stages/analyze/flowAnalyzer.ts`) — reads a
   `.flow-meta.xml` file from disk (no Salesforce call) and parses it into
   a **graph** traversed from `<start>`, not a flat screen list — a real
   flow's runtime order isn't the same as its document order once
   branching exists, even though v1 only ever walks a single linear path.
   Resolves `<choices>` references to actual selectable values, resolves
   structured visibility conditions (`leftValueReference`/`operator`/
   `rightValue` — not free-text formulas), and flags
   `ComponentInstance` (custom LWC) fields as unsupported rather than
   guessing how to fill them.
2. **Generate** (`src/stages/generate`) — deterministic test data
   generation, plus test case generation that evaluates each visibility
   condition itself (`EqualTo`/`NotEqualTo` only for v1) so it knows the
   expected Present/Absent outcome before Playwright checks the DOM.
   LLM provider is deferred — see design doc Section 6/9; the interface in
   `llmProvider.ts` is ready for one to be wired in later.
3. **Execute** (`src/stages/execute/screenFlowExecutor.ts`) — Playwright,
   local Chromium. Implements `FieldPresent`, `FieldAbsent`, and
   `FieldRequiredEnforced` assertions against the running flow in a real,
   authenticated Salesforce session (frontdoor.jsp bootstrap).
4. **Report** (`src/stages/report`) — DML/record capture (still needs the
   live Salesforce connection — see below), then writes everything back
   to the three custom objects in design doc Section 7.

Auth (`src/auth/salesforceAuth.ts`) is per-visit OAuth with PKCE — no
client secret, nothing persisted to disk.

**Important: reading the flow moved to a local file, but execution and
DML capture did not.** Playwright still has to open the flow in a real,
live org, and DML capture still needs an authenticated API connection to
query resulting records — there's no way to test rendered Lightning UI
without a real org behind it. Keep the local file in sync with what's
actually deployed; a stale file means testing expectations that don't
match what's really in the org.

## Setup

1. Create the Connected App per design doc Section 8 (one per Salesforce
   org you want to test against). Note the Consumer Key.
2. Deploy the three custom objects via the generated metadata in
   `salesforce-metadata/`: `cd salesforce-metadata && sf project deploy start -d force-app -o <your-org-alias>`.
   Requires the Salesforce CLI and that org already authenticated
   (`sf org login web -a <your-org-alias>`). Review sharing/FLS defaults
   in Setup afterward.
3. `cp .env.example .env` and fill in `SF_CLIENT_ID` (and `SF_LOGIN_URL`
   if targeting a sandbox).
4. `npm install`
5. `npx playwright install chromium` — one-time download of the actual
   Chromium binary Playwright drives.
6. Retrieve the real flow you want to test, e.g.
   `sf project retrieve start -m "Flow:My_Flow_Name" -o <your-org-alias>`,
   which lands it at `force-app/main/default/flows/My_Flow_Name.flow-meta.xml`.
7. Try `npm run smoke-test` first — parses and generates test cases from
   `examples/Demo_Contact_Intake.flow-meta.xml` with no server, no
   Salesforce, no Playwright involved. Good for sanity-checking the parser
   against a newly retrieved real flow (point `filePath` in
   `src/devSmokeTest.ts` at it) before running the full pipeline.
8. `npm run dev`, then visit `http://localhost:3000/oauth/login` to
   authenticate, and `POST /api/test-runs` with
   `{ "flowFilePath": "/absolute/path/to/My_Flow_Name.flow-meta.xml" }`
   to run the full pipeline end to end.

## Known gaps (intentional, for the next pairing session)

- **Decision elements (branching) aren't parsed.** The graph walk in
  `flowAnalyzer.ts` stops at the first node type it doesn't recognize —
  which currently includes Decisions. A flow with any branch in it will
  only get the path up to that Decision, not an error, so double check
  `model.path` covers what you expect. This is the single biggest thing
  to add next given how central it is to "every scenario."
- Loops, subflows, and dependent picklists are unparsed for the same
  reason — deferred by explicit agreement, not silently missing.
- Visibility rules with more than one condition (`conditionLogic` like
  "1 AND 2") are detected and logged as a warning, not evaluated — only
  single-condition rules generate assertions.
- `FieldValueEquals` / `RecordFieldEquals` assertions are typed but not
  implemented — currently a no-op that always passes rather than a false
  failure.
- Custom LWC screen fields (`ComponentInstance`) are flagged in the test
  plan under "Needs manual attention" and excluded from auto-fill — by
  design, not a gap to close generically (see design doc discussion on why
  a generic fill strategy would be dishonest here).
- No front-end yet — this is API-only.
