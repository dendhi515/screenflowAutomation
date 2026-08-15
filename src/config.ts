import dotenv from "dotenv";
dotenv.config();

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(`Missing required env var: ${name} (see .env.example)`);
  }
  return value;
}

/** LLM_MODEL is optional — falls back to a sensible default per provider so
 *  "just set LLM_PROVIDER + LLM_API_KEY" works without also having to know
 *  a specific model id. */
function defaultModelFor(provider: string): string {
  if (provider === "groq") return "openai/gpt-oss-120b";
  return "claude-opus-5";
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  sessionSecret: process.env.SESSION_SECRET ?? "change-me-local-dev-only",
  // Debug aid: set PLAYWRIGHT_HEADLESS=false to watch the actual browser
  // live during a test run instead of only reviewing screenshots after the
  // fact — useful when a screenshot looks the same across every attempt and
  // it's unclear whether that's a real stuck state or just a static icon.
  playwrightHeadless: process.env.PLAYWRIGHT_HEADLESS !== "false",
  salesforce: {
    // Consumer Key only — this is a PKCE public client, no secret is stored
    // or required (design doc Section 8).
    clientId: process.env.SF_CLIENT_ID ?? "",
    loginUrl: process.env.SF_LOGIN_URL ?? "https://login.salesforce.com",
    callbackUrl: process.env.SF_CALLBACK_URL ?? "http://localhost:3000/oauth/callback",
  },
  llm: {
    // Empty provider/apiKey means the deterministic generator in
    // stages/generate/testCaseGenerator.ts runs alone — LLM-proposed
    // scenarios (stages/generate/providers/*.ts) are additive, never
    // required. Two providers implemented:
    //  - "anthropic": paid, requires a key from console.anthropic.com (NOT
    //    a claude.ai Pro/Max subscription — that's a separate product).
    //  - "groq": free tier, no card required, requires a key from
    //    console.groq.com. Good for a no-cost proof of concept before
    //    switching to "anthropic" (or a paid Groq tier) later.
    provider: process.env.LLM_PROVIDER ?? "",
    apiKey: process.env.LLM_API_KEY ?? "",
    model: process.env.LLM_MODEL ?? defaultModelFor(process.env.LLM_PROVIDER ?? ""),
    effort: (process.env.LLM_EFFORT as "low" | "medium" | "high" | "xhigh" | "max" | undefined) ?? "medium",
  },
};

export function assertSalesforceConfigured(): void {
  required("SF_CLIENT_ID", config.salesforce.clientId || undefined);
}
