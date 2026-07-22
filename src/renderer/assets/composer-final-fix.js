(() => {
  "use strict";

  if (window.__yachatComposerFinalFixInstalled) return;
  window.__yachatComposerFinalFixInstalled = true;

  const form = document.querySelector('[data-form="message"]');
  const transport = document.querySelector('[data-message-input]');
  const attachmentInput = document.querySelector('[data-attachment-input]');
  const documentInput = document.querySelector('[data-document-input]');
  const attachmentButton = document.querySelector('[data-action="attach-file"]');
  const send = form?.querySelector('.send-button');
  if (!form || !transport || !attachmentInput || !attachmentButton || !send) return;

  const HISTORY_DB = 'yachat-history-cache-v3';
  const HISTORY_STORE = 'histories';
  const HISTORY_LIMIT = 56;
  const HISTORY_MAX_BYTES = 7_000_000;
  const MAX_ATTACHMENTS = 8;
  const MAX_TOTAL_ATTACHMENT_BYTES = 18 * 1024 * 1024;
  const isIos = /iPad|iPhone|iPod/i.test(navigator.userAgent || '')
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  let databasePromise = null;
  let historyWriteTimer = 0;
  let attachmentMenu = null;
  let preparingAttachments = false;

  function installComposerLayout() {
    let row = form.querySelector('.composer-bottom-row');
    if (!row) {
      row = document.createElement('div');
      row.className = 'composer-bottom-row';
      form.append(row);
    }

    const iosField = form.querySelector('.ios-rich-message-field');
    const richEditor = form.querySelector('[data-rich-message-editor]');
    const visibleField = iosField || richEditor || transport;
    const stickers = form.querySelector('[data-action="open-stickers"]');
    [attachmentButton, visibleField, stickers, send].forEach((element) => {
      if (element && element.parentElement !== row) row.append(element);
    });
  }

  function nextPaint() {
    return new Promise((resolve) => requestAnimationFrame(() => window.setTimeout(resolve, 0)));
  }

  function openHistoryDatabase() {
    if (!('indexedDB' in window)) return Promise.resolve(null);
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve) => {
      const request = indexedDB.open(HISTORY_DB, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(HISTORY_STORE)) {
          request.result.createObjectStore(HISTORY_STORE, { keyPath: 'chatId' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    });
    return databasePromise;
  }

  function compactHistory(messages) {
    let compact = (Array.isArray(messages) ? messages : []).slice(-HISTORY_LIMIT).map((message) => ({ ...message }));
    while (compact.length > 8) {
      let bytes = 0;
      try {
        bytes = new Blob([JSON.stringify(compact)]).size;
      } catch {
        return compact.slice(-24);
      }
      if (bytes <= HISTORY_MAX_BYTES) break;
      compact.shift();
    }
    return compact;
  }

  async function readCachedHistory(chatId) {
    const db = await openHistoryDatabase();
    if (!db || !chatId) return [];
    return new Promise((resolve) => {
      try {
        const request = db.transaction(HISTORY_STORE, 'readonly').objectStore(HISTORY_STORE).get(String(chatId));
        request.onsuccess = () => resolve(Array.isArray(request.result?.messages) ? request.result.messages : []);
        request.onerror = () => resolve([]);
      } catch {
        resolve([]);
      }
    });
  }

  async function writeCachedHistory(chatId, messages) {
    const db = await openHistoryDatabase();
    if (!db || !chatId) return;
    try {
      const transaction = db.transaction(HISTORY_STORE, 'readwrite');
      transaction.objectStore(HISTORY_STORE).put({
        chatId: String(chatId),
        savedAt: Date.now(),
        messages: compactHistory(messages)
      });
    } catch {
      // The cache is optional. The messenger must stay usable without it.
    }
  }

  function scheduleHistoryWrite() {
    window.clearTimeout(historyWriteTimer);
    historyWriteTimer = window.setTimeout(() => {
      try {
        const chatId = String(state?.activeChatId || '');
        if (chatId && Array.isArray(state?.messages)) void writeCachedHistory(chatId, state.messages);
      } catch {
        // State may not be initialized during the first paint.
      }
    }, 180);
  }

  function messageFingerprint(messages) {
    return (messages || []).map((message) => [
      message?.id,
      message?.editedAt,
      message?.deliveryStatus,
      message?.text,
      message?.formattedHtml,
      Array.isArray(message?.attachments) ? message.attachments.length : 0
    ].join('\u001f')).join('\u001e');
  }

  function installHistoryCache() {
    if (typeof yachatApi === 'undefined' || !yachatApi?.messenger?.messages) return;
    const originalMessages = yachatApi.messenger.messages.bind(yachatApi.messenger);

    yachatApi.messenger.messages = async (chatId) => {
      const requestedChatId = String(chatId || '');
      const remotePromise = originalMessages(requestedChatId).then((messages) => {
        const remote = Array.isArray(messages) ? messages : [];
        void writeCachedHistory(requestedChatId, remote);
        try {
          if (requestedChatId === String(state?.activeChatId || '')
            && messageFingerprint(state.messages) !== messageFingerprint(remote)) {
            state.messages = remote;
            renderActiveChat?.();
            renderMessages?.();
          }
        } catch {
          // A background refresh must never break chat navigation.
        }
        return remote;
      });

      const cached = await Promise.race([
        readCachedHistory(requestedChatId),
        new Promise((resolve) => window.setTimeout(() => resolve([]), 120))
      ]);
      if (Array.isArray(cached) && cached.length) {
        remotePromise.catch(() => {});
        return cached;
      }
      return remotePromise;
    };

    if (typeof renderMessages === 'function') {
      const originalRenderMessages = renderMessages;
      renderMessages = function renderMessagesWithCache(...args) {
        const result = originalRenderMessages.apply(this, args);
        scheduleHistoryWrite();
        return result;
      };
    }
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('Не удалось подготовить фото.'));
      reader.readAsDataURL(blob);
    });
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Не удалось подготовить фото.')), type, quality);
    });
  }

  async function decodeImage(file) {
    if ('createImageBitmap' in window) {
      try {
        return await createImageBitmap(file, { imageOrientation: 'from-image' });
      } catch {
        // Safari versions differ here; the image element fallback is reliable.
      }
    }
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.decoding = 'async';
      image.src = url;
      if (typeof image.decode === 'function') await image.decode();
      else await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = reject;
      });
      return image;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function encodePhotoWithoutBlocking(file) {
    await nextPaint();
    const source = await decodeImage(file);
    try {
      const width = Number(source.width || source.naturalWidth || 1);
      const height = Number(source.height || source.naturalHeight || 1);
      const maxSide = isIos ? 1680 : 2048;
      const scale = Math.min(1, maxSide / Math.max(width, height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('Не удалось подготовить фото.');
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      await nextPaint();

      const keepPng = file.type === 'image/png' && file.size <= 2.2 * 1024 * 1024;
      let blob = await canvasToBlob(canvas, keepPng ? 'image/png' : 'image/jpeg', keepPng ? undefined : 0.82);
      if (!keepPng && blob.size > 3.2 * 1024 * 1024) {
        await nextPaint();
        blob = await canvasToBlob(canvas, 'image/jpeg', 0.66);
      }
      return blobToDataUrl(blob);
    } finally {
      source.close?.();
    }
  }

  async function readAttachmentNonBlocking(file, mode = 'media') {
    if (!file) throw new Error('Файл не выбран.');
    const mime = file.type || 'application/octet-stream';
    const documentMode = mode === 'document';
    const dataUrl = !documentMode && mime.startsWith('image/')
      ? await encodePhotoWithoutBlocking(file)
      : await blobToDataUrl(file);
    return {
      id: globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `att-${Date.now()}-${Math.random()}`,
      name: file.name || 'file',
      mime,
      size: file.size,
      originalSize: file.size,
      kind: documentMode ? 'file' : mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : 'file',
      sendAsDocument: documentMode,
      spoiled: false,
      dataUrl
    };
  }

  function pendingAttachmentBytes() {
    try {
      return (state.pendingAttachments || []).reduce((sum, item) => sum + Number(item?.size || 0), 0);
    } catch {
      return 0;
    }
  }

  async function addAttachmentsNonBlocking(files, mode = 'media') {
    if (preparingAttachments) return;
    try {
      if (!canSendToChat(getActiveChat())) return;
    } catch {
      return;
    }

    const existingCount = Array.isArray(state.pendingAttachments) ? state.pendingAttachments.length : 0;
    const selected = [...(files || [])].slice(0, Math.max(0, MAX_ATTACHMENTS - existingCount));
    if (!selected.length) return;
    const selectedBytes = selected.reduce((sum, file) => sum + Number(file?.size || 0), 0);
    if (pendingAttachmentBytes() + selectedBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      window.yachatFeedback?.show?.('Вложения слишком большие. Выберите меньше файлов.', {
        tone: 'error', icon: 'circle-alert', duration: 4200
      });
      return;
    }

    preparingAttachments = true;
    form.classList.add('is-preparing-attachments');
    try {
      for (const file of selected) {
        await nextPaint();
        const attachment = await readAttachmentNonBlocking(file, mode);
        state.pendingAttachments = [...(state.pendingAttachments || []), attachment].slice(0, MAX_ATTACHMENTS);
        renderAttachmentTray?.();
        await nextPaint();
      }
    } catch (error) {
      window.yachatFeedback?.show?.(String(error?.message || 'Не удалось добавить вложение.'), {
        tone: 'error', icon: 'circle-alert', duration: 4200
      });
    } finally {
      preparingAttachments = false;
      form.classList.remove('is-preparing-attachments');
      send.disabled = !canSendToChat(getActiveChat())
        || (!String(transport.value || '').trim() && !(state.pendingAttachments || []).length);
    }
  }

  function closeAttachmentMenu() {
    if (attachmentMenu) attachmentMenu.hidden = true;
  }

  function ensureAttachmentMenu() {
    if (attachmentMenu?.isConnected) return attachmentMenu;
    attachmentMenu = document.createElement('div');
    attachmentMenu.className = 'composer-attachment-menu';
    attachmentMenu.hidden = true;
    attachmentMenu.innerHTML = `
      <button type="button" data-composer-attachment-kind="media">Фото или видео</button>
      <button type="button" data-composer-attachment-kind="document">Файл без сжатия</button>
    `;
    document.body.append(attachmentMenu);
    attachmentMenu.addEventListener('pointerdown', (event) => event.preventDefault());
    attachmentMenu.addEventListener('click', (event) => {
      const button = event.target.closest('[data-composer-attachment-kind]');
      if (!button) return;
      closeAttachmentMenu();
      if (button.dataset.composerAttachmentKind === 'document') documentInput?.click();
      else attachmentInput.click();
    });
    return attachmentMenu;
  }

  function openAttachmentMenu() {
    const menu = ensureAttachmentMenu();
    const rect = attachmentButton.getBoundingClientRect();
    menu.hidden = false;
    const menuRect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(window.innerWidth - menuRect.width - 8, rect.left))}px`;
    menu.style.top = `${Math.max(8, rect.top - menuRect.height - 8)}px`;
  }

  function installAttachmentPipeline() {
    document.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[data-action="attach-file"]')) {
        event.preventDefault();
        event.stopImmediatePropagation();
        try {
          if (canSendToChat(getActiveChat())) openAttachmentMenu();
        } catch {}
        return;
      }
      if (!target?.closest('.composer-attachment-menu')) closeAttachmentMenu();
    }, true);

    document.addEventListener('change', (event) => {
      const target = event.target;
      if (target !== attachmentInput && target !== documentInput) return;
      event.stopImmediatePropagation();
      const files = [...(target.files || [])];
      target.value = '';
      void addAttachmentsNonBlocking(files, target === documentInput ? 'document' : 'media');
    }, true);

    window.addEventListener('resize', closeAttachmentMenu, { passive: true });
    window.visualViewport?.addEventListener('resize', closeAttachmentMenu, { passive: true });
  }

  function insertTextareaLineBreak(textarea) {
    const start = Number.isInteger(textarea.selectionStart) ? textarea.selectionStart : textarea.value.length;
    const end = Number.isInteger(textarea.selectionEnd) ? textarea.selectionEnd : start;
    textarea.setRangeText('\n', start, end, 'end');
    textarea.dispatchEvent(typeof InputEvent === 'function'
      ? new InputEvent('input', { bubbles: true, inputType: 'insertLineBreak', data: null })
      : new Event('input', { bubbles: true }));
  }

  function insertContentEditableLineBreak(editor) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) return;
    range.deleteContents();
    const br = document.createElement('br');
    range.insertNode(br);
    range.setStartAfter(br);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    editor.dispatchEvent(typeof InputEvent === 'function'
      ? new InputEvent('input', { bubbles: true, inputType: 'insertLineBreak', data: null })
      : new Event('input', { bubbles: true }));
  }

  function installLineBreakAndFormattingRepair() {
    const installOnEditor = () => {
      const textarea = form.querySelector('[data-ios-message-input]');
      if (textarea && !textarea.dataset.yachatLineBreakRepair) {
        textarea.dataset.yachatLineBreakRepair = 'true';
        textarea.addEventListener('beforeinput', (event) => {
          if (!['insertParagraph', 'insertLineBreak'].includes(event.inputType)) return;
          event.preventDefault();
          insertTextareaLineBreak(textarea);
        });
        const refreshSelection = () => window.setTimeout(() => {
          textarea.dispatchEvent(new Event('select', { bubbles: true }));
        }, 35);
        textarea.addEventListener('touchend', refreshSelection, { passive: true });
        textarea.addEventListener('pointerup', refreshSelection, { passive: true });
        textarea.addEventListener('keyup', (event) => {
          if (event.shiftKey || ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) refreshSelection();
        });
      }

      const editor = form.querySelector('[data-rich-message-editor]');
      if (editor && !editor.dataset.yachatLineBreakRepair) {
        editor.dataset.yachatLineBreakRepair = 'true';
        editor.addEventListener('beforeinput', (event) => {
          if (!['insertParagraph', 'insertLineBreak'].includes(event.inputType)) return;
          event.preventDefault();
          insertContentEditableLineBreak(editor);
        });
      }
    };

    installOnEditor();
    new MutationObserver(installOnEditor).observe(form, { childList: true, subtree: true });
  }

  function mergeDeliveredMessage(messages, delivered) {
    if (!delivered?.id) return Array.isArray(messages) ? messages : [];
    const byId = new Map((Array.isArray(messages) ? messages : []).map((message) => [message.id, message]));
    byId.set(delivered.id, { ...(byId.get(delivered.id) || {}), ...delivered });
    return [...byId.values()].sort((left, right) => (
      new Date(left?.createdAt || 0).getTime() - new Date(right?.createdAt || 0).getTime()
    ));
  }

  function updateChatPreview(chat, message) {
    if (!chat || !message) return;
    chat.lastAt = message.createdAt || new Date().toISOString();
    chat.lastMessage = message.text || (message.attachments?.[0]?.kind === 'image' ? 'Фото' : 'Файл');
  }

  function installDeliveryRepair() {
    if (typeof deliverTransientMessage !== 'function') return;
    deliverTransientMessage = async function deliverTransientMessageFinal(chat, message) {
      if (!chat || !message || !yachatApi?.messenger?.send) return false;
      message.deliveryStatus = 'sending';
      setTransientMessage(chat.id, message);
      if (state.activeChatId === chat.id) renderMessages();

      try {
        const result = await yachatApi.messenger.send({
          chatId: chat.id,
          clientMessageId: message.id,
          text: message.text,
          formattedHtml: message.formattedHtml || '',
          attachments: message.attachments,
          replyToMessageId: message.replyToMessageId || null
        });
        removeTransientMessage(chat.id, message.id);
        if (Array.isArray(result?.chats)) state.chats = result.chats;
        else updateChatPreview(chat, result?.message || message);

        if (state.activeChatId === chat.id) {
          if (Array.isArray(result?.messages)) state.messages = result.messages;
          else if (result?.message) state.messages = mergeDeliveredMessage(state.messages, result.message);
          else state.messages = mergeDeliveredMessage(state.messages, { ...message, clientOnly: false, deliveryStatus: 'sent' });
          renderActiveChat();
          renderMessages();
        }
        renderChatList();
        scheduleHistoryWrite();
        return true;
      } catch (error) {
        message.deliveryStatus = 'failed';
        setTransientMessage(chat.id, message);
        if (state.activeChatId === chat.id) renderMessages();
        window.yachatFeedback?.show?.(String(error?.message || 'Не удалось отправить сообщение.'), {
          tone: 'error', icon: 'circle-alert', duration: 3200
        });
        return false;
      }
    };
  }

  installComposerLayout();
  new MutationObserver(installComposerLayout).observe(form, { childList: true, subtree: true });
  installHistoryCache();
  installAttachmentPipeline();
  installLineBreakAndFormattingRepair();
  installDeliveryRepair();
})();
