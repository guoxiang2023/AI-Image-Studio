import { REASONING_EFFORTS } from '../config.js';

export function normalizeReasoningEffort(value) {
  const effort = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return REASONING_EFFORTS.includes(effort) ? effort : '';
}

export function openAiReasoning(llm) {
  if (llm?.thinkingDisabled) return {};
  const effort = normalizeReasoningEffort(llm?.reasoningEffort);
  return effort ? { reasoning_effort: effort } : {};
}

export function anthropicReasoning(llm) {
  // Anthropic-compatible gateways may enable hidden thinking by default. A
  // document call only needs the visible JSON/Markdown, so opt out explicitly
  // instead of letting reasoning consume the whole completion budget.
  if (llm?.thinkingDisabled) return { thinking: { type: 'disabled' } };
  const effort = normalizeReasoningEffort(llm?.reasoningEffort);
  return effort ? { output_config: { effort } } : {};
}
