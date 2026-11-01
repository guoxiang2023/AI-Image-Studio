import { getSettings, saveSettings } from '../data/repositories/model-settings.js';
import { DEFAULT_MODELS } from '../config.js';
import { getSecretBox } from '../shared/runtime.js';
import { clamp, keyHint } from '../shared/utils.js';

export function defaultSettings() {
  return {
    llm: { ...DEFAULT_MODELS.llm, apiKey: '' },
    image: { ...DEFAULT_MODELS.image, apiKey: '' },
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
  try {
    storedLlm = JSON.parse(row.llm_json || '{}');
    storedImage = JSON.parse(row.image_json || '{}');
  } catch {
    /* fall back to defaults */
  }

  const secretBox = getSecretBox();
  return {
    llm: {
      baseUrl: storedLlm.baseUrl || DEFAULT_MODELS.llm.baseUrl,
      model: storedLlm.model || DEFAULT_MODELS.llm.model,
      temperature:
        typeof storedLlm.temperature === 'number'
          ? storedLlm.temperature
          : DEFAULT_MODELS.llm.temperature,
      apiKey: storedLlm.apiKey ? secretBox.unseal(storedLlm.apiKey) : '',
    },
    image: {
      baseUrl: storedImage.baseUrl || DEFAULT_MODELS.image.baseUrl,
      model: storedImage.model || DEFAULT_MODELS.image.model,
      apiKey: storedImage.apiKey ? secretBox.unseal(storedImage.apiKey) : '',
    },
  };
}

export function saveUserSettings(userId, settings) {
  const secretBox = getSecretBox();
  saveSettings(
    userId,
    JSON.stringify({
      ...settings.llm,
      apiKey: settings.llm.apiKey ? secretBox.seal(settings.llm.apiKey) : '',
    }),
    JSON.stringify({
      ...settings.image,
      apiKey: settings.image.apiKey ? secretBox.seal(settings.image.apiKey) : '',
    }),
  );
}

export function publicSettings(userId) {
  const settings = loadSettings(userId);
  return {
    llm: {
      baseUrl: settings.llm.baseUrl,
      model: settings.llm.model,
      apiKeySet: Boolean(settings.llm.apiKey),
      apiKeyHint: keyHint(settings.llm.apiKey),
    },
    image: {
      baseUrl: settings.image.baseUrl,
      model: settings.image.model,
      apiKeySet: Boolean(settings.image.apiKey),
      apiKeyHint: keyHint(settings.image.apiKey),
    },
  };
}

export function draftSettings(body, target, userId) {
  const stored = loadSettings(userId)[target];
  const baseUrl = String(body.baseUrl || stored.baseUrl || '').trim();
  const model = String(body.model || stored.model || '').trim();
  const apiKey = String(body.apiKey || '').trim() || stored.apiKey;
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
    baseUrl: baseUrl.replace(/\/+$/, ''),
    model,
    apiKey,
    temperature: stored.temperature,
  };
}

export function updateSettingsPatch(userId, body) {
  const settings = loadSettings(userId);
  let changed = false;

  for (const section of ['llm', 'image']) {
    const patch = body[section];
    if (!patch || typeof patch !== 'object') continue;
    for (const field of ['baseUrl', 'model']) {
      if (typeof patch[field] === 'string' && patch[field].trim()) {
        settings[section][field] = patch[field].trim();
        changed = true;
      }
    }
    if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) {
      settings[section].apiKey = patch.apiKey.trim();
      changed = true;
    }
  }
  if (Number.isFinite(Number(body.llm?.temperature))) {
    settings.llm.temperature = clamp(Number(body.llm.temperature), 0, 2);
    changed = true;
  }

  if (changed) saveUserSettings(userId, settings);
  return publicSettings(userId);
}
