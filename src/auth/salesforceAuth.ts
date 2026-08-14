import crypto from "crypto";
import jsforce, { Connection } from "jsforce";
import { config } from "../config";

/**
 * Per-visit OAuth (Authorization Code + PKCE), no client secret, nothing
 * persisted between visits — design doc Section 4.1 / Section 5 decisions log.
 *
 * The resulting access token doubles as the session ID for the Playwright
 * frontdoor.jsp bootstrap in Stage 3 (design doc Section 4.5).
 */

export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
}

export interface SalesforceSession {
  accessToken: string;
  instanceUrl: string;
  username?: string;
}

function base64url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generatePkcePair(): PkcePair {
  const codeVerifier = base64url(crypto.randomBytes(32));
  const codeChallenge = base64url(crypto.createHash("sha256").update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

export function buildAuthorizeUrl(codeChallenge: string, state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.salesforce.clientId,
    redirect_uri: config.salesforce.callbackUrl,
    // "web" is required alongside "api" — frontdoor.jsp only accepts an
    // access token to bootstrap a real browser session if the token was
    // issued with "web" scope ("Manage user data via Web browsers"). An
    // "api"-only token works fine for REST calls (describe/query/create)
    // but Salesforce silently falls through to an actual login page for
    // frontdoor.jsp, which is exactly what happened against the real org —
    // Playwright landed on a login/Access-Denied page instead of the flow.
    scope: "api web",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
  });
  return `${config.salesforce.loginUrl}/services/oauth2/authorize?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  instance_url: string;
  id: string;
  token_type: string;
  issued_at: string;
}

export async function exchangeCodeForToken(code: string, codeVerifier: string): Promise<SalesforceSession> {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: config.salesforce.clientId,
    redirect_uri: config.salesforce.callbackUrl,
    code_verifier: codeVerifier,
  });

  const response = await fetch(`${config.salesforce.loginUrl}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Salesforce token exchange failed (${response.status}): ${body}`);
  }

  const token = (await response.json()) as TokenResponse;
  return { accessToken: token.access_token, instanceUrl: token.instance_url };
}

/** A fresh jsforce Connection bound to this session's token — never persisted to disk. */
export function connectionFor(session: SalesforceSession): Connection {
  return new Connection({
    accessToken: session.accessToken,
    instanceUrl: session.instanceUrl,
    version: "60.0",
  });
}

/**
 * The OAuth token's instance_url is the "classic"/API host
 * (<mydomain>.my.salesforce.com). Landing a standalone /flow/<name> URL on
 * that host renders the flow inside Salesforce's legacy Classic wrapper,
 * which doesn't support Lightning-only screen components — confirmed for
 * real against the actual org: flowruntime:lookup and flowruntime:email
 * both refused to render with "isn't supported in Classic runtime. Ask
 * your Salesforce admin to distribute this flow in Lightning runtime
 * instead." The Lightning Experience UI host for the same org is
 * <mydomain>.lightning.force.com — that's where the flow needs to open.
 */
function lightningInstanceUrl(instanceUrl: string): string {
  return instanceUrl.replace(/\.my\.salesforce\.com$/i, ".lightning.force.com");
}

/**
 * Builds the frontdoor.jsp URL used to bootstrap an already-authenticated
 * browser session for Playwright (design doc Section 4.1 / 4.5) — avoids
 * scripting the login form or dealing with MFA. frontdoor.jsp itself is
 * still hit on the instance (my.salesforce.com) host, since that's the host
 * the OAuth token was issued for, but retURL is rewritten to the Lightning
 * host so the post-login redirect lands the flow in Lightning runtime
 * rather than Classic.
 */
export function buildFrontdoorUrl(session: SalesforceSession, retUrl = "/"): string {
  const lightningRetUrl = `${lightningInstanceUrl(session.instanceUrl)}${retUrl}`;
  const params = new URLSearchParams({ sid: session.accessToken, retURL: lightningRetUrl });
  return `${session.instanceUrl}/secur/frontdoor.jsp?${params.toString()}`;
}
