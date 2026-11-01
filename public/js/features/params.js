import { els, state } from '../core/index.js';

export function renderParams() {
  const { aspectRatio, count, quality } = state.options;
  for (const chip of els.aspectChips.querySelectorAll('[data-aspect]')) {
    chip.classList.toggle('active', (chip.dataset.aspect || '') === (aspectRatio || ''));
  }
  for (const chip of els.countChips.querySelectorAll('[data-count]')) {
    chip.classList.toggle('active', Number(chip.dataset.count) === (count || 1));
  }
  for (const chip of els.qualityChips.querySelectorAll('[data-quality]')) {
    chip.classList.toggle('active', (chip.dataset.quality || '') === (quality || ''));
  }
  const active = Boolean(aspectRatio || quality || (count && count !== 1));
  els.paramDot.hidden = !active;
  els.paramsBtn.classList.toggle('active', active);
}

export function toggleParams() {
  els.paramPanel.hidden = !els.paramPanel.hidden;
}

export function closeParams() {
  els.paramPanel.hidden = true;
}

export function resetParams() {
  state.options = { aspectRatio: null, count: null, quality: null };
  renderParams();
}
