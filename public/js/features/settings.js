import { api, els, renderModels, state, toast } from '../core/index.js';

let draft = null;
let selected = { llm: '', image: '' };
const formEpoch = { llm: 0, image: 0 };
const requestSeq = {
  llm: { key: 0, fetch: 0, test: 0 },
  image: { key: 0, fetch: 0, test: 0 },
};

function section(target) {
  if (!draft) return null;
  return { providers: draft[target], activeId: draft.active[target] };
}

function selectedProvider(target) {
  const list = section(target)?.providers || [];
  return list.find((provider) => provider.id === selected[target]) || list[0] || null;
}

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

function providerFields(target) {
  return target === 'llm'
    ? {
        select: els.llmProviderSelect,
        name: els.llmProviderName,
        active: els.llmProviderActive,
        add: els.llmProviderAdd,
        remove: els.llmProviderDelete,
      }
    : {
        select: els.imageProviderSelect,
        name: els.imageProviderName,
        active: els.imageProviderActive,
        add: els.imageProviderAdd,
        remove: els.imageProviderDelete,
      };
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
  return Boolean(selectedProvider(target)?.apiKeySet);
}

export async function toggleKeyVisibility(target) {
  const { input, toggle } = keyField(target);
  const show = input.type === 'password';
  setKeyVisibility(target, show);
  if (!show || input.value || !hasSavedKey(target)) return;

  const requestedProvider = selectedProvider(target)?.id;
  const epoch = formEpoch[target];
  const requestId = ++requestSeq[target].key;
  toggle.disabled = true;
  const stale = () =>
    formEpoch[target] !== epoch ||
    requestSeq[target].key !== requestId ||
    selectedProvider(target)?.id !== requestedProvider;

  try {
    const providerId = encodeURIComponent(requestedProvider || '');
    const { apiKey } = await api(
      `/api/config/key?target=${target}&providerId=${providerId}`,
    );
    if (stale()) return;
    if (input.type === 'text' && !input.value) {
      if (!apiKey) throw new Error('未能读取已保存的 API Key');
      input.value = apiKey;
    }
  } catch (error) {
    if (stale()) return;
    setKeyVisibility(target, false);
    toast(error.message);
  } finally {
    if (!stale()) toggle.disabled = false;
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

function resetProbeButtons(target) {
  if (target === 'llm') {
    els.llmModelFetch.disabled = false;
    els.llmModelFetch.textContent = '获取列表';
    els.llmTest.disabled = false;
    els.llmTest.textContent = '测试连接';
  } else {
    els.imageModelFetch.disabled = false;
    els.imageModelFetch.textContent = '获取列表';
    els.imageTest.disabled = false;
    els.imageTest.textContent = '测试连接';
  }
}

function cloneProvider(provider) {
  return {
    ...provider,
    apiKey: '',
    pricing: { ...provider.pricing },
    modelPricing: { ...provider.modelPricing },
  };
}

function newProvider(target) {
  const randomId =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `provider-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    id: randomId,
    name: '新供应商',
    type: target,
    baseUrl: '',
    model: '',
    apiKey: '',
    apiKeySet: false,
    apiKeyHint: '',
    pricing: { inputPerMillion: 0, outputPerMillion: 0, imagePerImage: 0 },
    modelPricing: {},
    ...(target === 'llm'
      ? { protocol: 'openai', reasoningEffort: '', temperature: 0.7 }
      : { quality: 'high' }),
  };
}

function readForm(target) {
  const provider = selectedProvider(target);
  if (!provider) return null;
  const isLlm = target === 'llm';
  const { input: keyInput } = keyField(target);
  const apiKey = keyInput.value.trim();
  return {
    ...provider,
    name: providerFields(target).name.value.trim(),
    baseUrl: (isLlm ? els.llmBase : els.imageBase).value.trim(),
    model: currentModel(target),
    ...(isLlm
      ? {
          protocol: els.llmProtocol.value,
          reasoningEffort: els.llmReasoningEffort.value,
        }
      : { quality: els.imageQuality.value }),
    ...(apiKey ? { apiKey } : {}),
  };
}

function stash(target) {
  const provider = selectedProvider(target);
  const values = readForm(target);
  if (!provider || !values) return;
  Object.assign(provider, values);
}

function renderProviderSelect(target) {
  const fields = providerFields(target);
  const current = section(target);
  fields.select.innerHTML = '';
  for (const provider of current?.providers || []) {
    const option = document.createElement('option');
    option.value = provider.id;
    option.textContent = `${provider.id === draft.active[target] ? '✓ ' : ''}${
      provider.name || provider.model || '未命名供应商'
    }`;
    fields.select.appendChild(option);
  }
  fields.select.value = selected[target];
}

function updateActiveButton(target) {
  const fields = providerFields(target);
  const active = draft?.active?.[target] === selected[target];
  fields.active.textContent = active ? '当前供应商' : '设为当前';
  fields.active.classList.toggle('active', active);
  fields.active.setAttribute('aria-pressed', String(active));
}

function loadProviderForm(target) {
  const provider = selectedProvider(target);
  if (!provider) return;
  formEpoch[target] += 1;
  resetModelField(target);
  resetProbeButtons(target);
  const isLlm = target === 'llm';
  providerFields(target).name.value = provider.name || '';
  (isLlm ? els.llmBase : els.imageBase).value = provider.baseUrl || '';
  (isLlm ? els.llmModel : els.imageModel).value = provider.model || '';
  if (isLlm) {
    els.llmProtocol.value = provider.protocol === 'anthropic' ? 'anthropic' : 'openai';
    els.llmReasoningEffort.value = provider.reasoningEffort || '';
  } else {
    els.imageQuality.value = provider.quality || 'high';
  }
  const { input, toggle } = keyField(target);
  input.value = '';
  toggle.disabled = false;
  setKeyVisibility(target, false);
  input.placeholder = provider.apiKeySet
    ? `已设置 ${provider.apiKeyHint}，留空保持不变`
    : '请输入 API Key';
  renderProviderSelect(target);
  updateActiveButton(target);
}

export function selectProvider(target, id) {
  const current = section(target);
  if (!current?.providers.some((provider) => provider.id === id)) return;
  stash(target);
  selected[target] = id;
  loadProviderForm(target);
}

export function addProvider(target) {
  stash(target);
  const provider = newProvider(target);
  section(target).providers.push(provider);
  selected[target] = provider.id;
  renderProviderSelect(target);
  loadProviderForm(target);
  providerFields(target).name.focus();
  providerFields(target).name.select();
}

export function deleteProvider(target) {
  stash(target);
  const current = section(target);
  if (current.providers.length <= 1) {
    toast('至少保留一个供应商');
    return;
  }
  const index = current.providers.findIndex((provider) => provider.id === selected[target]);
  if (index >= 0) current.providers.splice(index, 1);
  if (draft.active[target] === selected[target]) {
    draft.active[target] = current.providers[0].id;
  }
  selected[target] = current.providers[0].id;
  renderProviderSelect(target);
  loadProviderForm(target);
}

export function activateProvider(target) {
  if (!selected[target]) return;
  stash(target);
  draft.active[target] = selected[target];
  renderProviderSelect(target);
  updateActiveButton(target);
}

function modelDraft(target) {
  const provider = readForm(target);
  if (!provider) return { target };
  const isLlm = target === 'llm';
  return {
    target,
    providerId: provider.id,
    ...(isLlm ? { protocol: provider.protocol } : {}),
    baseUrl: provider.baseUrl,
    model: provider.model,
    ...(isLlm
      ? { reasoningEffort: provider.reasoningEffort }
      : { quality: provider.quality }),
    apiKey: provider.apiKey || '',
  };
}

export function openSettings() {
  const cfg = state.config;
  if (!cfg) return;
  const llmProviders = cfg.llm.providers?.length ? cfg.llm.providers : [cfg.llm];
  const imageProviders = cfg.image.providers?.length ? cfg.image.providers : [cfg.image];
  draft = {
    llm: llmProviders.map(cloneProvider),
    image: imageProviders.map(cloneProvider),
    active: { llm: cfg.llm.activeId, image: cfg.image.activeId },
  };
  for (const target of ['llm', 'image']) {
    draft.active[target] =
      draft.active[target] || section(target).providers[0]?.id || '';
    selected[target] = draft.active[target];
    resetModelField(target);
  }
  for (const target of ['llm', 'image']) loadProviderForm(target);
  els.settingsModal.hidden = false;
}

export function closeSettings() {
  els.settingsModal.hidden = true;
  draft = null;
  formEpoch.llm += 1;
  formEpoch.image += 1;
  for (const target of ['llm', 'image']) {
    const { input, toggle } = keyField(target);
    input.value = '';
    toggle.disabled = false;
    setKeyVisibility(target, false);
    resetProbeButtons(target);
  }
}

export async function fetchModels(target) {
  const { select, input } = modelField(target);
  const btn = target === 'llm' ? els.llmModelFetch : els.imageModelFetch;
  const requestedProvider = selectedProvider(target)?.id;
  const epoch = formEpoch[target];
  const requestId = ++requestSeq[target].fetch;
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '获取中…';
  setModelResult(target, 'pending', '正在获取模型列表…');

  const stale = () =>
    formEpoch[target] !== epoch ||
    requestSeq[target].fetch !== requestId ||
    selectedProvider(target)?.id !== requestedProvider;

  try {
    const res = await api('/api/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(modelDraft(target)),
    });
    if (stale()) return;
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
    if (stale()) return;
    setModelResult(target, 'err', error.message);
  } finally {
    if (!stale()) {
      btn.disabled = false;
      btn.textContent = label;
    }
  }
}

export async function testConnection(target) {
  if (target === 'image') {
    const ok = confirm('图片测试会真实生成一张 1024×1024 图片并消耗额度，继续？');
    if (!ok) return;
  }

  const btn = target === 'llm' ? els.llmTest : els.imageTest;
  const requestedProvider = selectedProvider(target)?.id;
  const epoch = formEpoch[target];
  const requestId = ++requestSeq[target].test;
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '测试中…';
  setModelResult(target, 'pending', '正在连接…');

  const stale = () =>
    formEpoch[target] !== epoch ||
    requestSeq[target].test !== requestId ||
    selectedProvider(target)?.id !== requestedProvider;

  try {
    const res = await api('/api/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(modelDraft(target)),
    });
    if (stale()) return;
    if (res.ok) {
      setModelResult(target, 'ok', `✓ ${res.detail || '连接正常'} · ${res.latencyMs}ms`);
    } else {
      setModelResult(target, 'err', `✗ ${res.error || '连接失败'}`);
    }
  } catch (error) {
    if (stale()) return;
    setModelResult(target, 'err', `✗ ${error.message}`);
  } finally {
    if (!stale()) {
      btn.disabled = false;
      btn.textContent = label;
    }
  }
}

function providerPayload(provider, target) {
  const isLlm = target === 'llm';
  return {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    model: provider.model,
    ...(isLlm
      ? {
          protocol: provider.protocol,
          reasoningEffort: provider.reasoningEffort,
        }
      : { quality: provider.quality }),
    ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
  };
}

function usableProviders(target) {
  return draft[target].filter(
    (provider) =>
      provider.baseUrl.trim() || provider.model.trim() || provider.apiKey.trim(),
  );
}

export async function saveSettings() {
  if (!draft) return;
  stash('llm');
  stash('image');
  const payload = {};
  for (const target of ['llm', 'image']) {
    const providers = usableProviders(target);
    if (!providers.length) continue;
    const activeId = providers.some((provider) => provider.id === draft.active[target])
      ? draft.active[target]
      : providers[0].id;
    payload[target] = {
      activeId,
      providers: providers.map((provider) => providerPayload(provider, target)),
    };
  }
  if (!Object.keys(payload).length) {
    toast('请至少填写一个模型供应商');
    return;
  }

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

function providerMenuList(target) {
  const cfg = state.config;
  return cfg?.[target]?.providers?.length ? cfg[target].providers : cfg?.[target] ? [cfg[target]] : [];
}

export function closeProviderMenu() {
  if (!els.providerMenu) return;
  els.providerMenu.hidden = true;
  els.modelPill.setAttribute('aria-expanded', 'false');
}

async function switchProvider(target, id) {
  const cfg = state.config;
  if (!cfg || cfg[target].activeId === id) {
    closeProviderMenu();
    return;
  }
  try {
    const body = target === 'llm' ? { llm: { activeId: id } } : { image: { activeId: id } };
    state.config = await api('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    renderModels();
    closeProviderMenu();
    const provider = providerMenuList(target).find((row) => row.id === id);
    toast(`已切换到 ${provider?.name || '新供应商'}`);
  } catch (error) {
    toast(error.message);
  }
}

export function renderProviderMenu() {
  const cfg = state.config;
  if (!cfg) return;
  els.providerMenu.replaceChildren();
  for (const target of ['llm', 'image']) {
    const sectionNode = document.createElement('div');
    sectionNode.className = 'provider-menu-section';
    const label = document.createElement('div');
    label.className = 'provider-menu-label';
    label.textContent = target === 'llm' ? '对话供应商' : '图片供应商';
    sectionNode.appendChild(label);
    for (const provider of providerMenuList(target)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'provider-menu-item';
      button.setAttribute('role', 'menuitem');
      if (provider.id === cfg[target].activeId) button.classList.add('active');
      const check = document.createElement('span');
      check.className = 'provider-menu-check';
      check.textContent = provider.id === cfg[target].activeId ? '✓' : '';
      const text = document.createElement('span');
      text.className = 'provider-menu-text';
      const name = document.createElement('strong');
      name.textContent = provider.name || provider.model || '未命名供应商';
      const model = document.createElement('small');
      model.textContent = provider.model || '未填写模型';
      text.append(name, model);
      button.append(check, text);
      button.addEventListener('click', () => switchProvider(target, provider.id));
      sectionNode.appendChild(button);
    }
    els.providerMenu.appendChild(sectionNode);
  }
  const manage = document.createElement('button');
  manage.type = 'button';
  manage.className = 'provider-menu-manage';
  manage.textContent = '管理供应商';
  manage.addEventListener('click', () => {
    closeProviderMenu();
    openSettings();
  });
  els.providerMenu.appendChild(manage);
  els.providerMenu.hidden = false;
  els.modelPill.setAttribute('aria-expanded', 'true');
}

export function toggleProviderMenu() {
  if (!els.providerMenu) return;
  if (!els.providerMenu.hidden) {
    closeProviderMenu();
    return;
  }
  renderProviderMenu();
}
