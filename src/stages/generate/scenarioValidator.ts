import { FlowModel, FlowScreen, FlowDecision, FlowField } from "../../types/flowModel";
import { ScenarioProposal } from "./llmProvider";

/**
 * Checks every apiName/choice/outcome an LLM-proposed scenario references
 * against the real, parsed FlowModel before anything is trusted —
 * scenarioCompiler.ts only ever sees validated proposals. This is what
 * makes it safe to let the model "propose freely": a hallucinated field
 * name or choice value gets rejected here, logged, and dropped rather than
 * ever reaching Playwright.
 */

export interface ValidationResult {
  valid: ScenarioProposal[];
  rejected: { proposal: ScenarioProposal; reason: string }[];
}

function allFields(flowModel: FlowModel): Map<string, FlowField> {
  const map = new Map<string, FlowField>();
  for (const node of Object.values(flowModel.nodes)) {
    if (node.kind !== "Screen") continue;
    for (const field of (node as FlowScreen).fields) map.set(field.apiName, field);
  }
  return map;
}

function validateOne(flowModel: FlowModel, fields: Map<string, FlowField>, proposal: ScenarioProposal): string | undefined {
  if (!proposal.id || !proposal.description || !proposal.targetKind || !proposal.expectedOutcome) {
    return "missing a required field (id, description, targetKind, or expectedOutcome)";
  }

  if (proposal.targetApiName) {
    const isField = fields.has(proposal.targetApiName);
    const isNode = Boolean(flowModel.nodes[proposal.targetApiName]);
    if (!isField && !isNode) {
      return `targetApiName "${proposal.targetApiName}" doesn't match any field or element in the flow`;
    }
  }

  if (proposal.targetOutcomeApiName) {
    if (!proposal.targetApiName) return "targetOutcomeApiName was set without a targetApiName naming the decision it belongs to";
    const decisionNode = flowModel.nodes[proposal.targetApiName];
    if (!decisionNode || decisionNode.kind !== "Decision") {
      return `targetApiName "${proposal.targetApiName}" isn't a Decision element, but targetOutcomeApiName was set`;
    }
    const outcomeExists = (decisionNode as FlowDecision).outcomes.some((o) => o.apiName === proposal.targetOutcomeApiName);
    if (!outcomeExists) {
      return `targetOutcomeApiName "${proposal.targetOutcomeApiName}" doesn't match any outcome on Decision "${proposal.targetApiName}"`;
    }
  }

  if (proposal.suggestedInputs) {
    for (const [apiName, value] of Object.entries(proposal.suggestedInputs)) {
      const field = fields.get(apiName);
      if (!field) return `suggestedInputs references field "${apiName}", which doesn't exist on any screen in this flow`;
      if (field.choices && field.choices.length > 0) {
        const matches = field.choices.some((c) => String(c.value) === String(value));
        if (!matches) {
          return `suggestedInputs value "${value}" for field "${apiName}" doesn't match any of its real choice values (${field.choices.map((c) => c.value).join(", ")})`;
        }
      }
    }
  }

  return undefined;
}

export function validateScenarioProposals(flowModel: FlowModel, proposals: ScenarioProposal[]): ValidationResult {
  const fields = allFields(flowModel);
  const valid: ScenarioProposal[] = [];
  const rejected: { proposal: ScenarioProposal; reason: string }[] = [];

  for (const proposal of proposals) {
    const reason = validateOne(flowModel, fields, proposal);
    if (reason) {
      rejected.push({ proposal, reason });
      console.warn(`Rejected LLM-proposed scenario "${proposal.id ?? "(no id)"}": ${reason}.`);
    } else {
      valid.push(proposal);
    }
  }

  return { valid, rejected };
}
