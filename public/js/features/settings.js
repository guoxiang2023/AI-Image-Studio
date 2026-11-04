import { api, els, renderModels, state, toast } from '../core/index.js';

function modelField(target) {
  return target === 'llm'
    ? { select: els.llmModelSelect, input: els.llmModel }
    : { select: els.imageModelSelect, input: els.imageModel };
}

function keyField(target) {
  return target === 'llm'
    ? { input: els.llmKey, toggle: els.llmKeyToggle }
    : { input: els.imageKey, toggle: els.imageKeyToggle };
}

function setKeyVisibility(target, visible) {
  const { input, toggle } = keyField(target);
  input.type = visible ? 'text' : 'password';
  toggle.setAttribute('aria-pressed', String(visible));
  toggle.setAttribute('aria-label', visible ? '隐藏 API Key' : '显示 API Key');
  toggle.title = visible ? '隐藏 API Key' : '显示 API Key';
  toggle.querySelector('use').setAttribute('href', visible ? '#i-eye' : '#i-eye-off');
}

function hasSavedKey(target) {
  return Boolean(state.config?.[target]?.apiKeySet);
}

export async function toggleKeyVisibility(target) {
  const { input, toggle } = keyField(target);
  const show = input.type === 'password';
  setKeyVisibility(target, show);
  if (!show || input.value || !hasSavedKey(target)) return;

  toggle.disabled = true;
  try {
    const { apiKey } = await api(`/api/config/key?target=${target}`);
    if (input.type === 'text' && !input.value) {
      if (!apiKey) throw new Error('未能读取已保存的 API Key');
      input.value = apiKey;
    }
  } catch (error) {
    setKeyVisibility(target, false);
    toast(error.message);
  } finally {
    toggle.disabled = false;
  }
}

function currentModel(target) {
  const { select, input } = modelField(target);
  if (!select.hidden && select.value && select.value !== '__custom__') return select.value;
  return input.value.trim();
}

function setModelResult(target, status, text = '') {
  const node = target === 'llm' ? els.llmTestResult : els.imageTestResult;
  node.textContent = text;
  node.classList.toggle('ok', status === 'ok');
  node.classList.toggle('err', status === 'err');
}

export function clearModelResult(target) {
  setModelResult(target, '', '');
}

function resetModelField(target) {
  const { select, input } = modelField(target);
  select.innerHTML = '';
  select.hidden = true;
  input.hidden = false;
  setModelResult(target, '', '');
}

function modelDraft(target) {
  const isLlm = target === 'llm';
  return {
    target,
    ...(isLlm ? { protocol: els.llmProtocol.value } : {}),
    baseUrl: (isLlm ? els.llmBase : els.imageBase).value.trim(),
    model: currentModel(target),
    ...(isLlm
      ? { reasoningEffort: els.llmReasoningEffort.value }
      : { quality: els.imageQuality.value }),
    apiKey: (isLlm ? els.llmKey : els.imageKey).value.trim(),
  };
}

export function openSettings() {
  const cfg = state.config;
  if (!cfg) return;
  resetModelField('llm');
  resetModelField('image');
  els.llmBase.value = cfg.llm.baseUrl || '';
  els.llmProtocol.value = cfg.llm.protocol === 'anthropic' ? 'anthropic' : 'openai';
  els.llmModel.value = cfg.llm.model || '';
  els.llmReasoningEffort.value = cfg.llm.reasoningEffort || '';
  els.llmKey.value = '';
  setKeyVisibility('llm', false);
  els.llmKey.placeholder = cfg.llm.apiKeySet
    ? `已设置 ${cfg.llm.apiKeyHint}，留空保持不变`
    : '请输入 API Key';
  els.imageBase.value = cfg.image.baseUrl || '';
  els.imageModel.value = cfg.image.model || '';
  els.imageQuality.value = cfg.image.quality || 'high';
  els.imageKey.value = '';
  setKeyVisibility('image', false);
  els.imageKey.placeholder = cfg.image.apiKeySet
    ? `已设置 ${cfg.image.apiKeyHint}，留空保持不变`
    : '请输入 API Key';
  els.settingsModal.hidden = false;
}

export function closeSettings() {
  els.settingsModal.hidden = true;
  for (const target of ['llm', 'image']) {
    const { input } = keyField(target);
    input.value = '';
    setKeyVisibility(target, false);
  }
}

export async function fetchModels(target) {
  const { select, input } = modelField(target);
  const btn = target === 'llm' ? els.llmModelFetch : els.imageModelFetch;
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '获取中…';
  setModelResult(target, 'pending', '正在获取模型列表…');

  try {
    const res = await api('/api/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(modelDraft(target)),
    });
    if (!res.ok) {
      setModelResult(target, 'err', res.error || '获取失败');
      return;
    }

    const models = res.models || [];
    select.innerHTML = '';
    for (const name of models) {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      select.appendChild(option);
    }
    const custom = document.createElement('option');
    custom.value = '__custom__';
    custom.textContent = '手动输入…';
    select.appendChild(custom);

    const current = input.value.trim();
    if (current && !models.includes(current)) {
      const option = document.createElement('option');
      option.value = current;
      option.textContent = current;
      select.insertBefore(option, custom);
    }
    select.value = current || models[0];
    input.value = select.value;
    select.hidden = false;
    input.hidden = true;
    setModelResult(target, 'ok', `已获取 ${models.length} 个模型，点击上方下拉框选择`);
  } catch (error) {
    setModelResult(target, 'err', error.message);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

export async function testConnection(target) {
  if (target === 'image') {
    const ok = confirm('图片测试会真实生成一张 1024×1024 图片并消耗额度，继续？');
    if (!ok) return;
  }

  const btn = target === 'llm' ? els.llmTest : els.imageTest;
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '测试中…';
  setModelResult(target, 'pending', '正在连接…');

  try {
    const res = await api('/api/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(modelDraft(target)),
    });
    if (res.ok) {
      setModelResult(target, 'ok', `✓ ${res.detail || '连接正常'} · ${res.latencyMs}ms`);
    } else {
      setModelResult(target, 'err', `✗ ${res.error || '连接失败'}`);
    }
  } catch (error) {
    setModelResult(target, 'err', `✗ ${error.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

export async function saveSettings() {
  const payload = {
    llm: {
      protocol: els.llmProtocol.value,
      baseUrl: els.llmBase.value.trim(),
      model: currentModel('llm'),
      reasoningEffort: els.llmReasoningEffort.value,
    },
    image: {
      baseUrl: els.imageBase.value.trim(),
      model: currentModel('image'),
      quality: els.imageQuality.value,
    },
  };
  if (els.llmKey.value.trim()) payload.llm.apiKey = els.llmKey.value.trim();
  if (els.imageKey.value.trim()) payload.image.apiKey = els.imageKey.value.trim();

  try {
    state.config = await api('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    renderModels();
    closeSettings();
    toast('设置已保存');
  } catch (error) {
    toast(error.message);
  }
}
