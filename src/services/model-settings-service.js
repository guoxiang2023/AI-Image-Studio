import { getSettings, saveSettings } from '../data/repositories/model-settings.js';
import {
  DEFAULT_MODELS,
  DEFAULT_PRICING,
  IMAGE_QUALITIES,
  LLM_PROTOCOLS,
  REASONING_EFFORTS,
} from '../config.js';
import { getSecretBox } from '../shared/runtime.js';
import { clamp, keyHint, newId } from '../shared/utils.js';
import { AppError } from '../shared/errors.js';

const TARGETS = ['llm', 'image'];

function normalizeProtocol(value) {
  return LLM_PROTOCOLS.includes(value) ? value : DEFAULT_MODELS.llm.protocol;
}

function normalizePricing(value) {
  const pricing = value && typeof value === 'object' ? value : {};
  const inputPerMillion = Math.max(0, Number(pricing.inputPerMillion) || 0);
  return {
    inputPerMillion,
    cachedPerMillion:
      pricing.cachedPerMillion === undefined
        ? inputPerMillion
        : Math.max(0, Number(pricing.cachedPerMillion) || 0),
    outputPerMillion: Math.max(0, Number(pricing.outputPerMillion) || 0),
    imagePerImage: Math.max(0, Number(pricing.imagePerImage) || 0),
  };
}

function normalizeModelPricing(target, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const entries = [];
  for (const [rawModel, rawPricing] of Object.entries(value)) {
    const model = cleanModelName(rawModel);
    if (!model) continue;
    entries.push([model, targetPricing(target, rawPricing)]);
  }
  return Object.fromEntries(entries);
}

function cleanId(value) {
  const id = String(value || '').trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : '';
}

function cleanModelName(value) {
  const model = String(value || '').trim().slice(0, 200);
  if (!model || model === '__proto__' || model === 'prototype' || model === 'constructor') {
    return '';
  }
  return model;
}

function setModelPricing(modelPricing, model, pricing) {
  if (!modelPricing || typeof modelPricing !== 'object') return;
  const key = cleanModelName(model);
  if (key) modelPricing[key] = pricing;
}

function defaultName(target, baseUrl, value) {
  const name = String(value || '').trim();
  if (name) return name.slice(0, 60);
  try {
    const host = new URL(baseUrl).hostname;
    if (host) return host;
  } catch {
    /* use the generic label */
  }
  return target === 'llm' ? '默认对话供应商' : '默认图片供应商';
}

function targetPricing(target, pricing) {
  const normalized = normalizePricing(pricing);
  if (target === 'llm') {
    return { ...normalized, imagePerImage: 0 };
  }
  return {
    ...normalized,
    inputPerMillion: 0,
    cachedPerMillion: 0,
    outputPerMillion: 0,
  };
}

function normalizeProvider(target, raw, options = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const existing = options.existing || null;
  const fallbackPricing = options.fallbackPricing || DEFAULT_PRICING;
  const id =
    cleanId(source.id) ||
    cleanId(existing?.id) ||
    cleanId(options.fallbackId) ||
    `${target}-${newId()}`;
  const baseUrl = String(source.baseUrl ?? existing?.baseUrl ?? '')
    .trim()
    .replace(/\/+$/, '');
  const model = String(source.model ?? existing?.model ?? '').trim();
  const apiKey =
    typeof source.apiKey === 'string' && source.apiKey.trim()
      ? source.apiKey.trim()
      : existing?.apiKey || '';
  const protocol = normalizeProtocol(
    typeof source.protocol === 'string' ? source.protocol : existing?.protocol,
  );
  const quality =
    typeof source.quality === 'string' && IMAGE_QUALITIES.includes(source.quality)
      ? source.quality
      : existing?.quality && IMAGE_QUALITIES.includes(existing.quality)
        ? existing.quality
        : DEFAULT_MODELS.image.quality;
  const requestedEffort =
    typeof source.reasoningEffort === 'string'
      ? source.reasoningEffort.trim().toLowerCase()
      : null;
  const reasoningEffort =
    requestedEffort === null
      ? existing?.reasoningEffort ?? DEFAULT_MODELS.llm.reasoningEffort
      : requestedEffort === '' || REASONING_EFFORTS.includes(requestedEffort)
        ? requestedEffort
        : existing?.reasoningEffort ?? DEFAULT_MODELS.llm.reasoningEffort;
  const temperature = clamp(
    Number.isFinite(Number(source.temperature))
      ? Number(source.temperature)
      : Number(existing?.temperature ?? DEFAULT_MODELS.llm.temperature),
    0,
    2,
  );
  const modelPricing = normalizeModelPricing(
    target,
    source.modelPricing ?? existing?.modelPricing,
  );
  if (!Object.keys(modelPricing).length && existing?.model) {
    setModelPricing(
      modelPricing,
      existing.model,
      targetPricing(target, existing.pricing ?? fallbackPricing),
    );
  }
  const modelChanged =
    Boolean(existing?.model) &&
    source.model !== undefined &&
    model !== existing.model;
  let pricing;
  if (
    model &&
    source.pricing === undefined &&
    Object.prototype.hasOwnProperty.call(modelPricing, model)
  ) {
    pricing = modelPricing[model];
  } else if (source.pricing !== undefined) {
    pricing = targetPricing(target, source.pricing);
  } else if (modelChanged) {
    pricing = targetPricing(target, DEFAULT_PRICING);
  } else {
    pricing = targetPricing(target, existing?.pricing ?? fallbackPricing);
  }
  if (model) setModelPricing(modelPricing, model, pricing);

  return {
    id,
    name: defaultName(target, baseUrl, source.name ?? existing?.name),
    ...(target === 'llm'
      ? { protocol, reasoningEffort, temperature }
      : { quality }),
    baseUrl,
    model,
    apiKey,
    pricing,
    modelPricing,
  };
}

function defaultProvider(target) {
  return normalizeProvider(
    target,
    { id: `${target}-default`, name: defaultName(target, '', '') },
    { fallbackPricing: DEFAULT_PRICING },
  );
}

function storedProviders(target, stored, legacyPricing) {
  const source = stored && typeof stored === 'object' ? stored : {};
  const secretBox = getSecretBox();
  const pricing = targetPricing(target, legacyPricing);
  let list;
  if (Array.isArray(source.providers) && source.providers.length) {
    list = source.providers.map((raw, index) =>
      normalizeProvider(
        target,
        {
          ...raw,
          apiKey: raw?.apiKey ? secretBox.unseal(raw.apiKey) : '',
        },
        {
          fallbackId: `${target}-provider-${index + 1}`,
          fallbackPricing: pricing,
        },
      ),
    );
  } else {
    list = [
      normalizeProvider(
        target,
        {
          ...source,
          id: cleanId(source.id) || `${target}-default`,
          apiKey: source.apiKey ? secretBox.unseal(source.apiKey) : '',
        },
        { fallbackPricing: pricing },
      ),
    ];
  }

  const seen = new Set();
  for (const provider of list) {
    if (seen.has(provider.id)) provider.id = `${target}-${newId()}`;
    seen.add(provider.id);
  }
  const activeId = list.some((provider) => provider.id === source.activeId)
    ? source.activeId
    : list[0].id;
  return { activeId, providers: list };
}

function activeProvider(section) {
  return section.providers.find((provider) => provider.id === section.activeId) || section.providers[0];
}

function flattened(target, section) {
  const active = activeProvider(section);
  return {
    ...active,
    providerId: active.id,
    providerName: active.name,
    activeId: section.activeId,
    providers: section.providers,
  };
}

export function defaultSettings() {
  const llm = { activeId: 'llm-default', providers: [defaultProvider('llm')] };
  const image = { activeId: 'image-default', providers: [defaultProvider('image')] };
  return {
    llm: flattened('llm', llm),
    image: flattened('image', image),
    pricing: { ...DEFAULT_PRICING },
  };
}

export function loadSettings(userId) {
  const row = getSettings(userId);
  if (!row) {
    const settings = defaultSettings();
    saveUserSettings(userId, settings);
    return settings;
  }

  let storedLlm = {};
  let storedImage = {};
  let storedPricing = {};
  try {
    storedLlm = JSON.parse(row.llm_json || '{}');
    storedImage = JSON.parse(row.image_json || '{}');
    storedPricing = JSON.parse(row.pricing_json || '{}');
  } catch {
    /* fall back to defaults */
  }

  const pricing = normalizePricing(storedPricing);
  const llm = storedProviders('llm', storedLlm, pricing);
  const image = storedProviders('image', storedImage, pricing);
  return {
    llm: flattened('llm', llm),
    image: flattened('image', image),
    pricing,
  };
}

function serializeProvider(target, provider) {
  const secretBox = getSecretBox();
  const normalized = normalizeProvider(target, provider, { existing: provider });
  return {
    id: normalized.id,
    name: normalized.name,
    baseUrl: normalized.baseUrl,
    model: normalized.model,
    ...(target === 'llm'
      ? {
          protocol: normalized.protocol,
          reasoningEffort: normalized.reasoningEffort,
          temperature: normalized.temperature,
        }
      : { quality: normalized.quality }),
    pricing: normalized.pricing,
    modelPricing: normalized.modelPricing,
    apiKey: normalized.apiKey ? secretBox.seal(normalized.apiKey) : '',
  };
}

function serializeSection(target, section) {
  const providers = Array.isArray(section?.providers) && section.providers.length
    ? section.providers
    : [section];
  const serialized = providers.map((provider) => serializeProvider(target, provider));
  const activeId = serialized.some((provider) => provider.id === section?.activeId)
    ? section.activeId
    : serialized[0].id;
  return JSON.stringify({ activeId, providers: serialized });
}

export function saveUserSettings(userId, settings) {
  saveSettings(
    userId,
    serializeSection('llm', settings.llm),
    serializeSection('image', settings.image),
    JSON.stringify(normalizePricing(settings.pricing)),
  );
}

function publicProvider(target, provider) {
  return {
    id: provider.id,
    name: provider.name,
    type: target,
    ...(target === 'llm'
      ? {
          protocol: provider.protocol,
          reasoningEffort: provider.reasoningEffort,
          temperature: provider.temperature,
        }
      : { quality: provider.quality }),
    baseUrl: provider.baseUrl,
    model: provider.model,
    apiKeySet: Boolean(provider.apiKey),
    apiKeyHint: keyHint(provider.apiKey),
    pricing: provider.pricing,
    modelPricing: provider.modelPricing,
  };
}

function publicSection(target, section) {
  const active = activeProvider(section);
  return {
    ...publicProvider(target, active),
    activeId: section.activeId,
    providers: section.providers.map((provider) => publicProvider(target, provider)),
  };
}

export function publicSettings(userId) {
  const settings = loadSettings(userId);
  return {
    llm: publicSection('llm', settings.llm),
    image: publicSection('image', settings.image),
    pricing: settings.pricing,
  };
}

export function getPricing(userId) {
  return loadSettings(userId).pricing;
}

export function getPricingContext(userId) {
  const settings = loadSettings(userId);
  const providers = new Map();
  for (const target of TARGETS) {
    const section = settings[target];
    for (const provider of section.providers) {
      providers.set(provider.id, {
        id: provider.id,
        name: provider.name,
        type: target,
        model: provider.model,
        active: provider.id === section.activeId,
        pricing: provider.pricing,
        modelPricing: provider.modelPricing,
      });
    }
  }
  return {
    providers,
    legacy: settings.pricing,
    active: {
      llm: settings.llm.providerId,
      image: settings.image.providerId,
    },
  };
}

export function revealApiKey(userId, target, providerId = '') {
  const section = loadSettings(userId)[target];
  if (!section) return '';
  const provider = providerId
    ? section.providers.find((row) => row.id === providerId)
    : activeProvider(section);
  return provider?.apiKey || '';
}

function blankProvider(target) {
  return {
    id: '',
    name: '',
    baseUrl: '',
    model: '',
    apiKey: '',
    ...(target === 'llm'
      ? {
          protocol: DEFAULT_MODELS.llm.protocol,
          reasoningEffort: DEFAULT_MODELS.llm.reasoningEffort,
          temperature: DEFAULT_MODELS.llm.temperature,
        }
      : { quality: DEFAULT_MODELS.image.quality }),
    pricing: { ...DEFAULT_PRICING },
    modelPricing: {},
  };
}

export function draftSettings(body, target, userId) {
  const section = loadSettings(userId)[target];
  const matched = body.providerId
    ? section.providers.find((provider) => provider.id === body.providerId)
    : null;
  // A provider ID that is not saved yet must never inherit the active provider's key.
  const stored = body.providerId ? matched || blankProvider(target) : section;
  const provider = normalizeProvider(target, body, { existing: stored });
  const baseUrl = String(provider.baseUrl || '').trim();
  const model = String(provider.model || '').trim();
  if (!baseUrl) return { error: '请填写接口地址' };
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return { error: '接口地址格式不正确' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: '接口地址只支持 http/https' };
  }
  if (!model) return { error: '请填写或选择模型名称' };
  return {
    ...provider,
    baseUrl,
  };
}

function validProvider(target, provider) {
  if (!provider.baseUrl) throw new AppError(400, '请填写供应商接口地址');
  try {
    const parsed = new URL(provider.baseUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error();
  } catch {
    throw new AppError(400, '供应商接口地址格式不正确');
  }
  if (!provider.model) throw new AppError(400, '请填写供应商模型名称');
  if (!provider.name) throw new AppError(400, '请填写供应商名称');
}

function mergeProviderList(target, current, incoming) {
  const existingById = new Map(current.providers.map((provider) => [provider.id, provider]));
  const providers = [];
  const seen = new Set();
  for (const raw of incoming.providers) {
    const existing = existingById.get(cleanId(raw?.id)) || null;
    const provider = normalizeProvider(target, raw, {
      existing,
      fallbackPricing: existing?.pricing || DEFAULT_PRICING,
    });
    validProvider(target, provider);
    if (seen.has(provider.id)) provider.id = `${target}-${newId()}`;
    seen.add(provider.id);
    providers.push(provider);
  }
  if (!providers.length) throw new AppError(400, '至少保留一个供应商');
  return {
    providers,
    activeId: providers.some((provider) => provider.id === incoming.activeId)
      ? incoming.activeId
      : providers.some((provider) => provider.id === current.activeId)
        ? current.activeId
        : providers[0].id,
  };
}

function applyLegacyPatch(target, section, patch) {
  const active = activeProvider(section);
  let changed = false;
  for (const field of ['baseUrl', 'model', 'name']) {
    if (typeof patch[field] === 'string' && patch[field].trim()) {
      active[field] = patch[field].trim();
      changed = true;
    }
  }
  if (target === 'llm' && typeof patch.protocol === 'string' && LLM_PROTOCOLS.includes(patch.protocol)) {
    active.protocol = patch.protocol;
    changed = true;
  }
  if (target === 'image' && typeof patch.quality === 'string') {
    const quality = patch.quality.trim().toLowerCase();
    if (IMAGE_QUALITIES.includes(quality)) {
      active.quality = quality;
      changed = true;
    }
  }
  if (target === 'llm' && typeof patch.reasoningEffort === 'string') {
    const effort = patch.reasoningEffort.trim().toLowerCase();
    if (!effort || REASONING_EFFORTS.includes(effort)) {
      active.reasoningEffort = effort;
      changed = true;
    }
  }
  if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) {
    active.apiKey = patch.apiKey.trim();
    changed = true;
  }
  if (Number.isFinite(Number(patch.temperature))) {
    active.temperature = clamp(Number(patch.temperature), 0, 2);
    changed = true;
  }
  if (typeof patch.activeId === 'string' && section.providers.some((row) => row.id === patch.activeId)) {
    section.activeId = patch.activeId;
    changed = true;
  }
  return changed;
}

export function updateSettingsPatch(userId, body) {
  const settings = loadSettings(userId);
  let changed = false;

  for (const target of TARGETS) {
    const patch = body[target];
    if (!patch || typeof patch !== 'object') continue;
    if (Array.isArray(patch.providers)) {
      const merged = mergeProviderList(target, settings[target], patch);
      settings[target] = merged;
      changed = true;
    } else if (applyLegacyPatch(target, settings[target], patch)) {
      changed = true;
    }
  }

  if (body.modelPricing && typeof body.modelPricing === 'object') {
    for (const target of TARGETS) {
      for (const provider of settings[target].providers) {
        const models = body.modelPricing[provider.id];
        if (!models || typeof models !== 'object') continue;
        for (const [rawModel, rawPricing] of Object.entries(models)) {
          const model = cleanModelName(rawModel);
          if (!model || !rawPricing || typeof rawPricing !== 'object') continue;
          const pricing = targetPricing(target, {
            ...provider.modelPricing?.[model],
            ...rawPricing,
          });
          setModelPricing(provider.modelPricing, model, pricing);
          if (model === provider.model) provider.pricing = pricing;
          changed = true;
        }
      }
    }
  }

  if (body.providerPricing && typeof body.providerPricing === 'object') {
    for (const target of TARGETS) {
      for (const provider of settings[target].providers) {
        const pricing = body.providerPricing[provider.id];
        if (!pricing || typeof pricing !== 'object') continue;
        const rawPricing =
          pricing.cachedPerMillion === undefined &&
          pricing.inputPerMillion !== undefined
            ? { ...pricing, cachedPerMillion: pricing.inputPerMillion }
            : pricing;
        provider.pricing = targetPricing(target, {
          ...provider.pricing,
          ...rawPricing,
        });
        if (provider.model) setModelPricing(provider.modelPricing, provider.model, provider.pricing);
        changed = true;
      }
    }
  }

  if (body.pricing && typeof body.pricing === 'object') {
    const rawPricing =
      body.pricing.cachedPerMillion === undefined &&
      body.pricing.inputPerMillion !== undefined
        ? { ...body.pricing, cachedPerMillion: body.pricing.inputPerMillion }
        : body.pricing;
    settings.pricing = normalizePricing({ ...settings.pricing, ...rawPricing });
    for (const target of TARGETS) {
      const active = activeProvider(settings[target]);
      active.pricing = targetPricing(target, {
        ...active.pricing,
        ...rawPricing,
      });
      if (active.model) setModelPricing(active.modelPricing, active.model, active.pricing);
    }
    changed = true;
  }

  if (changed) saveUserSettings(userId, settings);
  return publicSettings(userId);
}
