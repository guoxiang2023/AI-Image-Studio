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
import {
  compactSession,
  newChatView,
  restoreSession,
  toggleSessionFilter,
} from '../features/sessions.js';
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
  activateProvider,
  addProvider,
  clearModelResult,
  closeProviderMenu,
  closeSettings,
  deleteProvider,
  fetchModels,
  openSettings,
  saveSettings,
  selectProvider,
  testConnection,
  toggleKeyVisibility,
  toggleProviderMenu,
} from '../features/settings.js';
import {
  closeUsage,
  openUsage,
  saveUsagePricing,
  setUsageMetric,
  setUsageTab,
} from '../features/usage.js';
import { closeParams, renderParams, resetParams, toggleParams } from '../features/params.js';
import {
  clearActiveQr,
  clearPresetSelection,
  clearTemplateSelection,
  closeTemplates,
  openTemplates,
  selectTemplateAspect,
  submitTemplate,
} from '../features/templates.js';
import { closeCompare } from '../features/compare.js';
import { bindStudioEvents } from '../features/studio.js';
import {
  checkForUpdates,
  closeUpdateModal,
  openUpdateModal,
  startDesktopUpdate,
} from '../features/updates.js';
import {
  closeLightbox,
  closePromptModal,
  closeSidebar,
  copyActivePrompt,
  openSidebar,
  stepLightbox,
} from '../features/overlays.js';

export function bindEvents() {
  bindStudioEvents();

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
  els.archiveToggle.addEventListener('click', toggleSessionFilter);
  els.compactBtn.addEventListener('click', compactSession);
  els.restoreArchived.addEventListener('click', () => {
    if (state.sessionId) restoreSession(state.sessionId);
  });
  els.attachBtn.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', () => uploadFiles(els.fileInput.files));
  document.addEventListener('paste', handlePaste);
  els.templateBtn.addEventListener('click', openTemplates);
  els.qrChip.addEventListener('click', clearActiveQr);
  els.paramsBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleParams();
  });

  els.settingsBtn.addEventListener('click', openSettings);
  els.modelPill.addEventListener('click', toggleProviderMenu);
  els.providerMenu.addEventListener('click', (event) => event.stopPropagation());
  els.usageBtn.addEventListener('click', openUsage);
  els.themeBtn.addEventListener('click', toggleTheme);
  els.themeBtnAuth.addEventListener('click', toggleTheme);
  els.closeSettings.addEventListener('click', closeSettings);
  els.saveSettings.addEventListener('click', saveSettings);
  els.closeUsage.addEventListener('click', closeUsage);
  els.usageRefresh.addEventListener('click', openUsage);
  els.saveUsagePricing.addEventListener('click', saveUsagePricing);
  els.usageModal.addEventListener('click', (event) => {
    if (event.target === els.usageModal) closeUsage();
  });
  for (const tab of els.usageTabs) {
    tab.addEventListener('click', () => setUsageTab(tab.dataset.usageTab));
  }
  for (const metric of els.usageMetrics) {
    metric.addEventListener('click', () => setUsageMetric(metric.dataset.usageMetric));
  }

  els.llmKeyToggle.addEventListener('click', () => toggleKeyVisibility('llm'));
  els.imageKeyToggle.addEventListener('click', () => toggleKeyVisibility('image'));
  els.llmModelFetch.addEventListener('click', () => fetchModels('llm'));
  els.imageModelFetch.addEventListener('click', () => fetchModels('image'));
  els.llmTest.addEventListener('click', () => testConnection('llm'));
  els.imageTest.addEventListener('click', () => testConnection('image'));
  els.llmProtocol.addEventListener('change', () => clearModelResult('llm'));
  els.llmProviderSelect.addEventListener('change', () =>
    selectProvider('llm', els.llmProviderSelect.value),
  );
  els.llmProviderAdd.addEventListener('click', () => addProvider('llm'));
  els.llmProviderDelete.addEventListener('click', () => deleteProvider('llm'));
  els.llmProviderActive.addEventListener('click', () => activateProvider('llm'));
  els.imageProviderSelect.addEventListener('change', () =>
    selectProvider('image', els.imageProviderSelect.value),
  );
  els.imageProviderAdd.addEventListener('click', () => addProvider('image'));
  els.imageProviderDelete.addEventListener('click', () => deleteProvider('image'));
  els.imageProviderActive.addEventListener('click', () => activateProvider('image'));

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
  els.clearTemplateSelection.addEventListener('click', clearTemplateSelection);
  els.clearPresetSelection.addEventListener('click', clearPresetSelection);
  els.createTemplate.addEventListener('click', submitTemplate);
  els.templateAspectChips.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-aspect]');
    if (chip) selectTemplateAspect(chip.dataset.aspect || '');
  });
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

  els.versionBtn.addEventListener('click', openUpdateModal);
  els.closeUpdate.addEventListener('click', closeUpdateModal);
  els.cancelUpdate.addEventListener('click', closeUpdateModal);
  els.recheckUpdate.addEventListener('click', () =>
    checkForUpdates({ force: true, showModal: true, notify: true }),
  );
  els.updateInstall.addEventListener('click', startDesktopUpdate);
  els.updateModal.addEventListener('click', (event) => {
    if (event.target === els.updateModal) closeUpdateModal();
  });

  let lightboxSwipe = null;
  let suppressLightboxClick = false;
  els.lightbox.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' || lightboxSwipe) return;
    if (event.target.closest('.lightbox-nav')) return;
    lightboxSwipe = { id: event.pointerId, x: event.clientX, y: event.clientY };
  });
  els.lightbox.addEventListener('pointerup', (event) => {
    if (!lightboxSwipe || event.pointerId !== lightboxSwipe.id) return;
    const dx = event.clientX - lightboxSwipe.x;
    const dy = event.clientY - lightboxSwipe.y;
    lightboxSwipe = null;
    if (Math.abs(dx) < 48 || Math.abs(dx) <= Math.abs(dy) * 1.2) return;
    suppressLightboxClick = true;
    setTimeout(() => {
      suppressLightboxClick = false;
    }, 350);
    stepLightbox(dx < 0 ? 1 : -1);
  });
  els.lightbox.addEventListener('pointercancel', () => {
    lightboxSwipe = null;
  });
  els.lightbox.addEventListener('click', (event) => {
    if (suppressLightboxClick) {
      suppressLightboxClick = false;
      return;
    }
    if (event.target === els.lightbox || event.target === els.lightboxImg) closeLightbox();
  });
  els.lightboxPrev.addEventListener('click', (event) => {
    event.stopPropagation();
    stepLightbox(-1);
  });
  els.lightboxNext.addEventListener('click', (event) => {
    event.stopPropagation();
    stepLightbox(1);
  });

  document.addEventListener('click', (event) => {
    if (!els.providerMenu.hidden) {
      if (!els.providerMenu.contains(event.target) && !els.modelPill.contains(event.target)) {
        closeProviderMenu();
      }
    }
    if (els.paramPanel.hidden) return;
    if (els.paramPanel.contains(event.target) || els.paramsBtn.contains(event.target)) return;
    closeParams();
  });

  document.addEventListener('keydown', (event) => {
    if (!els.lightbox.hidden && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault();
      stepLightbox(event.key === 'ArrowLeft' ? -1 : 1);
      return;
    }
    if (event.key !== 'Escape') return;
    // The settings dialog is dismissed only by its X button. This prevents a
    // dragged text selection or Escape from discarding unsaved edits.
    if (!els.settingsModal.hidden) return;
    if (!els.usageModal.hidden) closeUsage();
    else if (!els.lightbox.hidden) closeLightbox();
    else if (!els.folderModal.hidden) closeFolderModal();
    else if (!els.studioModal.hidden) return;
    else if (!els.templateModal.hidden) closeTemplates();
    else if (!els.tagModal.hidden) closeTagModal();
    else if (!els.promptModal.hidden) closePromptModal();
    else if (!els.compareModal.hidden) closeCompare();
    else if (!els.updateModal.hidden) closeUpdateModal();
    else if (!els.paramPanel.hidden) closeParams();
    else closeSidebar();
  });
}
