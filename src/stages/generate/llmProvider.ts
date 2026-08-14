import { FlowModel } from "../../types/flowModel";
import { TestSpec } from "../../types/testSpec";

/**
 * Pluggable LLM interface (design doc Section 6 / 9 open items — provider
 * is deferred). Test-case generation and Anonymous Apex generation sit
 * behind this interface so a provider can be wired in later without
 * touching pipeline logic elsewhere.
 *
 * To add a provider: implement this interface (e.g. ClaudeTestCaseProvider
 * calling the Anthropic API) and select it in testCaseGenerator.ts based on
 * config.llm.provider.
 */
export interface LlmTestCaseProvider {
  generateTestSpec(flowModel: FlowModel): Promise<TestSpec>;
}

export function isLlmConfigured(providerName: string, apiKey: string): boolean {
  return Boolean(providerName && apiKey);
}
