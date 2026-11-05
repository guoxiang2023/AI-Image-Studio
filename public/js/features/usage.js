import { api, els, state, toast } from '../core/index.js';
import { openSession } from './sessions.js';

const numberFormat = new Intl.NumberFormat('zh-CN');
const SVG_NS = 'http://www.w3.org/2000/svg';
const METRICS = {
  tokens: {
    value: (day) => Number(day.totalTokens) || 0,
    axis: (value) => compact(value),
    summary: (value) => `${tokens(value)} Tokens`,
  },
  requests: {
    value: (day) => (Number(day.llmRequests) || 0) + (Number(day.imageRequests) || 0),
    axis: (value) => compact(value),
    summary: (value) => `${tokens(value)} 次请求`,
  },
  cost: {
    value: (day) => Number(day.cost) || 0,
    axis: (value) => `$${value < 0.01 ? value.toFixed(5) : value.toFixed(2)}`,
    summary: (value, data) =>
      data.pricingConfigured ? `$${value < 0.01 ? value.toFixed(6) : value.toFixed(4)}` : '未配置单价',
  },
};

let usageData = null;
let activeMetric = 'tokens';
let activeTab = 'sessions';
let lastChartWidth = 0;
let chartObserver = null;

function observeChartWidth() {
  if (chartObserver || typeof ResizeObserver === 'undefined') return;
  chartObserver = new ResizeObserver(() => {
    const width = Math.round(els.usageChart.clientWidth || 0);
    if (usageData && width > 0 && width !== lastChartWidth) {
      renderChart(usageData);
    }
  });
  chartObserver.observe(els.usageChart);
}

function tokens(value) {
  return numberFormat.format(Number(value) || 0);
}

function percent(value) {
  const rate = Math.max(0, Number(value) || 0) * 100;
  return `${rate.toFixed(rate > 0 && rate < 1 ? 2 : 1)}%`;
}

function cacheRate(row) {
  return Number(row.promptTokens) > 0 ? percent(row.cacheHitRate) : '—';
}

function cost(value, configured) {
  if (!configured) return '未配置';
  const amount = Number(value) || 0;
  return `$${amount < 0.01 ? amount.toFixed(6) : amount.toFixed(4)}`;
}

function compact(value) {
  const amount = Number(value) || 0;
  if (amount >= 1_000_000_000) return `${(amount / 1_000_000_000).toFixed(1)}B`;
  if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(1)}M`;
  if (amount >= 1_000) return `${(amount / 1_000).toFixed(1)}K`;
  if (amount > 0 && amount < 1) return amount.toFixed(2);
  return String(Math.round(amount));
}

function emptyUsage() {
  return {
    promptTokens: 0,
    cachedTokens: 0,
    cacheHitRate: 0,
    completionTokens: 0,
    totalTokens: 0,
    llmRequests: 0,
    imageRequests: 0,
    images: 0,
    estimatedTokens: 0,
    cost: 0,
  };
}

function renderSummary(data) {
  const usage = data.totals || emptyUsage();
  els.usageCurrentTitle.textContent = `全部时间 · 全部会话`;
  els.usageTokens.textContent = tokens(usage.totalTokens);
  els.usageTokenDetail.textContent = `输入 ${tokens(usage.promptTokens)} · 输出 ${tokens(usage.completionTokens)}`;
  els.usageCacheRate.textContent = usage.promptTokens ? percent(usage.cacheHitRate) : '—';
  els.usageCacheDetail.textContent = `缓存 ${tokens(usage.cachedTokens)} / 输入 ${tokens(usage.promptTokens)}`;
  els.usageRequests.textContent = tokens(usage.llmRequests + usage.imageRequests);
  els.usageRequestDetail.textContent = `对话 ${tokens(usage.llmRequests)} · 图片 ${tokens(usage.imageRequests)}`;
  els.usageImages.textContent = tokens(usage.images);
  els.usageImageDetail.textContent = `生成 ${tokens(usage.images)} 张`;
  els.usageCost.textContent = cost(usage.cost, data.pricingConfigured);
  els.usageCostNote.textContent = data.pricingConfigured ? '按当前单价估算' : '填写单价后显示';
  const estimated = Number(usage.estimatedTokens) || 0;
  els.usageEstimateNote.hidden = estimated <= 0;
  if (estimated > 0) {
    els.usageEstimateNote.textContent = `其中 ${tokens(estimated)} tokens 由消息长度估算（供应商未返回 usage），费用仅供参考。`;
  }
  els.usageTotals.textContent = `${tokens(data.sessions?.length || 0)} 个会话 · 全部时间`;
}

function pricingSet(pricing) {
  return (
    Number(pricing?.inputPerMillion) > 0 ||
    Number(pricing?.cachedPerMillion) > 0 ||
    Number(pricing?.outputPerMillion) > 0 ||
    Number(pricing?.imagePerImage) > 0
  );
}

function providerTypeLabel(type) {
  if (type === 'llm') return '对话';
  if (type === 'image') return '图片';
  return '历史';
}

function appendBadge(parent, text, className = '') {
  const badge = document.createElement('span');
  badge.className = `usage-provider-badge ${className}`.trim();
  badge.textContent = text;
  parent.appendChild(badge);
}

function renderPricing(data) {
  const rows = data.pricingModels || [];
  els.usagePricingList.replaceChildren();
  for (const row of rows) {
    const card = document.createElement('div');
    card.className = 'usage-provider-price';
    if (row.providerId) card.dataset.providerId = row.providerId;
    if (row.model) card.dataset.model = row.model;
    if (row.historical) card.classList.add('historical');

    const head = document.createElement('div');
    head.className = 'usage-provider-price-head';
    const identity = document.createElement('div');
    identity.className = 'usage-provider-identity';
    const name = document.createElement('strong');
    name.textContent = row.providerName || '未命名供应商';
    identity.appendChild(name);
    appendBadge(
      identity,
      row.historical ? '历史' : providerTypeLabel(row.type),
      `is-${row.historical ? 'legacy' : row.type || 'legacy'}`,
    );
    if (row.active) appendBadge(identity, '当前', 'is-active');

    const total = document.createElement('span');
    total.className = 'usage-provider-total';
    total.textContent = pricingSet(row.pricing)
      ? cost(row.cost, true)
      : '费用未配置';
    head.append(identity, total);
    card.appendChild(head);

    const model = document.createElement('div');
    model.className = 'usage-provider-model';
    model.textContent = row.model || '未设置模型';
    card.appendChild(model);

    const stats = document.createElement('div');
    stats.className = 'usage-provider-stats';
    stats.textContent = `请求 ${tokens(
      (row.llmRequests || 0) + (row.imageRequests || 0),
    )} · Tokens ${tokens(row.totalTokens)} · 图片 ${tokens(row.images)}${
      row.type === 'llm' ? ` · 缓存 ${cacheRate(row)}` : ''
    }`;
    card.appendChild(stats);

    if (!row.historical) {
      const inputs = document.createElement('div');
      inputs.className = 'usage-provider-inputs';
      const fields =
        row.type === 'llm'
          ? [
              ['inputPerMillion', '输入 / 百万 Token'],
              ['cachedPerMillion', '缓存命中 / 百万 Token'],
              ['outputPerMillion', '输出 / 百万 Token'],
            ]
          : [['imagePerImage', '每张图片']];
      for (const [key, label] of fields) {
        const field = document.createElement('label');
        field.textContent = label;
        const input = document.createElement('input');
        input.type = 'number';
        input.min = '0';
        input.step = '0.0001';
        input.inputMode = 'decimal';
        input.dataset.price = key;
        input.value = String(row.pricing?.[key] || 0);
        field.appendChild(input);
        inputs.appendChild(field);
      }
      card.appendChild(inputs);
    }

    els.usagePricingList.appendChild(card);
  }
  els.usagePricingNote.textContent = rows.some((row) => !row.historical)
    ? '修改后点击保存，费用将按对应供应商和模型的单价重新估算。'
    : '配置供应商后即可设置对应费用。';
}

function renderSessions(data) {
  const currentId = state.sessionId;
  const rows = data.sessions || [];
  els.usageRows.replaceChildren();
  els.usageEmpty.hidden = rows.length > 0;
  for (const session of rows) {
    const tr = document.createElement('tr');
    tr.tabIndex = 0;
    if (session.id === currentId) tr.classList.add('active');
    tr.addEventListener('click', () => selectSession(session.id));
    tr.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectSession(session.id);
      }
    });

    const title = document.createElement('td');
    title.className = 'usage-session-title';
    title.textContent = session.title || '新对话';
    if (session.archivedAt) title.textContent += '（已归档）';
    tr.appendChild(title);

    for (const value of [
      tokens(session.totalTokens),
      tokens(session.llmRequests + session.imageRequests),
      tokens(session.images),
      cacheRate(session),
      cost(session.cost, data.pricingConfigured),
    ]) {
      const td = document.createElement('td');
      td.className = 'usage-num';
      td.textContent = value;
      tr.appendChild(td);
    }
    els.usageRows.appendChild(tr);
  }
}

function identityCell(name, type, { active = false, historical = false } = {}) {
  const td = document.createElement('td');
  const identity = document.createElement('div');
  identity.className = 'usage-cell-identity';
  const label = document.createElement('strong');
  label.textContent = name;
  identity.appendChild(label);
  appendBadge(
    identity,
    historical ? '历史' : providerTypeLabel(type),
    `is-${historical ? 'legacy' : type || 'legacy'}`,
  );
  if (active) appendBadge(identity, '当前', 'is-active');
  td.appendChild(identity);
  return td;
}

function appendUsageCells(tr, values) {
  for (const value of values) {
    const td = document.createElement('td');
    td.className = 'usage-num';
    td.textContent = value;
    tr.appendChild(td);
  }
}

function renderProviderStats(data) {
  const providers = data.providers || [];
  els.usageProviderRows.replaceChildren();
  els.usageProvidersEmpty.hidden = providers.length > 0;
  for (const provider of providers) {
    const tr = document.createElement('tr');
    tr.appendChild(
      identityCell(provider.name || '未命名供应商', provider.type, {
        active: provider.active,
        historical: provider.historical,
      }),
    );
    appendUsageCells(tr, [
      tokens(provider.totalTokens),
      tokens(provider.llmRequests + provider.imageRequests),
      tokens(provider.images),
      cacheRate(provider),
      cost(provider.cost, pricingSet(provider.pricing) || Number(provider.cost) > 0),
    ]);
    els.usageProviderRows.appendChild(tr);
  }
}

function renderModelStats(data) {
  const models = data.models || [];
  els.usageModelRows.replaceChildren();
  els.usageModelsEmpty.hidden = models.length > 0;
  for (const model of models) {
    const tr = document.createElement('tr');
    tr.appendChild(
      identityCell(model.model || '未记录模型', model.type, {
        historical: !model.type,
      }),
    );
    const providerCount = document.createElement('td');
    providerCount.className = 'usage-num';
    providerCount.textContent = `${tokens(model.providerCount)} 个`;
    tr.appendChild(providerCount);
    appendUsageCells(tr, [
      tokens(model.totalTokens),
      tokens(model.llmRequests + model.imageRequests),
      tokens(model.images),
      cacheRate(model),
      cost(model.cost, model.pricingConfigured || Number(model.cost) > 0),
    ]);
    if (!model.pricingConfigured && Number(model.cost) > 0) {
      tr.lastElementChild.title = '部分供应商未配置单价';
    }
    els.usageModelRows.appendChild(tr);
  }
}

function svgNode(tag, attributes = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) {
    node.setAttribute(name, String(value));
  }
  return node;
}

function niceMax(value, integer = false) {
  let rough = value / 4;
  if (integer) rough = Math.max(1, Math.ceil(rough));
  const power = 10 ** Math.floor(Math.log10(rough));
  const fraction = rough / power;
  const step = (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * power;
  return step * 4;
}

function renderChart(data) {
  if (!Array.isArray(data.daily)) {
    const missing = document.createElement('div');
    missing.className = 'usage-chart-missing';
    missing.textContent = '趋势数据不可用，请刷新页面或重启服务。';
    els.usageChart.replaceChildren(missing);
    els.usageChartTotal.textContent = '趋势数据不可用';
    return;
  }
  const metric = METRICS[activeMetric];
  const daily = data.daily;
  const values = daily.map(metric.value);
  const total = values.reduce((sum, value) => sum + value, 0);
  const width = Math.max(320, Math.round(els.usageChart.clientWidth || 900));
  lastChartWidth = width;
  const height = 250;
  const pad = { left: 54, right: 18, top: 12, bottom: 34 };
  const innerWidth = width - pad.left - pad.right;
  const innerHeight = height - pad.top - pad.bottom;
  const max = Math.max(0, ...values);
  const axisMax =
    max > 0 ? niceMax(max, activeMetric !== 'cost') : activeMetric === 'cost' ? 0.0004 : 4;
  const bottom = pad.top + innerHeight;
  const xAt = (index) =>
    daily.length <= 1
      ? pad.left + innerWidth / 2
      : pad.left + (innerWidth * index) / (daily.length - 1);
  const yAt = (value) => pad.top + innerHeight - (value / axisMax) * innerHeight;

  const chart = svgNode('svg', {
    viewBox: `0 0 ${width} ${height}`,
    role: 'img',
    'aria-label': '近 7 天使用趋势',
  });

  for (let tick = 0; tick <= 4; tick += 1) {
    const value = (axisMax * tick) / 4;
    const y = yAt(value);
    chart.appendChild(
      svgNode('line', {
        x1: pad.left,
        x2: width - pad.right,
        y1: y,
        y2: y,
        class: tick === 0 ? 'u-axis' : 'u-grid',
      }),
    );
    const label = svgNode('text', {
      x: pad.left - 10,
      y: y + 3,
      'text-anchor': 'end',
    });
    label.textContent = metric.axis(value);
    chart.appendChild(label);
  }

  if (daily.length) {
    const points = values.map((value, index) => [xAt(index), yAt(value)]);
    if (max > 0) {
      const area = [
        `M ${points[0][0]} ${bottom}`,
        ...points.map(([x, y]) => `L ${x} ${y}`),
        `L ${points.at(-1)[0]} ${bottom}`,
        'Z',
      ].join(' ');
      chart.appendChild(svgNode('path', { d: area, class: 'u-area' }));
      chart.appendChild(
        svgNode('path', {
          d: points.map(([x, y], index) => `${index ? 'L' : 'M'} ${x} ${y}`).join(' '),
          class: 'u-line',
        }),
      );
    } else {
      chart.appendChild(
        svgNode('path', {
          d: `M ${points[0][0]} ${bottom} L ${points.at(-1)[0]} ${bottom}`,
          class: 'u-line',
        }),
      );
      const empty = svgNode('text', {
        x: pad.left + innerWidth / 2,
        y: pad.top + innerHeight / 2,
        class: 'u-empty',
      });
      empty.textContent = '暂无用量';
      chart.appendChild(empty);
    }

    for (let index = 0; index < daily.length; index += 1) {
      const [x, y] = points[index];
      if (max > 0) {
        const dot = svgNode('circle', { cx: x, cy: y, r: 3, class: 'u-dot' });
        const title = svgNode('title');
        title.textContent = `${daily[index].date} · ${metric.summary(values[index], data)}`;
        dot.appendChild(title);
        chart.appendChild(dot);
      }
      const label = svgNode('text', {
        x,
        y: height - 10,
        'text-anchor': 'middle',
      });
      const date = new Date(`${daily[index].date}T00:00:00`);
      label.textContent = `${date.getMonth() + 1}/${date.getDate()}`;
      chart.appendChild(label);
    }
  }

  els.usageChart.replaceChildren(chart);
  els.usageChartTotal.textContent = `近 7 天 · ${metric.summary(total, data)}`;
}

export function setUsageMetric(metricName) {
  if (!METRICS[metricName]) return;
  activeMetric = metricName;
  for (const button of els.usageMetrics) {
    const active = button.dataset.usageMetric === metricName;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  if (usageData) renderChart(usageData);
}

export function setUsageTab(tabName) {
  const panels = {
    sessions: els.usageSessionsPanel,
    providers: els.usageProvidersPanel,
    models: els.usageModelsPanel,
    pricing: els.usagePricingPanel,
  };
  if (!panels[tabName]) return;
  activeTab = tabName;
  for (const button of els.usageTabs) {
    const active = button.dataset.usageTab === tabName;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  }
  for (const [name, panel] of Object.entries(panels)) {
    panel.hidden = name !== tabName;
  }
}

export async function openUsage() {
  els.usageModal.hidden = false;
  els.usageTokens.textContent = '…';
  els.usageCacheRate.textContent = '…';
  els.usageRequests.textContent = '…';
  els.usageImages.textContent = '…';
  els.usageCost.textContent = '…';
  els.usageRows.replaceChildren();
  els.usageEmpty.hidden = true;
  els.usageProviderRows.replaceChildren();
  els.usageProvidersEmpty.hidden = true;
  els.usageModelRows.replaceChildren();
  els.usageModelsEmpty.hidden = true;
  els.usageChart.replaceChildren();
  els.usageChartTotal.textContent = '近 7 天';
  els.usageEstimateNote.hidden = true;
  try {
    const query = state.sessionId ? `?sessionId=${encodeURIComponent(state.sessionId)}` : '';
    const data = await api(`/api/usage${query}`);
    if (state.config && data.pricing) state.config.pricing = data.pricing;
    usageData = data;
    observeChartWidth();
    renderSummary(data);
    renderPricing(data);
    renderSessions(data);
    renderProviderStats(data);
    renderModelStats(data);
    setUsageTab(activeTab);
    setUsageMetric(activeMetric);
  } catch (error) {
    toast(error.message);
    usageData = null;
    els.usageCost.textContent = '加载失败';
    els.usageChart.replaceChildren();
  }
}

export function closeUsage() {
  els.usageModal.hidden = true;
}

export async function saveUsagePricing() {
  const modelPricing = Object.create(null);
  for (const card of els.usagePricingList.querySelectorAll(
    '.usage-provider-price:not(.historical)[data-provider-id][data-model]',
  )) {
    const pricing = {};
    for (const input of card.querySelectorAll('input[data-price]')) {
      pricing[input.dataset.price] = Math.max(0, Number(input.value) || 0);
    }
    const providerId = card.dataset.providerId;
    modelPricing[providerId] ||= Object.create(null);
    modelPricing[providerId][card.dataset.model] = pricing;
  }
  const button = els.saveUsagePricing;
  const label = button.textContent;
  button.disabled = true;
  button.textContent = '保存中…';
  try {
    state.config = await api('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelPricing }),
    });
    toast('单价已保存');
    await openUsage();
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

async function selectSession(id) {
  closeUsage();
  await openSession(id);
}
