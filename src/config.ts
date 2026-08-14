import dotenv from "dotenv";
dotenv.config();

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(`Missing required env var: ${name} (see .env.example)`);
  }
  return value;
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
    // Deferred per design doc Section 6 — empty means the deterministic
    // fallback generator in stages/generate/testCaseGenerator.ts is used.
    provider: process.env.LLM_PROVIDER ?? "",
    apiKey: process.env.LLM_API_KEY ?? "",
  },
};

export function assertSalesforceConfigured(): void {
  required("SF_CLIENT_ID", config.salesforce.clientId || undefined);
}
