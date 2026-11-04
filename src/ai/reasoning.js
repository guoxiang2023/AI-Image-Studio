import { REASONING_EFFORTS } from '../config.js';

export function normalizeReasoningEffort(value) {
  const effort = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return REASONING_EFFORTS.includes(effort) ? effort : '';
}

export function openAiReasoning(llm) {
  const effort = normalizeReasoningEffort(llm?.reasoningEffort);
  return effort ? { reasoning_effort: effort } : {};
}

export function anthropicReasoning(llm) {
  const effort = normalizeReasoningEffort(llm?.reasoningEffort);
  return effort ? { output_config: { effort } } : {};
}
