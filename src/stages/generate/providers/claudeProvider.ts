import Anthropic, { APIConnectionError, APIError, RateLimitError } from "@anthropic-ai/sdk";
import { LlmScenarioProvider, ScenarioCoverageSummary, ScenarioProposal } from "../llmProvider";
import { condenseFlowModel, SYSTEM_PROMPT, SCENARIO_RESPONSE_SCHEMA, MAX_CONDENSED_FIELDS } from "./promptShared";

/**
 * Anthropic Claude implementation of LlmScenarioProvider. Sends a
 * CONDENSED view of the flow (not the raw graph-wiring FlowModel, and
 * never the raw XML) so the model sees what a QA engineer would read —
 * screens/fields/visibility, decision outcomes, loop collections, DML — and
 * proposes additional scenarios on top of what deterministic generation
 * already covers.
 *
 * Uses Anthropic's structured-output json_schema format so the response
 * shape is enforced server-side; still defensively re-checked here (the SDK
 * only auto-parses via `messages.parse()` when the format carries a custom
 * `.parse()` method, e.g. from `zodOutputFormat()` — a plain json_schema
 * format does not, so this uses `messages.create()` and parses the text
 * block itself, same effective behavior without a zod dependency).
 *
 * Every failure mode here — unconfigured (checked by the caller), refusal,
 * malformed response, any SDK exception, timeout — resolves to a warning
 * and an empty array. This must never throw: deterministic coverage always
 * has to ship regardless of what the LLM does.
 */

const REQUEST_TIMEOUT_MS = 60_000;
const MAX_TOKENS = 4096;

export class ClaudeScenarioProvider implements LlmScenarioProvider {
  private client: Anthropic;

  constructor(apiKey: string, private model: string, private effort: "low" | "medium" | "high" | "xhigh" | "max") {
    this.client = new Anthropic({ apiKey });
  }

  async proposeScenarios(input: ScenarioCoverageSummary): Promise<ScenarioProposal[]> {
    const condensed = condenseFlowModel(input.flowModel);
    const fieldCount = condensed.screens.reduce((sum, s) => sum + s.fields.length, 0);
    if (fieldCount > MAX_CONDENSED_FIELDS) {
      console.warn(
        `ClaudeScenarioProvider: flow "${condensed.flowApiName}" has ${fieldCount} fields (over the ${MAX_CONDENSED_FIELDS} limit) — skipping LLM scenario proposal to avoid an unbounded-cost call. Deterministic coverage still applies.`
      );
      return [];
    }

    try {
      const message = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: MAX_TOKENS,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: JSON.stringify({ flowSummary: condensed, coveredTargets: input.coveredTargets }) }],
          output_config: { effort: this.effort, format: { type: "json_schema", schema: SCENARIO_RESPONSE_SCHEMA } },
        },
        { timeout: REQUEST_TIMEOUT_MS }
      );

      if (message.stop_reason === "refusal") {
        console.warn(
          `ClaudeScenarioProvider: model declined to propose scenarios for "${condensed.flowApiName}" (${message.stop_details?.type ?? "refusal"}) — continuing with deterministic coverage only.`
        );
        return [];
      }

      const textBlock = message.content.find((b): b is Anthropic.TextBlock => b.type === "text");
      if (!textBlock) {
        console.warn(`ClaudeScenarioProvider: no text content in the model's response for "${condensed.flowApiName}" — continuing with deterministic coverage only.`);
        return [];
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(textBlock.text);
      } catch (err) {
        console.warn(
          `ClaudeScenarioProvider: response for "${condensed.flowApiName}" failed JSON parsing (${err instanceof Error ? err.message : String(err)}) — continuing with deterministic coverage only.`
        );
        return [];
      }

      const scenarios = (parsed as { scenarios?: unknown })?.scenarios;
      if (!Array.isArray(scenarios)) {
        console.warn(
          `ClaudeScenarioProvider: response for "${condensed.flowApiName}" didn't match the expected {scenarios: [...]} shape — continuing with deterministic coverage only.`
        );
        return [];
      }

      return scenarios as ScenarioProposal[];
    } catch (err) {
      if (err instanceof RateLimitError) {
        console.warn(`ClaudeScenarioProvider: rate limited (${err.message}) — continuing with deterministic coverage only.`);
      } else if (err instanceof APIConnectionError) {
        console.warn(`ClaudeScenarioProvider: connection error (${err.message}) — continuing with deterministic coverage only.`);
      } else if (err instanceof APIError) {
        console.warn(`ClaudeScenarioProvider: API error (status ${err.status ?? "unknown"}: ${err.message}) — continuing with deterministic coverage only.`);
      } else {
        console.warn(`ClaudeScenarioProvider: unexpected error (${err instanceof Error ? err.message : String(err)}) — continuing with deterministic coverage only.`);
      }
      return [];
    }
  }
}
