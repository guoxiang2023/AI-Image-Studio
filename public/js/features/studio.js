import { api, el, els, toast } from '../core/index.js';

let references = [];
let loaded = false;
let loading = null;
let selected = null;
let resultImages = [];
let generating = false;

function setStatus(text, kind = '') {
  els.studioResultStatus.textContent = text;
  els.studioResultStatus.classList.toggle('err', kind === 'err');
  els.studioResultStatus.classList.toggle('ok', kind === 'ok');
}

function setLoading(on) {
  els.studioResultLoading.hidden = !on;
  if (on) {
    els.studioResultEmpty.hidden = true;
    els.studioResultImage.hidden = true;
    els.studioResultGrid.hidden = true;
  }
}

function markSelectedCard() {
  for (const card of els.studioReferenceGrid.querySelectorAll('.studio-reference-card')) {
    card.classList.toggle('active', card.dataset.styleId === selected?.styleId);
    card.setAttribute('aria-pressed', String(card.dataset.styleId === selected?.styleId));
  }
}

function renderSelected() {
  const hasReference = Boolean(selected);
  els.studioSelected.hidden = !hasReference;
  els.studioClearReference.hidden = !hasReference;
  if (!hasReference) {
    els.studioReferencePreview.removeAttribute('src');
    els.studioReferenceName.textContent = '—';
    els.studioReferenceMeta.textContent = '—';
    return;
  }
  els.studioReferencePreview.src = selected.imageUrl;
  els.studioReferenceName.textContent = selected.name;
  els.studioReferenceMeta.textContent = selected.meta;
  markSelectedCard();
}

function selectStyle(reference) {
  selected = {
    styleId: reference.id,
    imageUrl: reference.imageUrl,
    name: reference.name,
    meta: `${reference.category} · ${reference.ratio}`,
    kind: reference.category,
  };
  els.studioAspect.value = '';
  renderSelected();
}

function selectUploaded(data, fileName) {
  els.studioAspect.value = '';
  selected = {
    referenceImageId: data.imageId,
    imageUrl: data.url,
    name: fileName || '上传参考图',
    meta: '本地上传 · 版式参考',
    kind: 'marketing',
  };
  renderSelected();
}

function renderReferences() {
  els.studioReferenceGrid.innerHTML = '';
  if (!references.length) {
    els.studioReferenceEmpty.hidden = false;
    els.studioReferenceEmpty.textContent = '暂无参考风格，可以上传自己的参考图';
    return;
  }
  els.studioReferenceEmpty.hidden = true;
  for (const reference of references) {
    const card = el('button', 'studio-reference-card');
    card.type = 'button';
    card.dataset.styleId = reference.id;
    card.title = `${reference.name} · ${reference.use}`;
    const img = document.createElement('img');
    img.src = reference.thumbUrl;
    img.alt = reference.name;
    img.loading = 'lazy';
    card.appendChild(img);
    const caption = el('span', 'studio-reference-caption');
    caption.appendChild(el('strong', '', reference.name));
    caption.appendChild(el('small', '', reference.ratio));
    card.appendChild(caption);
    card.addEventListener('click', () => selectStyle(reference));
    els.studioReferenceGrid.appendChild(card);
  }
  if (!selected) selectStyle(references[0]);
  else markSelectedCard();
}

async function ensureReferences() {
  if (loaded) return;
  if (loading) return loading;
  els.studioReferenceEmpty.hidden = false;
  els.studioReferenceEmpty.textContent = '参考图库加载中…';
  loading = api('/api/studio/references')
    .then((data) => {
      references = data.references || [];
      loaded = true;
      renderReferences();
    })
    .catch((error) => {
      els.studioReferenceEmpty.hidden = false;
      els.studioReferenceEmpty.textContent = error.message;
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

function showResult(index = 0) {
  const image = resultImages[index];
  if (!image) return;
  els.studioResultEmpty.hidden = true;
  els.studioResultImage.hidden = false;
  els.studioResultImage.src = image.url;
  els.studioResultSize.textContent = image.size || '—';
  els.studioDownload.hidden = false;
  els.studioDownload.href = image.url;
  els.studioDownload.download = `ai-material-${image.image_id || index + 1}.png`;
  for (const card of els.studioResultGrid.querySelectorAll('.studio-result-thumb')) {
    card.classList.toggle('active', Number(card.dataset.index) === index);
  }
}

function renderResults(images) {
  resultImages = images || [];
  if (!resultImages.length) {
    els.studioResultEmpty.hidden = false;
    els.studioResultEmpty.textContent = '没有返回图片，请重试';
    els.studioResultImage.hidden = true;
    els.studioResultGrid.hidden = true;
    els.studioDownload.hidden = true;
    return;
  }
  els.studioResultGrid.innerHTML = '';
  if (resultImages.length > 1) {
    els.studioResultGrid.hidden = false;
    resultImages.forEach((image, index) => {
      const card = el('button', 'studio-result-thumb');
      card.type = 'button';
      card.dataset.index = String(index);
      const img = document.createElement('img');
      img.src = image.url;
      img.alt = `生成结果 ${index + 1}`;
      card.appendChild(img);
      card.addEventListener('click', () => showResult(index));
      els.studioResultGrid.appendChild(card);
    });
  } else {
    els.studioResultGrid.hidden = true;
  }
  showResult(0);
}

async function uploadReference(file) {
  if (!file) return;
  if (file.size > 25 * 1024 * 1024) {
    toast('图片不能超过 25MB');
    return;
  }
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    toast('只支持 PNG / JPEG / WebP');
    return;
  }
  try {
    const res = await fetch('/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': file.type },
      body: file,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '上传失败');
    selectUploaded(data, file.name);
    setStatus('参考图已上传；填写内容后即可生成', 'ok');
  } catch (error) {
    toast(error.message);
  } finally {
    els.studioReferenceInput.value = '';
  }
}

async function generate() {
  if (generating) return;
  if (!selected) {
    toast('请先选择一张参考图');
    return;
  }
  const title = els.studioTitle.value.trim();
  if (!title) {
    toast('请填写主标题');
    els.studioTitle.focus();
    return;
  }
  generating = true;
  els.studioGenerate.disabled = true;
  const label = els.studioGenerate.textContent;
  els.studioGenerate.textContent = '生成中…';
  setStatus('AI 正在参考版式重绘，通常需要 20–60 秒…');
  setLoading(true);
  try {
    const data = await api('/api/studio/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(selected.styleId ? { styleId: selected.styleId } : {}),
        ...(selected.referenceImageId ? { referenceImageId: selected.referenceImageId } : {}),
        mode: els.studioMode.value,
        kind: selected.kind || 'marketing',
        aspectRatio: els.studioAspect.value,
        count: Number(els.studioCount.value) || 1,
        content: {
          title,
          subtitle: els.studioSubtitle.value,
          subject: els.studioSubject.value,
          points: els.studioPoints.value,
          cta: els.studioCta.value,
          legal: els.studioLegal.value,
        },
        extra: els.studioExtra.value,
        qrUrl: els.studioQrUrl.value.trim(),
      }),
    });
    renderResults(data.images);
    setStatus(
      `已生成 ${data.images.length} 张，保存到「我的画册」`,
      'ok',
    );
  } catch (error) {
    setStatus(error.message, 'err');
    els.studioResultEmpty.hidden = false;
    els.studioResultEmpty.textContent = error.message;
    toast(error.message);
  } finally {
    generating = false;
    els.studioGenerate.disabled = false;
    els.studioGenerate.textContent = label;
    setLoading(false);
  }
}

export function openStudioModal() {
  els.studioModal.hidden = false;
  void ensureReferences();
}

export function closeStudioModal() {
  els.studioModal.hidden = true;
}

export function resetStudio() {
  closeStudioModal();
  references = [];
  loaded = false;
  loading = null;
  selected = null;
  resultImages = [];
  generating = false;
  els.studioReferenceGrid.innerHTML = '';
  els.studioResultGrid.innerHTML = '';
  els.studioResultGrid.hidden = true;
  els.studioResultImage.removeAttribute('src');
  els.studioResultImage.hidden = true;
  els.studioResultEmpty.hidden = false;
  els.studioResultEmpty.textContent = '选择参考风格并填写主标题，然后生成';
  els.studioResultLoading.hidden = true;
  els.studioResultStatus.textContent = '';
  els.studioDownload.hidden = true;
  els.studioSelected.hidden = true;
  els.studioClearReference.hidden = true;
}

export function bindStudioEvents() {
  els.studioBtn.addEventListener('click', openStudioModal);
  els.studioNav.addEventListener('click', openStudioModal);
  els.closeStudioModal.addEventListener('click', closeStudioModal);
  els.studioUploadRef.addEventListener('click', () => els.studioReferenceInput.click());
  els.studioReferenceInput.addEventListener('change', () => {
    void uploadReference(els.studioReferenceInput.files?.[0]);
  });
  els.studioClearReference.addEventListener('click', () => {
    selected = null;
    renderSelected();
    setStatus('');
  });
  els.studioGenerate.addEventListener('click', () => void generate());
}
