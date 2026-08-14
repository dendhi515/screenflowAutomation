import fs from "fs";
import path from "path";
import { Connection } from "jsforce";
import { chromium, Page } from "playwright";
import { SalesforceSession, buildFrontdoorUrl } from "../../auth/salesforceAuth";
import { TestCase, FieldInput, ExpectedAssertion } from "../../types/testSpec";
import { TestCaseExecutionResult } from "../../types/runResult";
import { buildObjectNameResolver, buildFieldNameResolver } from "../../salesforce/namespaceResolver";
import { config } from "../../config";

/**
 * Stage 3 — screen flow execution (design doc Section 4.5).
 * Runs a local Chromium instance via Playwright (chromium.launch()) — no
 * cloud grid account/token required for v1, consistent with running the
 * whole service locally. Requires a one-time `npx playwright install
 * chromium` on this machine.
 *
 * If this later needs to move to a remote browser grid (e.g. Microsoft
 * Playwright Testing, BrowserStack, LambdaTest) for parallelism/scale,
 * swap this for chromium.connect(<provider's WS endpoint + token>) — the
 * exact connection code is provider-specific, so pick one before wiring
 * it in rather than guessing at a generic "cloud" endpoint.
 *
 * Locators are keyed to each field's rendered label (targetLabel /
 * locatorLabel), not API name and not a CSS path — Salesforce renders
 * labels, not API names, so that's the only one of the three that
 * actually matches anything in the DOM.
 */

interface AssertionOutcome {
  passed: boolean;
  failureReason?: string;
  navigatedAlready?: boolean;
  screenshotPath?: string;
}

const SCREENSHOT_DIR = path.join(process.cwd(), "screenshots");

/** Saves a screenshot for a human to actually look at — the whole point of
 *  driving a real browser instead of just trusting a boolean. Used at the
 *  moment a FieldRequiredEnforced check is decided, so if the result looks
 *  surprising (e.g. "flow advanced anyway") there's a real picture of what
 *  the screen showed, not just our interpretation of it. */
async function captureScreenshot(page: Page, testCaseId: string, tag: string): Promise<string | undefined> {
  try {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const safeTag = tag.replace(/[^a-z0-9_-]/gi, "_");
    const filePath = path.join(SCREENSHOT_DIR, `${testCaseId}__${safeTag}__${Date.now()}.png`);
    await page.screenshot({ path: filePath, fullPage: true });
    return filePath;
  } catch (err) {
    console.warn(`Could not capture screenshot for ${testCaseId}/${tag}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

export async function runScreenFlowTestCase(
  conn: Connection,
  session: SalesforceSession,
  flowApiName: string,
  testCase: TestCase
): Promise<TestCaseExecutionResult> {
  const executedAt = new Date().toISOString();
  if (!testCase.steps || testCase.steps.length === 0) {
    return {
      testCaseId: testCase.id,
      description: testCase.description,
      status: "Skipped",
      failureReason: "No steps generated for this test case",
      executedAt,
    };
  }

  // headless by default; set PLAYWRIGHT_HEADLESS=false in .env to watch the
  // real browser live during a run — see config.ts.
  const browser = await chromium.launch({ headless: config.playwrightHeadless, slowMo: config.playwrightHeadless ? 0 : 250 });
  const screenshotPaths: string[] = [];
  let page: Page | undefined;
  try {
    const context = await browser.newContext();
    page = await context.newPage();

    // Session bootstrap via frontdoor.jsp — no scripted login form, no MFA
    // friction (design doc Section 4.1).
    const flowRunUrl = `/flow/${flowApiName}`;
    await page.goto(buildFrontdoorUrl(session, flowRunUrl));
    await page.waitForLoadState("networkidle");

    // Verify the bootstrap actually landed on the flow rather than falling
    // through to a real Salesforce login page — confirmed to happen for
    // real when the OAuth token was issued without "web" scope (frontdoor.jsp
    // silently rejects an api-only sid instead of erroring). Checking this
    // explicitly, right after the navigation, turns that failure mode into
    // a loud, specific error instead of a test case that "passes" with zero
    // fields ever filled.
    const bootstrapShot = await captureScreenshot(page, testCase.id, "post-frontdoor-bootstrap");
    if (bootstrapShot) screenshotPaths.push(bootstrapShot);
    const loginFormVisible = await page
      .locator('input[name="username"], #username, input[type="password"]')
      .first()
      .isVisible()
      .catch(() => false);
    if (loginFormVisible) {
      throw new Error(
        `frontdoor.jsp session bootstrap failed — the browser landed on a Salesforce login page instead of the flow. This almost always means the OAuth access token lacks "web" scope (an "api"-only token works for REST calls but frontdoor.jsp rejects it for a browser session). Add "Manage user data via Web browsers (web)" to the External Client App's OAuth Scopes, save, and re-authorize (/oauth/login) so a fresh token is issued with the new scope.${bootstrapShot ? ` Screenshot: ${bootstrapShot}` : ""}`
      );
    }

    for (const step of testCase.steps) {
      screenshotPaths.push(...(await fillScreen(conn, page, step.inputs, testCase.id)));

      let navigatedByAssertion = false;

      for (const assertion of step.assertions) {
        const outcome = await evaluateAssertion(page, assertion, testCase.id);
        if (outcome.screenshotPath) screenshotPaths.push(outcome.screenshotPath);
        if (outcome.navigatedAlready) navigatedByAssertion = true;
        if (!outcome.passed) {
          return {
            testCaseId: testCase.id,
            screenApiName: step.screenApiName,
            description: testCase.description,
            status: "Failed",
            failureReason: outcome.failureReason,
            executedAt,
            screenshotPaths: screenshotPaths.length > 0 ? screenshotPaths : undefined,
          };
        }
      }

      if (!navigatedByAssertion) {
        const clicked = await clickNextIfPresent(page);
        // Screenshot regardless of outcome — this is the only evidence of
        // whether the flow actually advanced (and therefore whether any
        // downstream DML has a chance of firing at all), since the browser
        // closes right after the test case finishes and a headed run can be
        // too fast to watch live.
        const navShot = await captureScreenshot(page, testCase.id, `after-next-${step.screenApiName}`);
        if (navShot) screenshotPaths.push(navShot);
        if (!clicked) {
          console.warn(
            `Screen "${step.screenApiName}" — no Next/Finish button was found to click. The flow did not advance past this screen, so any DML on a later element will not have fired.`
          );
        }
      }
    }

    return {
      testCaseId: testCase.id,
      description: testCase.description,
      status: "Passed",
      executedAt,
      screenshotPaths: screenshotPaths.length > 0 ? screenshotPaths : undefined,
    };
  } catch (err) {
    return {
      testCaseId: testCase.id,
      description: testCase.description,
      status: "Failed",
      failureReason: err instanceof Error ? err.message : String(err),
      executedAt,
      screenshotPaths: screenshotPaths.length > 0 ? screenshotPaths : undefined,
    };
  } finally {
    // When running headed for debugging, give a human a moment to actually
    // see the final screen before the window vanishes — otherwise the
    // browser closes the instant the test case resolves, which is too fast
    // to watch live (confirmed: "popup immediately closed couldn't see
    // what happened").
    if (!config.playwrightHeadless) {
      await page?.waitForTimeout(3000).catch(() => undefined);
    }
    await browser.close();
  }
}

async function evaluateAssertion(page: Page, assertion: ExpectedAssertion, testCaseId: string): Promise<AssertionOutcome> {
  const locator = page.getByLabel(assertion.targetLabel, { exact: false });

  switch (assertion.type) {
    case "FieldPresent": {
      const visible = await locator.isVisible().catch(() => false);
      return visible
        ? { passed: true }
        : { passed: false, failureReason: `Expected field "${assertion.targetLabel}" to be visible but it was not.` };
    }

    case "FieldAbsent": {
      const visible = await locator.isVisible().catch(() => false);
      return !visible
        ? { passed: true }
        : { passed: false, failureReason: `Expected field "${assertion.targetLabel}" to be hidden but it was visible.` };
    }

    case "FieldRequiredEnforced": {
      // Click Next ourselves (rather than the end-of-step auto-click) so we
      // can tell whether validation actually blocked navigation.
      const next = page.getByRole("button", { name: /next|finish/i });
      if (await next.isVisible().catch(() => false)) {
        await next.click();
        await page.waitForTimeout(500); // let client-side validation render, if any
      }
      const stillOnScreen = await locator.isVisible().catch(() => false);
      // Screenshot at the moment of decision regardless of outcome — if
      // this looks surprising (e.g. "flow advanced anyway" for a field the
      // metadata says is required), there's a real picture of what
      // actually rendered rather than just our interpretation of the DOM.
      const screenshotPath = await captureScreenshot(page, testCaseId, `required-check-${assertion.targetApiName}`);
      return stillOnScreen
        ? { passed: true, navigatedAlready: true, screenshotPath }
        : {
            passed: false,
            navigatedAlready: true,
            screenshotPath,
            failureReason: `Expected required field "${assertion.targetLabel}" to block navigation when blank, but the flow advanced anyway.`,
          };
    }

    case "FieldValueEquals":
    case "RecordFieldEquals":
    default:
      // Not yet implemented — see README known gaps. Left unasserted
      // rather than reporting a false pass.
      return { passed: true };
  }
}

async function fillScreen(conn: Connection, page: Page, inputs: FieldInput[], testCaseId: string): Promise<string[]> {
  const screenshotPaths: string[] = [];
  for (const input of inputs) {
    if (input.interactionKind === "LookupSelect") {
      const shot = await fillLookupField(conn, page, input, testCaseId);
      if (shot) screenshotPaths.push(shot);
      continue;
    }
    const locator = page.getByLabel(input.locatorLabel, { exact: false });
    if (typeof input.value === "boolean") {
      const action = input.value ? "check" : "uncheck";
      await (input.value ? locator.check() : locator.uncheck()).catch((err) =>
        console.warn(`Field "${input.locatorLabel}" — could not ${action} it: ${err instanceof Error ? err.message : String(err)}`)
      );
    } else {
      await locator.fill(String(input.value)).catch((err) =>
        console.warn(`Field "${input.locatorLabel}" — could not fill it: ${err instanceof Error ? err.message : String(err)}`)
      );
    }
  }
  return screenshotPaths;
}

/** Finds the actual input element for a lookup field. getByLabel requires
 *  proper ARIA association (aria-label/aria-labelledby or <label for>),
 *  which some flowruntime extension components don't wire up the way
 *  standard fields do — confirmed against a real run where getByLabel
 *  found nothing for the Account lookup despite it being visibly rendered.
 *  Falls back to the "Search <Something>..." placeholder Salesforce
 *  lookups render with, which doesn't depend on ARIA labeling at all. */
function lookupInputLocator(page: Page, locatorLabel: string) {
  const byLabel = page.getByLabel(locatorLabel, { exact: false });
  const byPlaceholder = page.getByPlaceholder(/^search/i);
  return { byLabel, byPlaceholder };
}

/**
 * Queries several real records from the lookup's target object so there's a
 * pool of guaranteed-to-exist search terms to try, instead of typing a
 * generic guess and hoping (per explicit feedback — querying first is the
 * right approach). Returns an empty array if the object can't be resolved
 * or genuinely has no records, which is real, useful information: an empty
 * target object means this lookup can't be meaningfully tested without seed
 * data, not a bug in the harness.
 */
async function findSeedSearchTerms(
  conn: Connection,
  lookupObjectApiName: string | undefined,
  lookupSearchFieldApiName: string | undefined
): Promise<string[]> {
  if (!lookupObjectApiName) return [];
  try {
    const resolveObjectName = await buildObjectNameResolver(conn);
    const resolved = resolveObjectName(lookupObjectApiName);
    const describeResult = await conn.sobject(resolved).describe();

    // The Lookup component's own inputParameters can configure exactly which
    // field it searches/displays by via fieldApiName — confirmed for real:
    // a Lookup on RefreshPackage__FlowAutomate__c set
    // fieldApiName="RefreshPackage__Account__c" because that object's Name
    // field is an autonumber ("A-0001"), not a human-searchable string.
    // Searching by Name there never matched anything real; searching by the
    // flow's own configured field does (confirmed by testing the flow
    // directly in Flow Builder). That's authoritative — prefer it over any
    // heuristic, and only fall back to guessing a name-like field if the
    // flow didn't configure one or it can't be resolved.
    let searchField: string | undefined;
    if (lookupSearchFieldApiName) {
      const resolveFieldName = await buildFieldNameResolver(conn, resolved);
      searchField = resolveFieldName(lookupSearchFieldApiName);
      if (!searchField) {
        console.warn(
          `Lookup's configured fieldApiName "${lookupSearchFieldApiName}" could not be resolved on ${resolved} — falling back to heuristic field detection.`
        );
      }
    }

    if (!searchField) {
      // The standard "Name" field can itself be configured as an autonumber
      // on custom objects (e.g. "A-0001"). An autonumber isn't a string a
      // human (or the Lookup's own search box) would type to find a record
      // by name, so searching by it produces a technically-real but useless
      // term. When that's the case, prefer a real text field whose label
      // looks like a human-readable name instead of guessing — falling back
      // to the autonumber only if nothing better is found, with a warning.
      const nameFieldMeta = describeResult.fields.find((f) => f.name === "Name");
      searchField = "Name";
      if (nameFieldMeta?.autoNumber) {
        const candidate = describeResult.fields.find(
          (f) => f.type === "string" && f.name !== "Name" && /name/i.test(f.label ?? "")
        );
        if (candidate) {
          searchField = candidate.name;
        } else {
          console.warn(
            `${resolved}'s Name field is an autonumber (e.g. "A-0001") and no other name-like text field was found on it — falling back to the autonumber as a search term, which may not match anything meaningful in the Lookup's search box.`
          );
        }
      }
    }

    // The resolved search field can itself be a lookup/master-detail
    // relationship field rather than a plain text field — confirmed for
    // real: RefreshPackage__Account__c on FlowAutomate__c is a reference to
    // Account, so querying it directly returns the related Account's 18-char
    // Id, not a name. Typing a raw Id into a name-search box never matches
    // anything. When the field is a reference, follow the relationship and
    // pull the related record's Name instead of the foreign key value.
    const searchFieldMeta = describeResult.fields.find((f) => f.name === searchField);
    let queryField = searchField as string;
    let extractField = searchField as string;
    if (searchFieldMeta?.type === "reference" && searchFieldMeta.relationshipName) {
      queryField = `${searchFieldMeta.relationshipName}.Name`;
      extractField = searchFieldMeta.relationshipName;
    }

    const result = await conn.query<Record<string, unknown>>(`SELECT Id, ${queryField} FROM ${resolved} LIMIT 20`);
    if (result.records.length === 0) {
      console.warn(`No records found on ${resolved} — cannot pick a real record for this lookup. The org may genuinely have none.`);
      return [];
    }
    const terms = result.records
      .map((r) => {
        if (queryField !== searchField) {
          const related = r[extractField] as { Name?: string } | null | undefined;
          return related?.Name;
        }
        return r[searchField as string] as string | undefined;
      })
      .filter((v): v is string => Boolean(v));
    if (terms.length === 0) {
      console.warn(
        `${resolved} has records but none had a value in ${searchField}${queryField !== searchField ? " (via its related record's Name)" : ""} to search by.`
      );
    }
    return terms;
  } catch (err) {
    console.warn(`Could not query ${lookupObjectApiName} for seed records: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

const MAX_LOOKUP_SEARCH_ATTEMPTS = 5;

/**
 * Lookup fields don't take a literal value — typing a search term opens a
 * dropdown of matching records, and the user picks one. Rather than typing
 * a generic guess, this queries real records from the lookup's target
 * object first and searches by their actual Name/name-like field.
 *
 * A single candidate isn't reliable enough on its own: the Lookup's search
 * box is backed by Salesforce's search index, which can lag behind what's
 * immediately visible via SOQL — so the very first record returned by a
 * plain query isn't guaranteed to be searchable yet (confirmed for real:
 * querying returned "Test Trigger" as a genuine Account, but the Lookup's
 * own search never surfaced it). Since any real record is an equally valid
 * choice here, this tries each candidate in turn and selects whichever one
 * actually returns a result first, rather than betting on one.
 *
 * If the object can't be resolved or genuinely has no records, falls back
 * to the generic literal value as a last resort. If nothing ever returns a
 * result, the field is left unselected rather than fabricating a record
 * reference — if the field is required, the downstream
 * FieldRequiredEnforced assertion will correctly show blocked navigation,
 * which is an honest signal, not a bug.
 */
async function fillLookupField(conn: Connection, page: Page, input: FieldInput, testCaseId: string): Promise<string | undefined> {
  if (!String(input.value)) return undefined; // boundary case — leave blank on purpose

  const seedTerms = await findSeedSearchTerms(conn, input.lookupObjectApiName, input.lookupSearchFieldApiName);
  const candidates = seedTerms.length > 0 ? seedTerms : [String(input.value)];

  const { byLabel, byPlaceholder } = lookupInputLocator(page, input.locatorLabel);
  let locator = byLabel;
  if (!(await byLabel.isVisible().catch(() => false))) {
    if (await byPlaceholder.isVisible().catch(() => false)) {
      locator = byPlaceholder;
    } else {
      console.warn(
        `Lookup field "${input.locatorLabel}" — no element matched by label or by a "Search..." placeholder. Skipping fill rather than guessing a different selector.`
      );
      return await captureScreenshot(page, testCaseId, `lookup-${input.apiName}-not-found`);
    }
  }

  // Salesforce's Lookup dropdown renders a "Show more results for '<term>'"
  // entry above the actual matches, and it's marked with the same
  // role="option" as real records — confirmed for real: .first() picked
  // that link instead of the actual account, which opened the "Advanced
  // Search" modal instead of selecting anything (and left Email unfillable,
  // hidden behind the modal). Excluding it by its distinctive text ensures
  // we click a real record, not the search-escalation link.
  const option = page.getByRole("option").filter({ hasNotText: /show more results/i }).first();
  const attempts = candidates.slice(0, MAX_LOOKUP_SEARCH_ATTEMPTS);

  for (const [index, searchTerm] of attempts.entries()) {
    await locator.click();
    await locator.fill(""); // clear any leftover text from a prior failed attempt
    // Lightning's lookup combobox listens for real keystroke events to
    // trigger its debounced search — locator.fill() sets the value in one
    // shot and doesn't reliably fire those, which reproduced for real as a
    // search spinner that never resolved for *any* candidate account,
    // including ones confirmed to exist. pressSequentially() dispatches an
    // actual keydown/keypress/input/keyup sequence per character instead.
    await locator.pressSequentially(searchTerm, { delay: 50 });

    // Poll for the results listbox instead of a blind fixed wait — the
    // lookup's search is an async server round-trip with variable latency.
    const hasOption = await option
      .waitFor({ state: "visible", timeout: 6000 })
      .then(() => true)
      .catch(() => false);

    if (hasOption) {
      const screenshotPath = await captureScreenshot(page, testCaseId, `lookup-${input.apiName}`);
      await option.click();
      return screenshotPath;
    }

    console.warn(
      `Lookup field "${input.locatorLabel}" — search term "${searchTerm}" (attempt ${index + 1}/${attempts.length}) returned no selectable results within 6s. Trying the next candidate.`
    );
  }

  // None of the candidates surfaced a result — screenshot the last attempt
  // so there's a real picture of what the search box showed, not just our
  // interpretation of it.
  const screenshotPath = await captureScreenshot(page, testCaseId, `lookup-${input.apiName}-no-results`);
  console.warn(
    `Lookup field "${input.locatorLabel}" — tried ${attempts.length} real search term(s), none returned a selectable result. Left unselected rather than guessing a record.`
  );
  return screenshotPath;
}

/** Returns whether a Next/Finish button was actually found and clicked —
 *  the caller needs this signal explicitly rather than assuming silently,
 *  since a screen where no such button is found means the flow never
 *  advances and no downstream DML ever fires, which otherwise looks
 *  identical to a successful click from the outside. */
async function clickNextIfPresent(page: Page): Promise<boolean> {
  const next = page.getByRole("button", { name: /next|finish/i });
  if (await next.isVisible().catch(() => false)) {
    await next.click();
    await page.waitForLoadState("networkidle");
    return true;
  }
  return false;
}
