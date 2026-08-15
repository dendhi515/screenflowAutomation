import { LlmScenarioProvider, ScenarioCoverageSummary, ScenarioProposal } from "../llmProvider";
import { condenseFlowModel, SYSTEM_PROMPT, SCENARIO_RESPONSE_SCHEMA, MAX_CONDENSED_FIELDS } from "./promptShared";

/**
 * Groq implementation of LlmScenarioProvider — free-tier proof-of-concept
 * alternative to ClaudeScenarioProvider, same shared prompt/schema
 * (promptShared.ts), same graceful-degradation contract. Uses plain fetch
 * against Groq's OpenAI-compatible endpoint rather than an SDK dependency —
 * this is one JSON call, not worth adding a whole client library for.
 *
 * Deliberately requests response_format: {type: "json_object"} rather than
 * strict json_schema mode. Groq's own community has reported strict
 * json_schema structured outputs being silently ignored by
 * openai/gpt-oss-120b (returns free-form text instead of schema-compliant
 * JSON) — json_object mode (enforces valid JSON syntax, not the specific
 * shape) is the more reliably-supported option for this model. The response
 * is still fully re-validated below regardless — every proposal gets
 * checked again by scenarioValidator.ts before anything is trusted, same as
 * the Claude path.
 *
 * IMPORTANT: unlike Claude's json_schema mode (where the SDK/API enforces
 * SCENARIO_RESPONSE_SCHEMA structurally — the model literally cannot emit a
 * different shape), json_object mode only guarantees valid JSON syntax, NOT
 * any particular shape. Confirmed for real: with only the shared
 * SYSTEM_PROMPT (which never needed to spell out field names for Claude,
 * since the schema did that job), gpt-oss-120b returned syntactically valid
 * JSON that didn't match ScenarioProposal at all and got rejected by
 * scenarioValidator.ts. The schema is therefore serialized into the prompt
 * itself below (GROQ_SYSTEM_PROMPT) so the model has explicit field-name
 * guidance it wouldn't otherwise get — this is required for this provider,
 * not optional polish.
 */

const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_TOKENS = 4096;

const GROQ_SYSTEM_PROMPT = `${SYSTEM_PROMPT}

Each object in "scenarios" MUST match this exact JSON Schema — every property name below must be used verbatim, and "id"/"description"/"targetKind"/"expectedOutcome" are required on every scenario:

${JSON.stringify(SCENARIO_RESPONSE_SCHEMA, null, 2)}`;

interface GroqChatCompletion {
  choices?: { message?: { content?: string }; finish_reason?: string }[];
  error?: { message?: string; type?: string };
}

export class GroqScenarioProvider implements LlmScenarioProvider {
  constructor(private apiKey: string, private model: string) {}

  async proposeScenarios(input: ScenarioCoverageSummary): Promise<ScenarioProposal[]> {
    const condensed = condenseFlowModel(input.flowModel);
    const fieldCount = condensed.screens.reduce((sum, s) => sum + s.fields.length, 0);
    if (fieldCount > MAX_CONDENSED_FIELDS) {
      console.warn(
        `GroqScenarioProvider: flow "${condensed.flowApiName}" has ${fieldCount} fields (over the ${MAX_CONDENSED_FIELDS} limit) — skipping LLM scenario proposal to avoid an unbounded-cost call. Deterministic coverage still applies.`
      );
      return [];
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(GROQ_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          max_tokens: MAX_TOKENS,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: GROQ_SYSTEM_PROMPT },
            { role: "user", content: JSON.stringify({ flowSummary: condensed, coveredTargets: input.coveredTargets }) },
          ],
        }),
      });

      const body = (await response.json().catch(() => undefined)) as GroqChatCompletion | undefined;

      if (!response.ok) {
        const message = body?.error?.message ?? response.statusText;
        console.warn(
          `GroqScenarioProvider: API error for "${condensed.flowApiName}" (status ${response.status}: ${message}) — continuing with deterministic coverage only.`
        );
        return [];
      }

      const choice = body?.choices?.[0];
      const content = choice?.message?.content;
      if (!content) {
        console.warn(`GroqScenarioProvider: no content in the model's response for "${condensed.flowApiName}" — continuing with deterministic coverage only.`);
        return [];
      }

      if (choice?.finish_reason === "content_filter") {
        console.warn(`GroqScenarioProvider: response for "${condensed.flowApiName}" was filtered by the provider — continuing with deterministic coverage only.`);
        return [];
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch (err) {
        console.warn(
          `GroqScenarioProvider: response for "${condensed.flowApiName}" failed JSON parsing (${err instanceof Error ? err.message : String(err)}) — this model can occasionally ignore JSON-only instructions; continuing with deterministic coverage only.`
        );
        return [];
      }

      const scenarios = (parsed as { scenarios?: unknown })?.scenarios;
      if (!Array.isArray(scenarios)) {
        console.warn(
          `GroqScenarioProvider: response for "${condensed.flowApiName}" didn't match the expected {scenarios: [...]} shape — continuing with deterministic coverage only.`
        );
        return [];
      }

      return scenarios as ScenarioProposal[];
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        console.warn(`GroqScenarioProvider: request for "${condensed.flowApiName}" timed out after ${REQUEST_TIMEOUT_MS}ms — continuing with deterministic coverage only.`);
      } else {
        console.warn(
          `GroqScenarioProvider: unexpected error (${err instanceof Error ? err.message : String(err)}) — continuing with deterministic coverage only.`
        );
      }
      return [];
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}
