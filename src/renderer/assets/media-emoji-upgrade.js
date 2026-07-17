(() => {
  "use strict";

  if (
    typeof state === "undefined" ||
    typeof attachmentTray === "undefined" ||
    !attachmentTray ||
    !messageForm
  ) {
    return;
  }

  const originalFiles = new Map();
  const objectUrls = new Map();
  const processingJobs = new Map();
  const recentStorageKey = "yachat-recent-emoji";
  const editor = document.querySelector("[data-rich-message-editor]");
  let emojiPanel = null;
  let emojiCategory = "recent";
  let emojiQuery = "";
  let savedEditorRange = null;
  let resubmittingAfterProcessing = false;
  let mediaQueue = Promise.resolve();
  const PHOTO_PACKAGE_BUDGET_BYTES = 7_500_000;
  const PHOTO_SINGLE_TARGET_BYTES = 2_250_000;
  const PHOTO_ORIGINAL_FALLBACK_BYTES = 5_800_000;
  const PHOTO_MAX_SIDE = 3000;
  const PHOTO_MAX_PIXELS = 14_000_000;
  const PHOTO_PROCESS_TIMEOUT_MS = 18_000;

  const emojiGroups = {
    smileys: {
      label: "Лица",
      icon: "😀",
      values: [
        "😀", "😃", "😄", "😁", "😆", "😅", "😂", "🤣", "🥲", "😊", "😇", "🙂", "🙃", "😉", "😌",
        "😍", "🥰", "😘", "😗", "😙", "😚", "😋", "😛", "😝", "😜", "🤪", "🤨", "🧐", "🤓", "😎",
        "🥸", "🤩", "🥳", "😏", "😒", "😞", "😔", "😟", "😕", "🙁", "☹️", "😣", "😖", "😫", "😩",
        "🥺", "😢", "😭", "😤", "😠", "😡", "🤬", "🤯", "😳", "🥵", "🥶", "😱", "😨", "😰", "😥",
        "😓", "🤗", "🤔", "🫣", "🤭", "🫢", "🫡", "🤫", "🫠", "🤥", "😶", "🫥", "😐", "🫤", "😑",
        "😬", "🙄", "😯", "😦", "😧", "😮", "😲", "🥱", "😴", "🤤", "😪", "😵", "😵‍💫", "🤐", "🥴"
      ]
    },
    gestures: {
      label: "Жесты",
      icon: "👋",
      values: [
        "👋", "🤚", "🖐️", "✋", "🖖", "🫱", "🫲", "🫳", "🫴", "👌", "🤌", "🤏", "✌️", "🤞", "🫰",
        "🤟", "🤘", "🤙", "👈", "👉", "👆", "👇", "☝️", "🫵", "👍", "👎", "✊", "👊", "🤛", "🤜",
        "👏", "🙌", "🫶", "👐", "🤲", "🤝", "🙏", "✍️", "💅", "🤳", "💪", "🦾", "🦿", "🦵", "🦶",
        "👂", "👃", "🧠", "🫀", "🫁", "🦷", "👀", "👁️", "👅", "👄", "🫦", "🫂"
      ]
    },
    hearts: {
      label: "Сердца",
      icon: "❤️",
      values: [
        "❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "🤍", "🤎", "🩷", "🩵", "🩶", "💔", "❤️‍🔥", "❤️‍🩹",
        "❣️", "💕", "💞", "💓", "💗", "💖", "💘", "💝", "💟", "♥️", "💋", "💌", "💐", "🌹", "🥀",
        "✨", "⭐", "🌟", "💫", "⚡", "🔥", "💥", "💯", "🎉", "🎊", "🫧", "💦", "💨", "🕊️"
      ]
    },
    animals: {
      label: "Животные",
      icon: "🐱",
      values: [
        "🐶", "🐱", "🐭", "🐹", "🐰", "🦊", "🐻", "🐼", "🐻‍❄️", "🐨", "🐯", "🦁", "🐮", "🐷", "🐸",
        "🐵", "🙈", "🙉", "🙊", "🐒", "🐔", "🐧", "🐦", "🐤", "🐣", "🦆", "🦅", "🦉", "🦇", "🐺",
        "🐗", "🐴", "🦄", "🐝", "🪱", "🐛", "🦋", "🐌", "🐞", "🐜", "🪰", "🪲", "🪳", "🦟", "🦗",
        "🕷️", "🦂", "🐢", "🐍", "🦎", "🐙", "🦑", "🦐", "🦞", "🦀", "🐠", "🐟", "🐡", "🐬", "🐳"
      ]
    },
    food: {
      label: "Еда",
      icon: "🍕",
      values: [
        "🍏", "🍎", "🍐", "🍊", "🍋", "🍌", "🍉", "🍇", "🍓", "🫐", "🍈", "🍒", "🍑", "🥭", "🍍",
        "🥝", "🍅", "🍆", "🥑", "🥦", "🥬", "🥒", "🌶️", "🫑", "🌽", "🥕", "🫒", "🧄", "🧅", "🥔",
        "🍞", "🥐", "🥖", "🫓", "🥨", "🥯", "🥞", "🧇", "🧀", "🍗", "🍖", "🍔", "🍟", "🍕", "🌭",
        "🥪", "🌮", "🌯", "🫔", "🥙", "🧆", "🥚", "🍳", "🥘", "🍲", "🫕", "🥣", "🥗", "🍿", "🧈",
        "🍣", "🍱", "🥟", "🍜", "🍝", "🍦", "🍩", "🍪", "🎂", "🍰", "🧁", "🍫", "🍬", "☕", "🧋"
      ]
    },
    activities: {
      label: "Разное",
      icon: "🚀",
      values: [
        "⚽", "🏀", "🏈", "⚾", "🥎", "🎾", "🏐", "🏉", "🥏", "🎱", "🪀", "🏓", "🏸", "🏒", "🥅",
        "🎮", "🕹️", "🎲", "🧩", "🎯", "🎳", "🎸", "🎹", "🎤", "🎧", "📱", "💻", "⌨️", "🖥️", "📷",
        "🚗", "🚕", "🚌", "🚓", "🚑", "🚒", "🚲", "🏍️", "🚆", "✈️", "🚀", "🛸", "🚁", "⛵", "🏠",
        "🌍", "🌎", "🌏", "🌙", "☀️", "🌤️", "🌧️", "⛈️", "❄️", "☃️", "🌈", "☂️", "🎁", "🔒", "🔑",
        "✅", "❌", "⚠️", "❗", "❓", "💡", "📌", "📎", "✏️", "📝", "📚", "🔔", "🔕", "⏳", "⌛"
      ]
    }
  };

  const emojiKeywords = new Map([
    ["😀", "улыбка радость smile happy"], ["😂", "смех слезы laugh tears"], ["😭", "плач грусть cry sad"],
    ["😍", "любовь глаза love"], ["🥰", "любовь нежность love"], ["😡", "злость angry"], ["🤔", "думаю think"],
    ["👍", "да хорошо класс yes good"], ["👎", "нет плохо no bad"], ["🙏", "спасибо пожалуйста thanks please"],
    ["❤️", "сердце любовь heart love"], ["💔", "разбитое сердце broken heart"], ["🔥", "огонь fire"],
    ["🎉", "праздник поздравление party"], ["🐱", "кот кошка cat"], ["🐶", "собака dog"],
    ["🐔", "курица chicken"], ["🍕", "пицца pizza"], ["☕", "кофе чай coffee tea"],
    ["🚀", "ракета rocket"], ["✅", "готово да done yes"], ["❌", "нет ошибка no error"],
    ["⚠️", "внимание предупреждение warning"], ["🔒", "замок безопасность lock security"], ["🔑", "ключ key"],
    ["⏳", "время ожидание time wait"], ["💡", "идея idea"], ["📌", "закрепить pin"], ["📝", "заметка note"]
  ]);

  function createId() {
    return globalThis.crypto?.randomUUID
      ? globalThis.crypto.randomUUID()
      : `att-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error(t("errSendMessage")));
      }, type, quality);
    });
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error(t("errSendMessage")));
      reader.onload = () => resolve(String(reader.result || ""));
      reader.readAsDataURL(blob);
    });
  }

  function makePreviewUrl(id, file) {
    const url = URL.createObjectURL(file);
    objectUrls.set(id, url);
    return url;
  }

  function releasePreviewUrl(id) {
    const url = objectUrls.get(id);
    if (url) URL.revokeObjectURL(url);
    objectUrls.delete(id);
  }

  function forgetAttachment(id) {
    releasePreviewUrl(id);
    originalFiles.delete(id);
    processingJobs.delete(id);
  }

  async function decodeImage(file) {
    if (typeof createImageBitmap === "function") {
      try {
        return await createImageBitmap(file, { imageOrientation: "from-image" });
      } catch {
        // Safari may reject options for formats it can still display.
      }
    }

    const url = URL.createObjectURL(file);
    try {
      const image = await loadImageElement(url);
      return image;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function yieldToBrowser() {
    return new Promise((resolve) => {
      if (typeof requestIdleCallback === "function") {
        requestIdleCallback(() => resolve(), { timeout: 80 });
      } else {
        window.setTimeout(resolve, 0);
      }
    });
  }

  function withTimeout(promise, timeoutMs = PHOTO_PROCESS_TIMEOUT_MS) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = window.setTimeout(() => reject(new Error(t("errSendMessage"))), timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timer));
  }

  function photoTargetBytes() {
    const count = Math.max(1, state.pendingAttachments.filter((item) => {
      const mime = String(item?.previewMime || item?.mime || "");
      return mime.startsWith("image/") && !item.sendAsDocument;
    }).length);
    return Math.max(900_000, Math.min(PHOTO_SINGLE_TARGET_BYTES, Math.floor(PHOTO_PACKAGE_BUDGET_BYTES / count)));
  }

  async function encodePhotoWithoutBlocking(file) {
    const targetBytes = photoTargetBytes();
    const mime = String(file.type || "").toLowerCase();
    const directlySupported = /image\/(?:jpeg|jpg|png|webp|gif)/.test(mime);
    const animated = mime === "image/gif";

    if (directlySupported && file.size <= Math.min(targetBytes, PHOTO_SINGLE_TARGET_BYTES)) {
      return { dataUrl: await blobToDataUrl(file), spoiled: false };
    }

    if (animated && file.size <= PHOTO_ORIGINAL_FALLBACK_BYTES) {
      return { dataUrl: await blobToDataUrl(file), spoiled: false };
    }

    let source = null;
    try {
      await yieldToBrowser();
      source = await withTimeout(decodeImage(file));
    } catch (error) {
      if (directlySupported && file.size <= PHOTO_ORIGINAL_FALLBACK_BYTES) {
        return { dataUrl: await blobToDataUrl(file), spoiled: false };
      }
      throw error;
    }

    try {
      const width = Math.max(1, source.naturalWidth || source.width || 1);
      const height = Math.max(1, source.naturalHeight || source.height || 1);
      const spoiled = file.size > PHOTO_RULE_LIMIT_BYTES;
      const sideLimit = spoiled ? 1280 : PHOTO_MAX_SIDE;
      const scale = Math.min(
        1,
        sideLimit / Math.max(width, height),
        Math.sqrt(PHOTO_MAX_PIXELS / Math.max(1, width * height))
      );
      let outputWidth = Math.max(1, Math.round(width * scale));
      let outputHeight = Math.max(1, Math.round(height * scale));
      const outputType = mime === "image/png" ? "image/webp" : "image/jpeg";
      let canvas = document.createElement("canvas");
      canvas.width = outputWidth;
      canvas.height = outputHeight;
      let context = canvas.getContext("2d", { alpha: outputType === "image/webp" });
      if (!context) throw new Error(t("errSendMessage"));

      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      await yieldToBrowser();
      context.drawImage(source, 0, 0, outputWidth, outputHeight);
      await yieldToBrowser();

      const qualities = spoiled ? [0.72, 0.62, 0.52] : [0.95, 0.91, 0.86, 0.80, 0.74];
      let blob = null;
      for (const quality of qualities) {
        blob = await withTimeout(canvasToBlob(canvas, outputType, quality), 8_000);
        if (blob.size <= targetBytes) break;
        await yieldToBrowser();
      }

      if (!blob) throw new Error(t("errSendMessage"));
      if (blob.size > targetBytes * 1.18) {
        const reduction = Math.max(0.58, Math.min(0.92, Math.sqrt(targetBytes / blob.size)));
        outputWidth = Math.max(1, Math.round(outputWidth * reduction));
        outputHeight = Math.max(1, Math.round(outputHeight * reduction));
        const reduced = document.createElement("canvas");
        reduced.width = outputWidth;
        reduced.height = outputHeight;
        const reducedContext = reduced.getContext("2d", { alpha: outputType === "image/webp" });
        if (!reducedContext) throw new Error(t("errSendMessage"));
        reducedContext.imageSmoothingEnabled = true;
        reducedContext.imageSmoothingQuality = "high";
        await yieldToBrowser();
        reducedContext.drawImage(canvas, 0, 0, outputWidth, outputHeight);
        canvas.width = 1;
        canvas.height = 1;
        canvas = reduced;
        context = reducedContext;
        blob = await withTimeout(canvasToBlob(canvas, outputType, spoiled ? 0.58 : 0.86), 8_000);
      }

      const dataUrl = await withTimeout(blobToDataUrl(blob), 8_000);
      canvas.width = 1;
      canvas.height = 1;
      return { dataUrl, spoiled };
    } finally {
      source?.close?.();
    }
  }

  function updateSendAvailability() {
    if (!sendButton) return;
    const chat = getActiveChat();
    const processing = state.pendingAttachments.some((item) => item.processing);
    sendButton.disabled = processing || (state.editingMessageId
      ? !messageInput.value.trim()
      : !canSendToChat(chat) || (!messageInput.value.trim() && state.pendingAttachments.length === 0));
  }

  function renderAttachmentCard(item) {
    const file = originalFiles.get(item.id);
    const previewSource = item.previewUrl || objectUrls.get(item.id) || item.dataUrl || "";
    const isImageSource = Boolean(file?.type?.startsWith("image/") || item.previewMime?.startsWith("image/") || item.mime?.startsWith("image/"));

    if (isImageSource && previewSource) {
      return `
        <article class="attachment-preview is-photo${item.processing ? " is-processing" : ""}${item.sendAsDocument ? " is-document-mode" : ""}" data-attachment-card="${escapeHtml(item.id)}">
          <div class="attachment-preview-media"><img src="${escapeHtml(previewSource)}" alt="" /></div>
          <button class="attachment-photo-action is-remove" type="button" data-remove-attachment="${escapeHtml(item.id)}" aria-label="Удалить фото">${iconSvg("trash")}</button>
          <button class="attachment-photo-action is-document" type="button" data-convert-attachment="${escapeHtml(item.id)}" aria-label="${item.sendAsDocument ? "Отправить как фото" : "Отправить как документ"}" aria-pressed="${item.sendAsDocument ? "true" : "false"}">${iconSvg("file-text")}</button>
          ${item.processing ? '<span class="attachment-processing" aria-label="Обработка фото"></span>' : ""}
        </article>
      `;
    }

    const dataUrl = item.dataUrl || "";
    const video = item.kind === "video" && dataUrl
      ? `<video src="${escapeHtml(dataUrl)}" muted playsinline></video>`
      : iconSvg("file-text");
    return `
      <article class="attachment-preview${item.processing ? " is-processing" : ""}">
        <button class="attachment-preview-delete" type="button" data-remove-attachment="${escapeHtml(item.id)}" aria-label="${escapeHtml(t("menuDelete"))}">${iconSvg("trash")}</button>
        <div class="attachment-preview-media">${video}</div>
        <div class="attachment-preview-copy"><strong>${escapeHtml(item.name || "Файл")}</strong><small>${escapeHtml(attachmentTypeLabel(item))}</small></div>
        ${item.processing ? '<span class="attachment-processing" aria-label="Обработка файла"></span>' : ""}
      </article>
    `;
  }

  renderAttachmentTray = function renderResponsiveAttachmentTray() {
    if (!attachmentTray) return;
    const liveIds = new Set(state.pendingAttachments.map((item) => item.id));
    [...originalFiles.keys()].filter((id) => !liveIds.has(id)).forEach(forgetAttachment);
    const visible = state.pendingAttachments.length > 0;
    attachmentTray.hidden = !visible;
    if (attachmentPolicy) {
      attachmentPolicy.hidden = true;
      attachmentPolicy.textContent = "";
    }
    attachmentTray.innerHTML = state.pendingAttachments.map(renderAttachmentCard).join("");
    updateSendAvailability();
  };

  async function processAttachment(item, file, mode) {
    try {
      const documentMode = mode === "document";
      const mime = file.type || "application/octet-stream";
      if ((documentMode || !mime.startsWith("image/")) && file.size > DOCUMENT_TRANSPORT_LIMIT_BYTES) {
        throw new Error(t("attachLimit"));
      }

      const encoded = !documentMode && mime.startsWith("image/")
        ? await encodePhotoWithoutBlocking(file)
        : { dataUrl: await readFileAsDataUrl(file), spoiled: false };
      const current = state.pendingAttachments.find((candidate) => candidate.id === item.id);
      if (!current) return;

      Object.assign(current, {
        dataUrl: encoded.dataUrl,
        processing: false,
        spoiled: encoded.spoiled,
        kind: documentMode ? "file" : mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : "file",
        sendAsDocument: documentMode
      });
      renderAttachmentTray();
    } catch (error) {
      state.pendingAttachments = state.pendingAttachments.filter((candidate) => candidate.id !== item.id);
      forgetAttachment(item.id);
      renderAttachmentTray();
      showActionFeedback(translatedServerMessage(error.message, "errSendMessage"), {
        tone: "error",
        icon: "circle-alert",
        duration: 4200
      });
    } finally {
      processingJobs.delete(item.id);
      updateSendAvailability();
    }
  }

  addAttachments = function addResponsiveAttachments(files, mode = "media") {
    if (!canSendToChat(getActiveChat())) return Promise.resolve([]);
    const selected = [...(files || [])].slice(0, 8 - state.pendingAttachments.length);
    const jobs = [];

    selected.forEach((file) => {
      const mime = file.type || "application/octet-stream";
      const id = createId();
      originalFiles.set(id, file);
      const item = {
        id,
        name: file.name || "file",
        mime,
        previewMime: mime,
        size: file.size,
        originalSize: file.size,
        kind: mode === "document" ? "file" : mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : "file",
        sendAsDocument: mode === "document",
        spoiled: false,
        processing: true,
        dataUrl: "",
        previewUrl: makePreviewUrl(id, file)
      };
      state.pendingAttachments.push(item);
      const job = mediaQueue.then(() => processAttachment(item, file, mode));
      mediaQueue = job.catch(() => {});
      processingJobs.set(id, job);
      jobs.push(job);
    });

    state.pendingAttachments = state.pendingAttachments.slice(0, 8);
    renderAttachmentTray();
    [attachmentInput, documentInput].forEach((input) => {
      if (input) input.value = "";
    });
    return Promise.allSettled(jobs);
  };

  async function convertAttachment(id) {
    const item = state.pendingAttachments.find((candidate) => candidate.id === id);
    const file = originalFiles.get(id);
    if (!item || !file) return;

    const previousJob = processingJobs.get(id);
    if (previousJob) await previousJob;
    if (!state.pendingAttachments.some((candidate) => candidate.id === id)) return;

    if (!item.sendAsDocument && file.size > DOCUMENT_TRANSPORT_LIMIT_BYTES) {
      showActionFeedback(t("attachLimit"), { tone: "error", icon: "circle-alert", duration: 4200 });
      return;
    }

    item.processing = true;
    renderAttachmentTray();
    const job = mediaQueue.then(async () => {
      try {
        if (item.sendAsDocument) {
          const encoded = await encodePhotoWithoutBlocking(file);
          Object.assign(item, {
            kind: "image",
            sendAsDocument: false,
            dataUrl: encoded.dataUrl,
            spoiled: encoded.spoiled,
            processing: false
          });
        } else {
          Object.assign(item, {
            kind: "file",
            sendAsDocument: true,
            dataUrl: await readFileAsDataUrl(file),
            spoiled: false,
            processing: false
          });
        }
      } catch (error) {
        item.processing = false;
        showActionFeedback(translatedServerMessage(error.message, "errSendMessage"), {
          tone: "error",
          icon: "circle-alert",
          duration: 4200
        });
      } finally {
        processingJobs.delete(id);
        renderAttachmentTray();
      }
    });
    mediaQueue = job.catch(() => {});
    processingJobs.set(id, job);
    await job;
  }

  attachmentTray.addEventListener("click", (event) => {
    const convertButton = event.target.closest("[data-convert-attachment]");
    if (convertButton) {
      event.preventDefault();
      event.stopImmediatePropagation();
      void convertAttachment(convertButton.dataset.convertAttachment);
      return;
    }

    const removeButton = event.target.closest("[data-remove-attachment]");
    if (!removeButton) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const id = removeButton.dataset.removeAttachment;
    state.pendingAttachments = state.pendingAttachments.filter((item) => item.id !== id);
    forgetAttachment(id);
    renderAttachmentTray();
  }, true);

  if (documentButton) {
    documentButton.hidden = true;
    documentButton.setAttribute("aria-hidden", "true");
    documentButton.tabIndex = -1;
  }

  if (typeof createTransientOutgoingMessage === "function") {
    const previousCreateTransient = createTransientOutgoingMessage;
    createTransientOutgoingMessage = function createCleanMediaTransient(chat, payload = {}) {
      const attachmentIds = (payload.attachments || []).map((item) => item.id).filter(Boolean);
      const cleanAttachments = (payload.attachments || []).map((item) => {
        const { previewUrl, previewMime, processing, ...clean } = item;
        return clean;
      });
      const message = previousCreateTransient(chat, { ...payload, attachments: cleanAttachments });
      queueMicrotask(() => attachmentIds.forEach(forgetAttachment));
      return message;
    };
  }

  messageForm.addEventListener("submit", async (event) => {
    if (resubmittingAfterProcessing) {
      resubmittingAfterProcessing = false;
      return;
    }

    const jobs = state.pendingAttachments
      .map((item) => processingJobs.get(item.id))
      .filter(Boolean);
    if (!jobs.length && !state.pendingAttachments.some((item) => item.processing)) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    sendButton.disabled = true;
    await Promise.allSettled(jobs);
    if (state.pendingAttachments.some((item) => item.processing)) return;
    updateSendAvailability();
    if (!messageInput.value.trim() && state.pendingAttachments.length === 0) return;
    if (sendButton.disabled) return;
    resubmittingAfterProcessing = true;
    messageForm.requestSubmit(sendButton);
  }, true);

  function recentEmoji() {
    try {
      const value = JSON.parse(localStorage.getItem(recentStorageKey) || "[]");
      return Array.isArray(value) ? value.filter((item) => typeof item === "string").slice(0, 36) : [];
    } catch {
      return [];
    }
  }

  function rememberEmoji(value) {
    const next = [value, ...recentEmoji().filter((item) => item !== value)].slice(0, 36);
    localStorage.setItem(recentStorageKey, JSON.stringify(next));
  }

  function allEmoji() {
    return Object.entries(emojiGroups).flatMap(([group, data]) => data.values.map((value) => ({
      value,
      group,
      label: data.label,
      keywords: `${data.label} ${emojiKeywords.get(value) || ""}`.toLowerCase()
    })));
  }

  function currentEmojiValues() {
    const query = emojiQuery.trim().toLowerCase();
    if (query) {
      return allEmoji()
        .filter((item) => item.value.includes(query) || item.keywords.includes(query))
        .map((item) => item.value);
    }
    if (emojiCategory === "recent") return recentEmoji();
    return emojiGroups[emojiCategory]?.values || [];
  }

  function ensureEmojiPanel() {
    if (emojiPanel?.isConnected) return emojiPanel;
    emojiPanel = document.createElement("section");
    emojiPanel.className = "emoji-picker";
    emojiPanel.hidden = true;
    emojiPanel.setAttribute("role", "dialog");
    emojiPanel.setAttribute("aria-label", "Эмодзи");
    document.body.append(emojiPanel);

    emojiPanel.addEventListener("input", (event) => {
      if (!event.target.matches("[data-emoji-search]")) return;
      emojiQuery = event.target.value || "";
      renderEmojiPanel();
      emojiPanel.querySelector("[data-emoji-search]")?.focus({ preventScroll: true });
    });

    emojiPanel.addEventListener("click", (event) => {
      const categoryButton = event.target.closest("[data-emoji-category]");
      if (categoryButton) {
        emojiCategory = categoryButton.dataset.emojiCategory;
        emojiQuery = "";
        renderEmojiPanel();
        return;
      }

      const emojiButton = event.target.closest("[data-emoji-value]");
      if (emojiButton) {
        insertEmoji(emojiButton.dataset.emojiValue);
        rememberEmoji(emojiButton.dataset.emojiValue);
        if (emojiCategory === "recent") renderEmojiPanel();
        return;
      }

      if (event.target.closest("[data-emoji-close]")) closeEmojiPanel();
    });
    return emojiPanel;
  }

  function renderEmojiPanel() {
    const panel = ensureEmojiPanel();
    const values = currentEmojiValues();
    panel.innerHTML = `
      <header class="emoji-picker-head">
        <input type="search" inputmode="search" autocomplete="off" placeholder="Поиск эмодзи" value="${escapeHtml(emojiQuery)}" data-emoji-search />
        <button type="button" data-emoji-close aria-label="Закрыть">${iconSvg("x")}</button>
      </header>
      <nav class="emoji-picker-tabs" aria-label="Категории эмодзи">
        <button type="button" class="${emojiCategory === "recent" ? "is-active" : ""}" data-emoji-category="recent" aria-label="Недавние">🕘</button>
        ${Object.entries(emojiGroups).map(([key, group]) => `<button type="button" class="${emojiCategory === key ? "is-active" : ""}" data-emoji-category="${key}" aria-label="${escapeHtml(group.label)}">${group.icon}</button>`).join("")}
      </nav>
      <div class="emoji-picker-grid">
        ${values.length
          ? values.map((value) => `<button type="button" data-emoji-value="${escapeHtml(value)}" aria-label="${escapeHtml(emojiKeywords.get(value) || "Эмодзи")}">${value}</button>`).join("")
          : '<p class="emoji-picker-empty">Здесь пока пусто</p>'}
      </div>
    `;
  }

  function saveEditorSelection() {
    if (!editor) return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (editor.contains(range.commonAncestorContainer)) savedEditorRange = range.cloneRange();
  }

  function insertEmoji(value) {
    if (!editor || !value) return;
    editor.focus({ preventScroll: true });
    const selection = window.getSelection();
    let range = savedEditorRange;
    if (!range || !editor.contains(range.commonAncestorContainer)) {
      range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
    }
    selection.removeAllRanges();
    selection.addRange(range);
    range.deleteContents();
    const node = document.createTextNode(value);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    savedEditorRange = range.cloneRange();
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  }

  function positionEmojiPanel() {
    if (!emojiPanel || emojiPanel.hidden || !stickersButton) return;
    const rect = stickersButton.getBoundingClientRect();
    const viewport = window.visualViewport;
    const viewportLeft = viewport?.offsetLeft || 0;
    const viewportTop = viewport?.offsetTop || 0;
    const viewportWidth = viewport?.width || window.innerWidth;
    const viewportHeight = viewport?.height || window.innerHeight;
    const width = Math.min(372, viewportWidth - 16);
    emojiPanel.style.width = `${width}px`;
    const panelHeight = emojiPanel.getBoundingClientRect().height;
    const left = Math.min(
      Math.max(viewportLeft + 8, rect.right - width),
      viewportLeft + viewportWidth - width - 8
    );
    const above = rect.top - panelHeight - 8;
    const top = above >= viewportTop + 8
      ? above
      : Math.min(viewportTop + viewportHeight - panelHeight - 8, rect.bottom + 8);
    emojiPanel.style.left = `${left}px`;
    emojiPanel.style.top = `${Math.max(viewportTop + 8, top)}px`;
    emojiPanel.style.removeProperty("bottom");
  }

  function openEmojiPanel() {
    const panel = ensureEmojiPanel();
    renderEmojiPanel();
    panel.hidden = false;
    positionEmojiPanel();
  }

  function closeEmojiPanel() {
    if (emojiPanel) emojiPanel.hidden = true;
  }

  stickersButton?.addEventListener("pointerdown", () => saveEditorSelection(), true);
  stickersButton?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!canSendToChat(getActiveChat())) return;
    if (emojiPanel && !emojiPanel.hidden) closeEmojiPanel();
    else openEmojiPanel();
  }, true);

  if (stickersButton) {
    stickersButton.setAttribute("aria-label", "Эмодзи");
    stickersButton.innerHTML = iconSvg("smile");
  }

  document.addEventListener("pointerdown", (event) => {
    if (event.target.closest(".emoji-picker") || event.target.closest('[data-action="open-stickers"]')) return;
    closeEmojiPanel();
  }, true);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && emojiPanel && !emojiPanel.hidden) {
      event.preventDefault();
      closeEmojiPanel();
    }
  });

  window.addEventListener("resize", positionEmojiPanel);
  window.visualViewport?.addEventListener("resize", positionEmojiPanel);
  window.addEventListener("pagehide", () => [...objectUrls.keys()].forEach(releasePreviewUrl));
  renderAttachmentTray();
})();
