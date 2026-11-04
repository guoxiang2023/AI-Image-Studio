const MODEL_RULES = [
  {
    test: /(gpt-image|dall-e-2|image-1|image-2)/i,
    family: 'openai-image',
    supportsEdits: true,
    supportsMultipleReferences: true,
    styleActivation: 'strong',
    referencePreferred: false,
  },
  {
    test: /dall-e-3/i,
    family: 'dall-e-3',
    supportsEdits: false,
    supportsMultipleReferences: false,
    styleActivation: 'strong',
    referencePreferred: false,
  },
  {
    test: /(flux|seedream|qwen-image|nano-banana|imagen|ideogram|recraft)/i,
    family: 'third-party-image',
    supportsEdits: null,
    supportsMultipleReferences: null,
    styleActivation: 'unknown',
    referencePreferred: true,
  },
];

const UNKNOWN = {
  family: 'unknown',
  supportsEdits: null,
  supportsMultipleReferences: null,
  styleActivation: 'unknown',
  referencePreferred: true,
};

/**
 * Resolve a small, deliberately conservative capability profile for an
 * arbitrary OpenAI-Images-compatible model name. `null` means "not known";
 * callers should try the endpoint and surface a useful error if it fails.
 */
export function imageCapabilities(model) {
  const id = String(model || '').trim();
  const rule = MODEL_RULES.find((item) => item.test.test(id));
  return {
    model: id,
    ...UNKNOWN,
    ...(rule || {}),
  };
}

export function canUseReferenceImages(model) {
  return imageCapabilities(model).supportsEdits !== false;
}
