import { estimateTokens } from '../domain/chat.js';
import {
  insertUsageEvent,
  listUsageByModel,
  listUsageByProvider,
  listUsageDailyByProvider,
  listUsageSessionsByProvider,
} from '../data/repositories/usage.js';
import { getPricingContext } from './model-settings-service.js';
import { now } from '../shared/utils.js';

function number(value) {
  return Math.max(0, Math.round(Number(value) || 0));
}

export function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const promptTokens = number(usage.prompt_tokens ?? usage.input_tokens);
  const completionTokens = number(usage.completion_tokens ?? usage.output_tokens);
  const totalTokens = number(usage.total_tokens) || promptTokens + completionTokens;
  const details = usage.prompt_tokens_details || usage.input_tokens_details || {};
  const cachedTokens = Math.min(
    promptTokens,
    number(
      details.cached_tokens ??
        usage.cache_read_input_tokens ??
        usage.prompt_cache_hit_tokens ??
        usage.cached_tokens,
    ),
  );
  if (!promptTokens && !completionTokens && !totalTokens) return null;
  return { promptTokens, cachedTokens, completionTokens, totalTokens };
}

export function promptTokenEstimate(messages) {
  if (!Array.isArray(messages)) return 0;
  return messages.reduce((total, message) => {
    if (!message || typeof message !== 'object') return total;
    let text = String(message.content || '');
    if (Array.isArray(message.tool_calls)) text += JSON.stringify(message.tool_calls);
    return total + estimateTokens(`${message.role || ''}\n${text}`) + 4;
  }, 0);
}

export function completionTokenEstimate(content, toolCalls) {
  let text = String(content || '');
  if (Array.isArray(toolCalls) && toolCalls.length) text += JSON.stringify(toolCalls);
  return estimateTokens(text);
}

export function recordLlmUsage({
  userId,
  chatId,
  turnId,
  kind = 'chat',
  model,
  providerId,
  providerName,
  usage,
  messages,
  completionText,
  toolCalls,
  requestCount = 1,
}) {
  if (!userId) return;
  const actual = normalizeUsage(usage);
  const promptTokens = actual?.promptTokens ?? promptTokenEstimate(messages);
  const completionTokens =
    actual?.completionTokens ?? completionTokenEstimate(completionText, toolCalls);
  const totalTokens = actual?.totalTokens || promptTokens + completionTokens;
  try {
    insertUsageEvent({
      userId,
      chatId,
      turnId,
      kind,
      model,
      providerId,
      providerName,
      providerType: 'llm',
      promptTokens,
      cachedTokens: actual?.cachedTokens || 0,
      completionTokens,
      totalTokens,
      requests: Math.max(1, number(requestCount)),
      images: 0,
      estimated: actual ? 0 : 1,
      createdAt: now(),
    });
  } catch (err) {
    console.warn('用量记录失败:', err.message);
  }
}

export function recordImageUsage({
  userId,
  chatId,
  turnId,
  model,
  providerId,
  providerName,
  images,
  requestCount = 1,
}) {
  if (!userId) return;
  try {
    insertUsageEvent({
      userId,
      chatId,
      turnId,
      kind: 'image',
      model,
      providerId,
      providerName,
      providerType: 'image',
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      requests: Math.max(1, number(requestCount)),
      images: number(images),
      estimated: 0,
      createdAt: now(),
    });
  } catch (err) {
    console.warn('图片用量记录失败:', err.message);
  }
}

function pricingConfigured(pricing) {
  return (
    Number(pricing?.inputPerMillion) > 0 ||
    Number(pricing?.cachedPerMillion) > 0 ||
    Number(pricing?.outputPerMillion) > 0 ||
    Number(pricing?.imagePerImage) > 0
  );
}

const ZERO_PRICING = Object.freeze({
  inputPerMillion: 0,
  cachedPerMillion: 0,
  outputPerMillion: 0,
  imagePerImage: 0,
});

function estimateCost(row, pricing) {
  const input = Number(pricing?.inputPerMillion) || 0;
  const cachedPrice = Number(pricing?.cachedPerMillion) || 0;
  const output = Number(pricing?.outputPerMillion) || 0;
  const image = Number(pricing?.imagePerImage) || 0;
  const promptTokens = Number(row.prompt_tokens || 0);
  const cachedTokens = Math.min(promptTokens, Number(row.cached_tokens || 0));
  return (
    ((promptTokens - cachedTokens) / 1_000_000) * input +
    (cachedTokens / 1_000_000) * cachedPrice +
    (Number(row.completion_tokens || 0) / 1_000_000) * output +
    Number(row.images || 0) * image
  );
}

function pricingFor(row, context) {
  const provider = row.provider_id ? context.providers.get(row.provider_id) : null;
  if (!provider) return context.legacy;
  const model = String(row.model || '');
  if (model && Object.prototype.hasOwnProperty.call(provider.modelPricing || {}, model)) {
    return provider.modelPricing[model];
  }
  if (!model || model === provider.model) return provider.pricing || ZERO_PRICING;
  return ZERO_PRICING;
}

function emptyRaw() {
  return {
    prompt_tokens: 0,
    cached_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    llm_requests: 0,
    image_requests: 0,
    images: 0,
    estimated_tokens: 0,
  };
}

function addRaw(target, row) {
  target.prompt_tokens += Number(row.prompt_tokens || 0);
  target.cached_tokens += Number(row.cached_tokens || 0);
  target.completion_tokens += Number(row.completion_tokens || 0);
  target.total_tokens += Number(row.total_tokens || 0);
  target.llm_requests += Number(row.llm_requests || 0);
  target.image_requests += Number(row.image_requests || 0);
  target.images += Number(row.images || 0);
  target.estimated_tokens += Number(row.estimated_tokens || 0);
}

function totalsFromRaw(raw, cost) {
  return {
    promptTokens: raw.prompt_tokens,
    cachedTokens: raw.cached_tokens,
    cacheHitRate: raw.prompt_tokens
      ? Number((raw.cached_tokens / raw.prompt_tokens).toFixed(6))
      : 0,
    completionTokens: raw.completion_tokens,
    totalTokens: raw.total_tokens,
    llmRequests: raw.llm_requests,
    imageRequests: raw.image_requests,
    images: raw.images,
    estimatedTokens: raw.estimated_tokens,
    cost: Number(cost.toFixed(6)),
  };
}

function aggregateRows(rows, context) {
  const raw = emptyRaw();
  let cost = 0;
  for (const row of rows) {
    addRaw(raw, row);
    cost += estimateCost(row, pricingFor(row, context));
  }
  return totalsFromRaw(raw, cost);
}

function providerUsage(context, rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.provider_id || 'legacy';
    let group = groups.get(key);
    if (!group) {
      group = {
        id: row.provider_id || null,
        name: row.provider_name || '历史记录',
        type: row.provider_type || null,
        raw: emptyRaw(),
        cost: 0,
      };
      groups.set(key, group);
    }
    if (!group.name && row.provider_name) group.name = row.provider_name;
    if (!group.type && row.provider_type) group.type = row.provider_type;
    addRaw(group.raw, row);
    group.cost += estimateCost(row, pricingFor(row, context));
  }

  const providers = [];
  const consumed = new Set();
  for (const provider of context.providers.values()) {
    const group = groups.get(provider.id);
    if (group) consumed.add(provider.id);
    const raw = group?.raw || emptyRaw();
    const cost = group?.cost || 0;
    providers.push({
      id: provider.id,
      name: provider.name,
      type: provider.type,
      active: provider.active,
      pricing: provider.pricing,
      historical: false,
      ...totalsFromRaw(raw, cost),
    });
  }
  for (const [key, group] of groups) {
    if (consumed.has(key)) continue;
    providers.push({
      id: group.id,
      name: group.name,
      type: group.type,
      active: false,
      pricing: context.legacy,
      historical: true,
      ...totalsFromRaw(group.raw, group.cost),
    });
  }
  return providers;
}

function modelUsage(context, rows) {
  const groups = new Map();
  for (const row of rows) {
    const model = row.model || '';
    const type = row.provider_type || '';
    const key = `${model}\u0000${type}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        model: model || null,
        type: type || null,
        raw: emptyRaw(),
        cost: 0,
        pricingConfigured: true,
        providers: new Set(),
      };
      groups.set(key, group);
    }
    group.providers.add(row.provider_id || row.provider_name || '__legacy__');
    addRaw(group.raw, row);
    const pricing = pricingFor(row, context);
    group.cost += estimateCost(row, pricing);
    if (!pricingConfigured(pricing)) group.pricingConfigured = false;
  }

  return Array.from(groups.values())
    .map((group) => ({
      model: group.model,
      type: group.type,
      providerCount: group.providers.size,
      pricingConfigured: group.pricingConfigured,
      ...totalsFromRaw(group.raw, group.cost),
    }))
    .sort(
      (left, right) =>
        right.cost - left.cost ||
        right.totalTokens - left.totalTokens ||
        right.images - left.images ||
        right.llmRequests + right.imageRequests - (left.llmRequests + left.imageRequests),
    );
}

function pricingRows(context, rows) {
  const entries = new Map();
  const keyFor = (providerId, model) => `${providerId || ''}\u0000${model || ''}`;

  for (const provider of context.providers.values()) {
    const models = new Set(Object.keys(provider.modelPricing || {}));
    if (provider.model) models.add(provider.model);
    for (const model of models) {
      let pricing = provider.modelPricing?.[model];
      if (!pricing && model === provider.model) pricing = provider.pricing;
      entries.set(keyFor(provider.id, model), {
        providerId: provider.id,
        providerName: provider.name,
        type: provider.type,
        model,
        pricing: pricing || ZERO_PRICING,
        active: provider.active,
        historical: false,
        raw: emptyRaw(),
        cost: 0,
      });
    }
  }

  for (const row of rows) {
    const model = row.model || '';
    const key = keyFor(row.provider_id, model);
    let entry = entries.get(key);
    if (!entry) {
      const provider = row.provider_id ? context.providers.get(row.provider_id) : null;
      let pricing = context.legacy;
      if (provider) {
        if (Object.prototype.hasOwnProperty.call(provider.modelPricing || {}, model)) {
          pricing = provider.modelPricing[model];
        } else if (!model || model === provider.model) {
          pricing = provider.pricing;
        } else {
          pricing = ZERO_PRICING;
        }
      }
      entry = {
        providerId: row.provider_id || null,
        providerName: row.provider_name || '历史记录',
        type: row.provider_type || null,
        model,
        pricing: pricing || ZERO_PRICING,
        active: false,
        historical: !provider,
        raw: emptyRaw(),
        cost: 0,
      };
      entries.set(key, entry);
    }
    if (!entry.type && row.provider_type) entry.type = row.provider_type;
    if (!entry.providerName && row.provider_name) entry.providerName = row.provider_name;
    addRaw(entry.raw, row);
    entry.cost += estimateCost(row, entry.pricing);
  }

  return Array.from(entries.values())
    .map((entry) => ({
      providerId: entry.providerId,
      providerName: entry.providerName,
      type: entry.type,
      model: entry.model,
      pricing: entry.pricing,
      active: entry.active,
      historical: entry.historical,
      ...totalsFromRaw(entry.raw, entry.cost),
    }))
    .sort(
      (left, right) =>
        Number(left.historical) - Number(right.historical) ||
        String(left.providerName || '').localeCompare(String(right.providerName || '')) ||
        String(left.model || '').localeCompare(String(right.model || '')),
    );
}

function sessionsFromRows(rows, context) {
  const map = new Map();
  for (const row of rows) {
    let session = map.get(row.id);
    if (!session) {
      session = {
        id: row.id,
        title: row.title || '新对话',
        updatedAt: row.updated_at,
        archivedAt: row.archived_at || null,
        raw: emptyRaw(),
        cost: 0,
      };
      map.set(row.id, session);
    }
    addRaw(session.raw, row);
    session.cost += estimateCost(row, pricingFor(row, context));
  }
  return Array.from(map.values()).map((session) => ({
    id: session.id,
    title: session.title,
    updatedAt: session.updatedAt,
    archivedAt: session.archivedAt,
    ...totalsFromRaw(session.raw, session.cost),
  }));
}

function dayKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function dailyUsage(userId, context, days = 7) {
  const end = new Date();
  end.setHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setDate(start.getDate() - (days - 1));
  const byDay = new Map();
  for (const row of listUsageDailyByProvider(userId, start.getTime())) {
    let group = byDay.get(row.day);
    if (!group) {
      group = { raw: emptyRaw(), cost: 0 };
      byDay.set(row.day, group);
    }
    addRaw(group.raw, row);
    group.cost += estimateCost(row, pricingFor(row, context));
  }
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    const key = dayKey(date);
    const group = byDay.get(key) || { raw: emptyRaw(), cost: 0 };
    return {
      date: key,
      ...totalsFromRaw(group.raw, group.cost),
    };
  });
}

export function usageOverview(userId, sessionId = null) {
  const context = getPricingContext(userId);
  const rows = listUsageByProvider(userId);
  const modelRows = listUsageByModel(userId);
  const providers = providerUsage(context, rows);
  const models = modelUsage(context, modelRows);
  const pricingModels = pricingRows(context, modelRows);
  const totals = aggregateRows(rows, context);
  const sessions = sessionsFromRows(listUsageSessionsByProvider(userId), context);
  const configured =
    pricingModels.some((row) => pricingConfigured(row.pricing)) ||
    pricingConfigured(context.legacy);
  return {
    pricing: context.legacy,
    pricingConfigured: configured,
    currentSessionId: sessionId || null,
    totals,
    providers,
    models,
    pricingModels,
    sessions,
    daily: dailyUsage(userId, context),
  };
}
