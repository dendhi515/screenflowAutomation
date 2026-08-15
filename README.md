# sf-flow-test-automation

Orchestration service for the Salesforce flow test automation project. See
`Salesforce_Flow_Test_Automation_Design_Doc.docx` for the full design —
this README only covers running the scaffold.

**Screen flows only**, one flow at a time, from a local `.flow-meta.xml`
file. Record-triggered flows are still out of scope (`recordTriggeredExecutor.ts`
is a stub) — everything else in a screen flow's graph (Decisions, Loops,
Subflows, RecordLookups, Assignments, multi-condition visibility) is parsed
and used for test generation. See "Known gaps" below for what's still
intentionally not covered.

## What's here

Four pipeline stages, sequenced by `src/orchestrator.ts`:

1. **Analyze** (`src/stages/analyze/flowAnalyzer.ts`) — reads a
   `.flow-meta.xml` file from disk (no Salesforce call) and parses it into
   a full **graph**: Screens, Decisions, Loops, Subflows, RecordLookups,
   Assignments, and DML elements, each with a uniform `next: string[]`.
   `FlowModel.paths` holds multiple traversals — **branch coverage**, not
   exhaustive path coverage: one base path (every decision at its default
   outcome, every loop at 0 iterations), plus one path per non-default
   Decision outcome and one per Loop at 1 iteration. Loop iteration
   modeling only supports 0 or 1 iterations by design (see the comment on
   `walkPath`). Subflow internals aren't analyzed — flagged in
   `testPlanMarkdown` instead. Resolves `<choices>` references to actual
   selectable values, and flags `ComponentInstance` (custom LWC) fields as
   unsupported rather than guessing how to fill them.
2. **Generate** (`src/stages/generate`) — two layers:
   - **Deterministic** (`testCaseGenerator.ts`, always runs, the coverage
     baseline): one test case per path, plus one per conditional field
     whose visibility can be *solved* — `conditionEvaluator.ts` does real
     three-valued (Kleene) logic evaluation of `conditionLogic` (`"1"`,
     `"and"`/`"or"`, `"(1 AND 2) OR 3"`, ...) and a separate *inverse
     solver* that works out what input values actually drive a branch or
     make a field visible, so a "branch coverage" case genuinely exercises
     that branch rather than just claiming to. Unsolvable conditions
     (referencing org/runtime-only data, or operators like `GreaterThan`)
     are dropped from generation with a note in `testPlanMarkdown`, never
     guessed. Plus one required-field boundary case per unconditionally
     required field.
   - **LLM-proposed** (`providers/claudeProvider.ts`, additive, optional):
     if `LLM_PROVIDER`/`LLM_API_KEY` are configured, Claude reads a
     condensed view of the parsed `FlowModel` (not raw XML) and proposes
     extra scenarios — new/unusual fields worth checking, business-logic
     edge cases, data-type boundary values. The model only *proposes*:
     `scenarioValidator.ts` checks every field/choice/outcome name it
     references against the real `FlowModel` before anything is trusted,
     and `scenarioCompiler.ts` turns validated proposals into real
     `TestCase`s using the same deterministic machinery as the baseline.
     If unconfigured, or the API call fails for any reason, this step is
     skipped with a warning — deterministic coverage always ships
     regardless.
3. **Execute** (`src/stages/execute/screenFlowExecutor.ts`) — Playwright,
   local Chromium. Implements `FieldPresent`, `FieldAbsent`,
   `FieldRequiredEnforced`, and `FieldValueEquals` (live DOM check) against
   the running flow in a real, authenticated Salesforce session
   (frontdoor.jsp bootstrap). `RecordFieldEquals` can't be checked
   mid-browser-run (no Salesforce connection there) — it's stamped as
   pending and resolved afterward.
4. **Report** (`src/stages/report`) — DML/record capture runs **per test
   case** (not once for the whole run), since test cases already execute
   sequentially and each gets its own disjoint time window — this is what
   makes `recordAssertionReconciler.ts` able to actually disambiguate which
   captured record a `RecordFieldEquals` assertion should check: zero
   matching records fails the case (real signal the DML didn't fire),
   multiple matches skips it (harness can't tell them apart, not a
   confirmed defect). Results write back to the three custom objects in
   design doc Section 7.

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
   if targeting a sandbox). Optionally fill in `LLM_PROVIDER` + `LLM_API_KEY`
   for LLM-proposed scenarios — two providers implemented:
   - `LLM_PROVIDER=groq` — **free tier, no card required.** Get a key from
     [console.groq.com](https://console.groq.com) (API Keys section). Good
     for proving the mechanism out before paying for anything. Defaults to
     `openai/gpt-oss-120b`, a genuinely open-weight model.
   - `LLM_PROVIDER=anthropic` — paid, billed per token. Get a key from
     [console.anthropic.com](https://console.anthropic.com) (API Keys
     section). **A claude.ai Pro/Max subscription does not work here** — that's chat access, not
   programmatic API access. Leave both blank to run deterministic-only
   generation.
4. `npm install`
5. `npx playwright install chromium` — one-time download of the actual
   Chromium binary Playwright drives.
6. Retrieve the real flow you want to test, e.g.
   `sf project retrieve start -m "Flow:My_Flow_Name" -o <your-org-alias>`,
   which lands it at `force-app/main/default/flows/My_Flow_Name.flow-meta.xml`.
7. Try `npm run smoke-test` first — parses and generates test cases from
   `examples/Demo_Contact_Intake.flow-meta.xml` with no server, no
   Salesforce, no Playwright involved. Pass a path as an argument to point
   it at a different flow, e.g.
   `npm run smoke-test -- examples/Demo_Approval_Routing.flow-meta.xml`
   (the latter has a Decision and a Loop, so it's a good way to see branch
   coverage in the output before trying a real retrieved flow). Also try
   `npm run smoke-test:conditions` — standalone checks for the
   `conditionEvaluator.ts` logic parser/solver, no flow file needed.
8. `npm run dev`, then visit `http://localhost:3000/oauth/login` to
   authenticate, and `POST /api/test-runs` with
   `{ "flowFilePath": "/absolute/path/to/My_Flow_Name.flow-meta.xml" }`
   to run the full pipeline end to end.

## Known gaps (intentional)

- **Record-triggered flows are out of scope.** `recordTriggeredExecutor.ts`
  is a stub — this project only tests screen flows.
- **Loop iteration coverage is capped at 0 vs. 1 iteration.** Proving
  N-iteration behavior (N ≥ 2) would need a separate loop-body-membership
  analysis; deferred as real, deliberate scope, not an oversight.
- **Subflow internals aren't analyzed.** A Subflow element is parsed as an
  opaque pass-through node — its called flow's screens/DML/branching are
  invisible here. Flagged per-subflow in `testPlanMarkdown`; test the
  called flow separately.
- **RecordLookup output is inherently unprovable.** Any condition
  referencing a lookup's output variable evaluates to "unknown" and drops
  that branch from generation with a note — the org's actual data
  determines the outcome, which this tool can't predict ahead of a real
  run.
- **Unfilled screen fields' `<defaultValue>` isn't parsed** — a field
  without an explicit test value is treated as blank when evaluating
  conditions, even if the flow itself would default it to something else.
- Solving conditions with operators other than `EqualTo`/`NotEqualTo`/
  `IsBlank`/`IsNull` (e.g. `GreaterThan`, `Contains`) to drive a specific
  branch isn't attempted — forward *evaluation* supports these operators,
  but the inverse *solver* (working out what input causes them) doesn't
  guess a satisfying value, and drops the branch with a note instead.
- Custom LWC screen fields (`ComponentInstance`) are flagged in the test
  plan under "Needs manual attention" and excluded from auto-fill — by
  design, not a gap to close generically (see design doc discussion on why
  a generic fill strategy would be dishonest here).
- LLM-sourced `DataTypeBoundary` scenarios are exploratory — they fill a
  boundary value and capture screenshots, but don't assert pass/fail, since
  whether a value like an over-length string actually gets rejected depends
  on validation this tool can't see in the flow's metadata (e.g. a
  formula-based validation rule).
- No front-end yet — this is API-only.
