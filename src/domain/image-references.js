const STYLE_ISOLATION = [
  'Use the attached style reference only for its visual language: linework, brushwork, medium, material texture, color tendencies, and overall art direction.',
  'Do not use, copy, or carry over any subject, person, animal, clothing, prop, action, pose, setting, background, composition, layout, text, or story from the reference image.',
  "The user's written theme is the sole source for the image content.",
].join(' ');

const REDRAW_INSTRUCTION = [
  "Extract only the subject/person's facial features and pose, plus the scene's outer contours.",
  'Redraw the image from scratch in the selected style; do not add texture, filters, or a painterly overlay to the original photo.',
].join(' ');

const ROLE_INSTRUCTIONS = {
  风格: 'style reference only; extract visual language, never subject matter or composition.',
  角色: 'identity and appearance reference; preserve the character while following the requested scene.',
  构图: 'composition and framing reference; use its spatial layout only.',
  版式: 'layout and art-direction reference; preserve only its spatial composition, typography hierarchy, palette, lighting, material texture, and overall visual language. Replace its exact text and content with the new copy and theme; also replace its subject, products, props, people, logos, and decorative product motifs with subjects that fit the new theme. Never relabel or reuse the reference product as the new subject.',
  产品: 'product appearance reference; preserve the product design while following the requested scene.',
  参考: 'supporting reference; use only the aspect the user explicitly asks for.',
};

function referenceRole(ref) {
  return ROLE_INSTRUCTIONS[ref?.role] ? ref.role : '参考';
}

export function hasStyleReference(references) {
  return Array.isArray(references) && references.some((ref) => ref?.id && ref.role === '风格');
}

/**
 * Build a fixed prompt suffix for uploaded references. Style references are
 * deliberately isolated from content: a reference can drive the look without
 * leaking its subject, composition, or text into the new image.
 */
export function referencePromptBlock(references, { mode = 'generate' } = {}) {
  const refs = (Array.isArray(references) ? references : []).filter((ref) => ref?.id);
  if (!refs.length) return '';

  const lines = ['Reference image rules:'];
  refs.forEach((ref, index) => {
    lines.push(`- Image ${index + 1}: ${ROLE_INSTRUCTIONS[referenceRole(ref)]}`);
  });

  if (refs.some((ref) => ref.role === '风格')) {
    lines.push(STYLE_ISOLATION);
    if (mode === 'edit') lines.push(REDRAW_INSTRUCTION);
  }
  return `\n\n${lines.join('\n')}`;
}

export function referencePromptForMode(references, mode) {
  return referencePromptBlock(references, { mode });
}

export { STYLE_ISOLATION, REDRAW_INSTRUCTION };
