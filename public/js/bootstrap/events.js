import {
  autoGrow,
  els,
  state,
  toggleTheme,
  updateSendButton,
} from '../core/index.js';
import { send } from '../features/chat.js';
import {
  logout,
  setAuthMode,
  submitAuth,
} from '../features/auth.js';
import { newChatView } from '../features/sessions.js';
import {
  backToChat,
  closeFolderModal,
  closeTagModal,
  openFolderModal,
  openGallery,
  renderGallery,
  submitFolder,
  submitTags,
} from '../features/gallery.js';
import { handlePaste, uploadFiles } from '../features/reference.js';
import {
  clearModelResult,
  closeSettings,
  fetchModels,
  openSettings,
  saveSettings,
  testConnection,
} from '../features/settings.js';
import { closeParams, renderParams, resetParams, toggleParams } from '../features/params.js';
import {
  closeTemplates,
  handleSkillFileChange,
  openTemplates,
  submitTemplate,
  triggerSkillImport,
} from '../features/templates.js';
import { clearActiveSkill } from '../features/skills.js';
import { closeCompare } from '../features/compare.js';
import {
  closeLightbox,
  closePromptModal,
  closeSidebar,
  copyActivePrompt,
  openSidebar,
} from '../features/overlays.js';

export function bindEvents() {
  els.input.addEventListener('input', () => {
    autoGrow();
    updateSendButton();
  });

  els.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      send();
    }
  });

  els.sendBtn.addEventListener('click', send);
  els.newChat.addEventListener('click', newChatView);
  els.attachBtn.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', () => uploadFiles(els.fileInput.files));
  document.addEventListener('paste', handlePaste);
  els.templateBtn.addEventListener('click', openTemplates);
  els.activeSkillChip.addEventListener('click', clearActiveSkill);
  els.importSkillBtn.addEventListener('click', triggerSkillImport);
  els.skillFileInput.addEventListener('change', handleSkillFileChange);
  els.paramsBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleParams();
  });

  els.settingsBtn.addEventListener('click', openSettings);
  els.themeBtn.addEventListener('click', toggleTheme);
  els.themeBtnAuth.addEventListener('click', toggleTheme);
  els.closeSettings.addEventListener('click', closeSettings);
  els.cancelSettings.addEventListener('click', closeSettings);
  els.saveSettings.addEventListener('click', saveSettings);

  els.llmModelFetch.addEventListener('click', () => fetchModels('llm'));
  els.imageModelFetch.addEventListener('click', () => fetchModels('image'));
  els.llmTest.addEventListener('click', () => testConnection('llm'));
  els.imageTest.addEventListener('click', () => testConnection('image'));

  for (const target of ['llm', 'image']) {
    const select = target === 'llm' ? els.llmModelSelect : els.imageModelSelect;
    const input = target === 'llm' ? els.llmModel : els.imageModel;
    select.addEventListener('change', () => {
      if (select.value === '__custom__') {
        select.hidden = true;
        input.hidden = false;
        input.focus();
        return;
      }
      input.value = select.value;
    });

    const baseInput = target === 'llm' ? els.llmBase : els.imageBase;
    const keyInput = target === 'llm' ? els.llmKey : els.imageKey;
    for (const node of [baseInput, keyInput, input]) {
      node.addEventListener('input', () => clearModelResult(target));
    }
  }

  els.authForm.addEventListener('submit', submitAuth);
  els.authTabs.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-mode]');
    if (tab) setAuthMode(tab.dataset.mode);
  });
  els.logoutBtn.addEventListener('click', logout);

  els.menuBtn.addEventListener('click', openSidebar);
  els.sidebarScrim.addEventListener('click', closeSidebar);

  els.galleryNav.addEventListener('click', openGallery);
  els.galleryBack.addEventListener('click', backToChat);
  els.galleryStart.addEventListener('click', newChatView);
  els.gallerySearch.addEventListener('input', () => {
    state.gallery.query = els.gallerySearch.value;
    renderGallery();
  });
  els.galleryFavFilter.addEventListener('click', () => {
    state.gallery.favoriteOnly = !state.gallery.favoriteOnly;
    renderGallery();
  });
  els.newFolderBtn.addEventListener('click', openFolderModal);
  els.closeFolderModal.addEventListener('click', closeFolderModal);
  els.cancelFolder.addEventListener('click', closeFolderModal);
  els.createFolder.addEventListener('click', submitFolder);
  els.folderName.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submitFolder();
    }
  });
  els.folderModal.addEventListener('click', (event) => {
    if (event.target === els.folderModal) closeFolderModal();
  });

  for (const chip of els.aspectChips.querySelectorAll('[data-aspect]')) {
    chip.addEventListener('click', () => {
      state.options.aspectRatio = chip.dataset.aspect || null;
      renderParams();
    });
  }
  for (const chip of els.countChips.querySelectorAll('[data-count]')) {
    chip.addEventListener('click', () => {
      state.options.count = Number(chip.dataset.count);
      renderParams();
    });
  }
  for (const chip of els.qualityChips.querySelectorAll('[data-quality]')) {
    chip.addEventListener('click', () => {
      state.options.quality = chip.dataset.quality || null;
      renderParams();
    });
  }
  els.resetParams.addEventListener('click', resetParams);

  els.closeTemplateModal.addEventListener('click', closeTemplates);
  els.cancelTemplate.addEventListener('click', closeTemplates);
  els.createTemplate.addEventListener('click', submitTemplate);
  els.templateModal.addEventListener('click', (event) => {
    if (event.target === els.templateModal) closeTemplates();
  });

  els.closeTagModal.addEventListener('click', closeTagModal);
  els.cancelTag.addEventListener('click', closeTagModal);
  els.saveTag.addEventListener('click', submitTags);
  els.tagInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submitTags();
    }
  });
  els.tagModal.addEventListener('click', (event) => {
    if (event.target === els.tagModal) closeTagModal();
  });

  els.closeCompare.addEventListener('click', closeCompare);
  els.cancelCompare.addEventListener('click', closeCompare);
  els.compareModal.addEventListener('click', (event) => {
    if (event.target === els.compareModal) closeCompare();
  });
  els.closePromptModal.addEventListener('click', closePromptModal);
  els.cancelPromptModal.addEventListener('click', closePromptModal);
  els.copyPromptModal.addEventListener('click', copyActivePrompt);
  els.promptModal.addEventListener('click', (event) => {
    if (event.target === els.promptModal) closePromptModal();
  });

  els.lightbox.addEventListener('click', closeLightbox);

  document.addEventListener('click', (event) => {
    if (els.paramPanel.hidden) return;
    if (els.paramPanel.contains(event.target) || els.paramsBtn.contains(event.target)) return;
    closeParams();
  });

  els.settingsModal.addEventListener('click', (event) => {
    if (event.target === els.settingsModal) closeSettings();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!els.lightbox.hidden) closeLightbox();
    else if (!els.settingsModal.hidden) closeSettings();
    else if (!els.folderModal.hidden) closeFolderModal();
    else if (!els.templateModal.hidden) closeTemplates();
    else if (!els.tagModal.hidden) closeTagModal();
    else if (!els.promptModal.hidden) closePromptModal();
    else if (!els.compareModal.hidden) closeCompare();
    else if (!els.paramPanel.hidden) closeParams();
    else closeSidebar();
  });
}
