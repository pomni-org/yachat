(() => {
  const MB = 1024 * 1024;
  const GB = 1024 * MB;
  const PHOTO_SOFT_LIMIT = 20 * GB;
  const PHOTO_INLINE_TARGET = 900 * 1024;
  const MAX_PENDING_ATTACHMENTS = 8;

  const iconOverrides = {
    "message-circle-more": '<path d="M5 4h14a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H9l-5 3v-4.1A3 3 0 0 1 2 14V7a3 3 0 0 1 3-3Z" /><path d="M8 11h.01" /><path d="M12 11h.01" /><path d="M16 11h.01" />',
    "users-round": '<path d="M16 21v-1.6a4.4 4.4 0 0 0-4.4-4.4H6.4A4.4 4.4 0 0 0 2 19.4V21" /><circle cx="9" cy="7" r="4" /><path d="M18 11a4 4 0 0 0 0-8" /><path d="M22 21v-1.6a4.4 4.4 0 0 0-3.3-4.25" />',
    "phone-call": '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.12.9.34 1.78.65 2.61a2 2 0 0 1-.45 2.11L8.03 9.72a16 16 0 0 0 6 6l1.28-1.28a2 2 0 0 1 2.11-.45c.83.31 1.71.53 2.61.65A2 2 0 0 1 22 16.92Z" />',
    settings: '<path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.5 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.5a1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15.5 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.17.38.5.7.9.9.3.14.64.2.98.2H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51.9Z" />',
    paperclip: '<path d="m20.5 11.5-8.7 8.7a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7L9 17.4a2 2 0 1 1-2.8-2.8l8.5-8.5" />',
    smile: '<circle cx="12" cy="12" r="9.5" /><path d="M8 14.5c1.1 1.2 2.4 1.8 4 1.8s2.9-.6 4-1.8" /><path d="M9 9.2h.01" /><path d="M15 9.2h.01" />',
    "arrow-up": '<path d="M12 20V5" /><path d="m5.5 11.5 6.5-6.5 6.5 6.5" />',
    image: '<rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="8.5" cy="8.5" r="1.8" /><path d="m21 15-4.6-4.6a2 2 0 0 0-2.8 0L5 19" />',
    file: '<path d="M6 2h8l4 4v16H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z" /><path d="M14 2v5h5" />',
    trash: '<path d="M4 7h16" /><path d="M9 7V4h6v3" /><path d="m7 7 1 14h8l1-14" /><path d="M10 11v6" /><path d="M14 11v6" />',
    x: '<path d="m7 7 10 10" /><path d="M17 7 7 17" />',
    plus: '<path d="M12 5v14" /><path d="M5 12h14" />',
    search: '<circle cx="11" cy="11" r="7.5" /><path d="m20 20-3.7-3.7" />'
  };

  if (typeof ICONS === "object" && ICONS) {
    Object.assign(ICONS, iconOverrides);
  }

  if (typeof iconSvg === "function") {
    iconSvg = function yachatIconSvg(name, className = "lucide-icon") {
      const body = ICONS[name] || ICONS.file;
      return `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.15" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
    };
  }

  function readableSize(size) {
    const value = Number(size) || 0;
    if (value >= GB) return `${(value / GB).toFixed(value >= 10 * GB ? 0 : 1)} ГБ`;
    if (value >= MB) return `${(value / MB).toFixed(1)} МБ`;
    if (value >= 1024) return `${Math.ceil(value / 1024)} КБ`;
    return `${value} Б`;
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error(t("errSendMessage")));
      reader.onload = () => resolve(String(reader.result || ""));
      reader.readAsDataURL(file);
    });
  }

  function imageFromFile(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => {
        URL.revokeObjectURL(url);
        resolve(image);
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error(t("errAvatar")));
      };
      image.src = url;
    });
  }

  function canvasBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error(t("errSendMessage"))), type, quality);
    });
  }

  async function compressPhoto(file) {
    if (file.size <= PHOTO_INLINE_TARGET) {
      return {
        dataUrl: await fileToDataUrl(file),
        mime: file.type || "image/jpeg",
        size: file.size,
        compressed: false
      };
    }

    const image = await imageFromFile(file);
    let maxSide = file.size > PHOTO_SOFT_LIMIT ? 1600 : 2560;
    let quality = file.size > PHOTO_SOFT_LIMIT ? 0.7 : 0.92;
    let output = null;

    for (let attempt = 0; attempt < 9; attempt += 1) {
      const scale = Math.min(1, maxSide / Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height));
      const width = Math.max(1, Math.round((image.naturalWidth || image.width) * scale));
      const height = Math.max(1, Math.round((image.naturalHeight || image.height) * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { alpha: false });
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(image, 0, 0, width, height);
      output = await canvasBlob(canvas, "image/jpeg", quality);
      if (output.size <= PHOTO_INLINE_TARGET) break;
      if (quality > 0.72) quality -= 0.08;
      else maxSide = Math.max(1200, Math.round(maxSide * 0.82));
    }

    return {
      dataUrl: await fileToDataUrl(output),
      mime: "image/jpeg",
      size: output.size,
      compressed: true
    };
  }

  function attachmentId() {
    return globalThis.crypto?.randomUUID
      ? globalThis.crypto.randomUUID()
      : `att-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  async function readAsPhoto(file) {
    if (!file) throw new Error(t("errSendMessage"));
    const mime = file.type || "application/octet-stream";
    if (!mime.startsWith("image/") && !mime.startsWith("video/")) {
      return readAsDocument(file);
    }

    if (mime.startsWith("video/")) {
      return {
        id: attachmentId(),
        name: file.name || "video",
        mime,
        kind: "video",
        mode: "photo",
        size: file.size,
        originalSize: file.size,
        dataUrl: await fileToDataUrl(file)
      };
    }

    if (file.size > PHOTO_SOFT_LIMIT) {
      showActionFeedback(t("photoWillBeCompressed"), {
        tone: "error",
        icon: "image",
        duration: 4200
      });
    }

    const result = await compressPhoto(file);
    return {
      id: attachmentId(),
      name: file.name || "photo.jpg",
      mime: result.mime,
      kind: "image",
      mode: "photo",
      size: result.size,
      originalSize: file.size,
      compressed: result.compressed,
      dataUrl: result.dataUrl
    };
  }

  async function readAsDocument(file) {
    if (!file) throw new Error(t("errSendMessage"));
    return {
      id: attachmentId(),
      name: file.name || "file",
      mime: file.type || "application/octet-stream",
      kind: "file",
      mode: "document",
      originalKind: file.type?.startsWith("image/") ? "image" : file.type?.startsWith("video/") ? "video" : "file",
      size: file.size,
      originalSize: file.size,
      dataUrl: await fileToDataUrl(file)
    };
  }

  readAttachmentFile = readAsPhoto;

  addAttachments = async function upgradedAddAttachments(files, mode = "photo") {
    if (!canSendToChat(getActiveChat())) return;
    const freeSlots = Math.max(0, MAX_PENDING_ATTACHMENTS - state.pendingAttachments.length);
    const selected = [...(files || [])].slice(0, freeSlots);
    if (!selected.length) return;

    try {
      const reader = mode === "document" ? readAsDocument : readAsPhoto;
      const next = [];
      for (const file of selected) {
        next.push(await reader(file));
      }
      state.pendingAttachments = [...state.pendingAttachments, ...next].slice(0, MAX_PENDING_ATTACHMENTS);
      renderAttachmentTray();
    } catch (error) {
      showActionFeedback(translatedServerMessage(error.message, "errSendMessage"), {
        tone: "error",
        icon: "circle-alert",
        duration: 3600
      });
    }
  };

  renderAttachmentTray = function upgradedAttachmentTray() {
    if (!attachmentTray) return;
    const items = state.pendingAttachments;
    attachmentTray.hidden = items.length === 0;
    attachmentTray.innerHTML = items.length ? `
      <button class="attachment-clear-all" type="button" data-clear-attachments aria-label="${escapeHtml(t("clearAttachments"))}">
        ${iconSvg("trash")}
      </button>
      <div class="attachment-preview-list">
        ${items.map((attachment) => {
          const name = escapeHtml(attachment.name || "file");
          const size = escapeHtml(readableSize(attachment.originalSize || attachment.size));
          const remove = `<button class="attachment-preview-remove" type="button" data-remove-attachment="${escapeHtml(attachment.id)}" aria-label="${escapeHtml(t("removeAttachment"))}">${iconSvg("x")}</button>`;
          if (attachment.kind === "image" && attachment.dataUrl) {
            return `<article class="attachment-preview-card is-photo" title="${name}">
              <img src="${escapeHtml(attachment.dataUrl)}" alt="" />
              ${remove}
              <span>${attachment.compressed ? escapeHtml(t("photoOptimized")) : escapeHtml(t("photoLabel"))}</span>
            </article>`;
          }
          return `<article class="attachment-preview-card is-document" title="${name}">
            <span class="attachment-document-icon">${iconSvg(attachment.originalKind === "image" ? "image" : attachment.originalKind === "video" ? "video" : "file")}</span>
            <strong>${name}</strong>
            <small>${size}</small>
            ${remove}
          </article>`;
        }).join("")}
      </div>
    ` : "";

    const chat = getActiveChat();
    if (sendButton) {
      sendButton.disabled = !canSendToChat(chat) || (!messageInput.value.trim() && items.length === 0);
    }
  };

  function ensureModeInput(mode) {
    let input = document.querySelector(`[data-yachat-attachment-input="${mode}"]`);
    if (input) return input;
    input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.hidden = true;
    input.dataset.yachatAttachmentInput = mode;
    if (mode === "photo") input.accept = "image/*,video/*";
    input.addEventListener("change", async () => {
      await addAttachments(input.files, mode);
      input.value = "";
    });
    document.body.append(input);
    return input;
  }

  function closeAttachmentMenu() {
    document.querySelector("[data-yachat-attachment-menu]")?.remove();
  }

  function openAttachmentMenu() {
    closeAttachmentMenu();
    const menu = document.createElement("div");
    menu.className = "attachment-mode-menu";
    menu.dataset.yachatAttachmentMenu = "";
    menu.innerHTML = `
      <button type="button" data-attachment-mode="photo">
        <span class="attachment-mode-icon">${iconSvg("image")}</span>
        <span><strong>${escapeHtml(t("attachPhoto"))}</strong><small>${escapeHtml(t("attachPhotoHint"))}</small></span>
      </button>
      <button type="button" data-attachment-mode="document">
        <span class="attachment-mode-icon">${iconSvg("file")}</span>
        <span><strong>${escapeHtml(t("attachDocument"))}</strong><small>${escapeHtml(t("attachDocumentHint"))}</small></span>
      </button>
      <p>${escapeHtml(t("attachLimitHint"))}</p>
    `;
    document.body.append(menu);
    const rect = attachmentButton.getBoundingClientRect();
    const width = Math.min(340, window.innerWidth - 24);
    menu.style.width = `${width}px`;
    menu.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`;
    const menuHeight = menu.offsetHeight || 190;
    const top = rect.top - menuHeight - 10;
    menu.style.top = `${top > 12 ? top : rect.bottom + 10}px`;
    hydrateIcons(menu);
  }

  attachmentButton?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (canSendToChat(getActiveChat())) openAttachmentMenu();
  }, true);

  document.addEventListener("click", (event) => {
    const modeButton = event.target.closest("[data-attachment-mode]");
    if (modeButton) {
      event.preventDefault();
      const mode = modeButton.dataset.attachmentMode === "document" ? "document" : "photo";
      closeAttachmentMenu();
      ensureModeInput(mode).click();
      return;
    }

    if (event.target.closest("[data-clear-attachments]")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      state.pendingAttachments = [];
      renderAttachmentTray();
      return;
    }

    if (!event.target.closest("[data-yachat-attachment-menu]") && !event.target.closest('[data-action="attach-file"]')) {
      closeAttachmentMenu();
    }
  }, true);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeAttachmentMenu();
  });

  cropToDataUrl = function highQualityAvatarCrop(source, crop = {}) {
    const image = crop.image;
    if (!image) return "";
    const naturalWidth = image.naturalWidth || image.width || 256;
    const naturalHeight = image.naturalHeight || image.height || 256;
    const side = Math.max(256, Math.min(1024, Math.round(Math.min(naturalWidth, naturalHeight))));
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { alpha: true });
    const zoom = clamp(Number(crop.zoom) || 1, 1, 3);
    const scale = Math.max(side / naturalWidth, side / naturalHeight) * zoom;
    const width = naturalWidth * scale;
    const height = naturalHeight * scale;
    const maxX = Math.max(0, (width - side) / 2);
    const maxY = Math.max(0, (height - side) / 2);
    const offsetX = clamp(Number(crop.x) || 0, -1, 1) * maxX;
    const offsetY = clamp(Number(crop.y) || 0, -1, 1) * maxY;
    canvas.width = side;
    canvas.height = side;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, (side - width) / 2 + offsetX, (side - height) / 2 + offsetY, width, height);
    const transparentSource = /^data:image\/(png|webp)/i.test(String(source || ""));
    return transparentSource
      ? canvas.toDataURL("image/png")
      : canvas.toDataURL("image/jpeg", 0.96);
  };

  if (typeof translations === "object" && translations) {
    Object.assign(translations.ru, {
      allChats: "Чаты",
      attachPhoto: "Фото или видео",
      attachPhotoHint: "Фото отправится с умным сжатием ЯЧата",
      attachDocument: "Файл без сжатия",
      attachDocumentHint: "Фото уйдёт как документ ЯЧата без потери качества",
      attachLimitHint: "Фото до 20 ГБ. Более крупные ЯЧат сильно сожмёт.",
      photoWillBeCompressed: "Фото больше 20 ГБ будет сильно сжато",
      clearAttachments: "Убрать все вложения",
      removeAttachment: "Убрать вложение",
      photoOptimized: "Оптимизировано",
      photoLabel: "Фото"
    });
    Object.assign(translations.en, {
      allChats: "Chats",
      attachPhoto: "Photo or video",
      attachPhotoHint: "YaChat will optimize the photo for chat",
      attachDocument: "File without compression",
      attachDocumentHint: "The photo will be sent as a YaChat document without quality loss",
      attachLimitHint: "Photos up to 20 GB. Larger photos will be heavily compressed.",
      photoWillBeCompressed: "A photo larger than 20 GB will be heavily compressed",
      clearAttachments: "Remove all attachments",
      removeAttachment: "Remove attachment",
      photoOptimized: "Optimized",
      photoLabel: "Photo"
    });
  }

  hydrateIcons(document);
  applyTranslations();
  renderAttachmentTray();
  renderChatList();
  renderActiveChat();
  renderMessages();
  if (state.activePanel) renderPanel();
})();
