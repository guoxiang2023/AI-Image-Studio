import { api, el, els, icon, showChatView, state, toast } from '../core/index.js';
import { closeSidebar, openLightbox, openPromptModal } from './overlays.js';
import { setPrimaryReference } from './reference.js';
import { newChatView } from './sessions.js';
import { closeParams } from './params.js';

function formatGalleryDate(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

function galleryCounts() {
  const counts = { all: state.gallery.images.length, unfiled: 0 };
  for (const image of state.gallery.images) {
    if (!image.folderId) counts.unfiled += 1;
    else counts[image.folderId] = (counts[image.folderId] || 0) + 1;
  }
  return counts;
}

function setActiveFolder(id) {
  state.gallery.activeFolder = id;
  renderGallery();
}

function makeFolderChip(id, name, count, deletable) {
  const active = state.gallery.activeFolder === id;
  const chip = el('div', `folder-chip${active ? ' active' : ''}`);

  const main = el('button', 'folder-chip-main');
  main.type = 'button';
  main.appendChild(el('span', 'folder-name', name));
  main.appendChild(el('span', 'folder-count', String(count)));
  main.addEventListener('click', () => setActiveFolder(id));
  chip.appendChild(main);

  if (deletable) {
    const del = el('button', 'folder-del', '×');
    del.type = 'button';
    del.title = '删除文件夹';
    del.setAttribute('aria-label', `删除文件夹 ${name}`);
    del.addEventListener('click', (event) => {
      event.stopPropagation();
      deleteFolder(id, name);
    });
    chip.appendChild(del);
  }
  return chip;
}

function createGalleryCard(image, images, index) {
  const card = el('figure', 'gallery-card');
  const thumb = el('div', 'gallery-thumb');

  const img = el('img');
  img.src = image.url;
  img.alt = image.prompt || '生成图片';
  img.loading = 'lazy';
  img.addEventListener('click', () => openLightbox(image.url, { images, index }));
  thumb.appendChild(img);

  const favWrap = el('div', 'gallery-fav-wrap');
  const fav = el('button', `gallery-icon-btn gallery-fav${image.favorite ? ' active' : ''}`);
  fav.type = 'button';
  fav.title = image.favorite ? '取消收藏' : '收藏';
  fav.setAttribute('aria-label', fav.title);
  fav.appendChild(icon('star'));
  fav.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleFavorite(image);
  });
  favWrap.appendChild(fav);
  thumb.appendChild(favWrap);

  const actions = el('div', 'gallery-actions');
  const download = el('a', 'gallery-icon-btn');
  download.href = image.url;
  download.download = `luma-${image.id}.${image.url.split('.').pop() || 'png'}`;
  download.title = '下载';
  download.appendChild(icon('download'));
  actions.appendChild(download);

  const edit = el('button', 'gallery-icon-btn');
  edit.type = 'button';
  edit.title = '继续修改';
  edit.setAttribute('aria-label', '继续修改');
  edit.appendChild(icon('wand'));
  edit.addEventListener('click', (event) => {
    event.stopPropagation();
    continueFromGallery(image);
  });
  actions.appendChild(edit);

  const remove = el('button', 'gallery-icon-btn');
  remove.type = 'button';
  remove.title = '从画册移除';
  remove.setAttribute('aria-label', '从画册移除');
  remove.appendChild(icon('trash'));
  remove.addEventListener('click', (event) => {
    event.stopPropagation();
    hideGalleryImage(image);
  });
  actions.appendChild(remove);
  thumb.appendChild(actions);
  card.appendChild(thumb);

  const meta = el('div', 'gallery-meta');
  if (image.prompt || image.caption) {
    const prompt = el('p', 'gallery-prompt prompt-link', image.caption || image.prompt);
    prompt.title = `${image.prompt || image.caption || ''}\n\n点击查看最终提示词`;
    prompt.addEventListener('click', () => openPromptModal(image.prompt));
    meta.appendChild(prompt);
  }

  if (image.tags?.length) {
    const tags = el('div', 'gallery-tags');
    for (const tag of image.tags) {
      const chip = el('button', 'gallery-tag', `#${tag}`);
      chip.type = 'button';
      chip.title = `筛选标签：${tag}`;
      chip.addEventListener('click', () => {
        state.gallery.query = tag;
        els.gallerySearch.value = tag;
        renderGallery();
      });
      tags.appendChild(chip);
    }
    meta.appendChild(tags);
  }

  const spec = [image.size, image.model].filter(Boolean).join(' · ');
  if (spec) meta.appendChild(el('p', 'gallery-spec', spec));

  const foot = el('div', 'gallery-foot');
  foot.appendChild(el('span', 'gallery-date', formatGalleryDate(image.createdAt)));

  const tagBtn = el('button', 'gallery-tag-btn');
  tagBtn.type = 'button';
  tagBtn.title = '编辑标签';
  tagBtn.setAttribute('aria-label', '编辑标签');
  tagBtn.appendChild(icon('tag'));
  tagBtn.addEventListener('click', () => openTagModal(image));
  foot.appendChild(tagBtn);

  const select = el('select', 'folder-select');
  select.setAttribute('aria-label', '移动到文件夹');
  const unfiled = document.createElement('option');
  unfiled.value = '';
  unfiled.textContent = '未分类';
  select.appendChild(unfiled);
  for (const folder of state.gallery.folders) {
    const option = document.createElement('option');
    option.value = folder.id;
    option.textContent = folder.name;
    select.appendChild(option);
  }
  select.value = image.folderId || '';
  select.addEventListener('change', () => moveGalleryImage(image, select.value || null));
  foot.appendChild(select);
  meta.appendChild(foot);
  card.appendChild(meta);
  return card;
}

export function renderGallery() {
  const gallery = state.gallery;
  const counts = galleryCounts();
  els.galleryFavFilter.classList.toggle('active', gallery.favoriteOnly);

  els.folderBar.innerHTML = '';
  els.folderBar.appendChild(makeFolderChip('all', '全部', counts.all, false));
  els.folderBar.appendChild(makeFolderChip('unfiled', '未分类', counts.unfiled, false));
  for (const folder of gallery.folders) {
    els.folderBar.appendChild(
      makeFolderChip(folder.id, folder.name, counts[folder.id] || 0, true),
    );
  }

  let images = gallery.images;
  if (gallery.activeFolder === 'unfiled') {
    images = images.filter((image) => !image.folderId);
  } else if (gallery.activeFolder !== 'all') {
    images = images.filter((image) => image.folderId === gallery.activeFolder);
  }
  const query = gallery.query.trim().toLowerCase();
  if (query) {
    images = images.filter(
      (image) =>
        String(image.prompt || '').toLowerCase().includes(query) ||
        String(image.caption || '').toLowerCase().includes(query) ||
        (image.tags || []).some((tag) => String(tag).toLowerCase().includes(query)),
    );
  }
  if (gallery.favoriteOnly) images = images.filter((image) => image.favorite);

  els.galleryTotal.textContent = gallery.images.length
    ? query || gallery.favoriteOnly
      ? `筛选 ${images.length} / ${gallery.images.length} 张`
      : `共 ${gallery.images.length} 张`
    : '';
  els.galleryLive.hidden = !state.streaming;

  els.galleryGrid.innerHTML = '';
  images.forEach((image, index) => {
    els.galleryGrid.appendChild(createGalleryCard(image, images, index));
  });

  const empty = images.length === 0;
  els.galleryEmpty.hidden = !empty;
  els.galleryGrid.hidden = empty;

  if (empty) {
    const active = gallery.activeFolder;
    if (state.streaming) {
      els.galleryEmptyTitle.textContent = '正在生成…';
      els.galleryEmptyText.textContent = '任务完成后，新图片会自动出现在这里。';
    } else if (query) {
      els.galleryEmptyTitle.textContent = '没有匹配的图片';
      els.galleryEmptyText.textContent = '换一个提示词关键词或标签试试。';
    } else if (gallery.favoriteOnly) {
      els.galleryEmptyTitle.textContent = '还没有收藏';
      els.galleryEmptyText.textContent = '点图片左上角的星标，把常用素材收进来。';
    } else if (active === 'all') {
      els.galleryEmptyTitle.textContent = '画册还是空的';
      els.galleryEmptyText.textContent = '去对话里生成第一张图片，它会自动出现在这里。';
    } else if (active === 'unfiled') {
      els.galleryEmptyTitle.textContent = '没有未分类的图片';
      els.galleryEmptyText.textContent = '从文件夹里的图片下方选择「未分类」即可移回来。';
    } else {
      const folder = gallery.folders.find((entry) => entry.id === active);
      els.galleryEmptyTitle.textContent = folder ? `「${folder.name}」还没有图片` : '这个文件夹还没有图片';
      els.galleryEmptyText.textContent = '在图片下方选择这个文件夹即可归类。';
    }
  }
}

function continueFromGallery(image) {
  if (state.streaming) {
    toast('请先等待当前生成完成');
    return;
  }
  if (state.view === 'gallery') {
    if (state.sessionId) backToChat();
    else newChatView();
  }
  setPrimaryReference({ id: image.id, url: image.url, role: '参考' });
  els.input.focus();
  toast('已加入参考图，描述要怎么改');
}

async function toggleFavorite(image) {
  const next = !image.favorite;
  try {
    await api(`/api/gallery/images/${image.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ favorite: next }),
    });
    image.favorite = next;
    renderGallery();
  } catch (error) {
    toast(error.message);
  }
}

function openTagModal(image) {
  state.tagImage = image;
  els.tagInput.value = (image.tags || []).join('，');
  els.tagModal.hidden = false;
  els.tagInput.focus();
}

export function closeTagModal() {
  state.tagImage = null;
  els.tagModal.hidden = true;
}

async function submitTags() {
  const image = state.tagImage;
  if (!image) return;
  const tags = els.tagInput.value
    .split(/[,，]/)
    .map((tag) => tag.trim())
    .filter(Boolean);
  try {
    await api(`/api/gallery/images/${image.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags }),
    });
    image.tags = tags.slice(0, 8);
    closeTagModal();
    renderGallery();
    toast('标签已保存');
  } catch (error) {
    toast(error.message);
  }
}

async function hideGalleryImage(image) {
  if (!confirm('从画册移除这张图片？对话里的记录不会删除。')) return;
  try {
    await api(`/api/gallery/images/${image.id}`, { method: 'DELETE' });
    state.gallery.images = state.gallery.images.filter((item) => item.id !== image.id);
    renderGallery();
    toast('已从画册移除');
  } catch (error) {
    toast(error.message);
  }
}

export async function refreshGallery() {
  try {
    const data = await api('/api/gallery');
    state.gallery.images = data.images || [];
    state.gallery.folders = data.folders || [];
    if (
      state.gallery.activeFolder !== 'all' &&
      state.gallery.activeFolder !== 'unfiled' &&
      !state.gallery.folders.some((folder) => folder.id === state.gallery.activeFolder)
    ) {
      state.gallery.activeFolder = 'all';
    }
    renderGallery();
  } catch (error) {
    toast(error.message);
  }
}

async function moveGalleryImage(image, folderId) {
  try {
    await api(`/api/gallery/images/${image.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderId }),
    });
    image.folderId = folderId;
    renderGallery();
    toast(folderId ? '已移动' : '已移到未分类');
  } catch (error) {
    toast(error.message);
    renderGallery();
  }
}

async function deleteFolder(id, name) {
  if (!confirm(`删除文件夹「${name}」？其中的图片会移到「未分类」。`)) return;
  try {
    await api(`/api/gallery/folders/${id}`, { method: 'DELETE' });
    if (state.gallery.activeFolder === id) state.gallery.activeFolder = 'all';
    await refreshGallery();
    toast('文件夹已删除');
  } catch (error) {
    toast(error.message);
  }
}

export function openFolderModal() {
  els.folderName.value = '';
  els.folderError.hidden = true;
  els.folderError.textContent = '';
  els.folderModal.hidden = false;
  els.folderName.focus();
}

export function closeFolderModal() {
  els.folderModal.hidden = true;
}

async function submitFolder() {
  const name = els.folderName.value.trim();
  if (!name) {
    els.folderError.textContent = '请输入文件夹名称';
    els.folderError.hidden = false;
    return;
  }
  els.folderError.hidden = true;
  try {
    const res = await api('/api/gallery/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    state.gallery.folders.push(res.folder);
    state.gallery.activeFolder = res.folder.id;
    closeFolderModal();
    renderGallery();
    toast('文件夹已创建');
  } catch (error) {
    els.folderError.textContent = error.message;
    els.folderError.hidden = false;
  }
}

export async function openGallery() {
  state.view = 'gallery';
  els.chatScroll.hidden = true;
  els.composerWrap.hidden = true;
  els.galleryView.hidden = false;
  els.topbarLabel.textContent = 'GALLERY';
  els.chatTitle.textContent = '我的画册';
  els.galleryNav.classList.add('active');
  els.galleryLive.hidden = !state.streaming;
  els.gallerySearch.value = state.gallery.query;
  closeParams();
  closeSidebar();
  await refreshGallery();
}

export function backToChat() {
  showChatView();
  if (state.sessionId || state.streaming) els.input.focus();
  else newChatView();
}

export { submitFolder, submitTags };
