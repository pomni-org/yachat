(() => {
  "use strict";

  if (window.__yachatComposerRegressionFixInstalled) return;
  window.__yachatComposerRegressionFixInstalled = true;

  const form = document.querySelector('[data-form="message"]');
  const transport = document.querySelector('[data-message-input]');
  const send = form?.querySelector('.send-button');
  if (!form || !transport || !send) return;

  const previewCache = new Map();
  let submittingExplicitly = false;
  let dispatchingSnapshot = false;

  function activeChat() {
    try {
      return typeof getActiveChat === 'function' ? getActiveChat() : null;
    } catch {
      return null;
    }
  }

  function canSend() {
    try {
      const chat = activeChat();
      return Boolean(chat && typeof canSendToChat === 'function' && canSendToChat(chat));
    } catch {
      return false;
    }
  }

  function visibleEditor() {
    return form.querySelector('[data-ios-message-input]')
      || form.querySelector('[data-rich-message-editor]')
      || transport;
  }

  function editorText(editor = visibleEditor()) {
    if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
      return String(editor.value || '');
    }
    return String(editor?.innerText || editor?.textContent || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\r/g, '');
  }

  function dispatchTransportInput() {
    transport.dispatchEvent(typeof InputEvent === 'function'
      ? new InputEvent('input', { bubbles: true, inputType: 'insertText', data: null })
      : new Event('input', { bubbles: true }));
  }

  function updateSendState() {
    let attachmentCount = 0;
    let editing = false;
    try {
      attachmentCount = Array.isArray(state?.pendingAttachments) ? state.pendingAttachments.length : 0;
      editing = Boolean(state?.editingMessageId);
    } catch {}
    const hasText = Boolean(String(transport.value || editorText()).trim());
    send.disabled = editing ? !hasText : !canSend() || (!hasText && attachmentCount === 0);
  }

  function syncTransport() {
    const editor = visibleEditor();
    const text = editorText(editor);
    if (editor !== transport && transport.value !== text) {
      transport.value = text;
      dispatchTransportInput();
    }
    updateSendState();
  }

  function makeSnapshotEvent() {
    if (typeof InputEvent === 'function') {
      try {
        return new InputEvent('beforeinput', {
          bubbles: true,
          cancelable: true,
          inputType: 'yachatSelectionSnapshot',
          data: null
        });
      } catch {}
    }
    const event = new Event('beforeinput', { bubbles: true, cancelable: true });
    try { Object.defineProperty(event, 'inputType', { value: 'yachatSelectionSnapshot' }); } catch {}
    return event;
  }

  // The previous repair manually inserted a newline and fought Safari's own selection model.
  // Let the browser perform the real edit, but first give the iOS formatter a harmless
  // beforeinput pass so it snapshots the current text and keeps formatting ranges aligned.
  form.addEventListener('beforeinput', (event) => {
    if (dispatchingSnapshot || !['insertParagraph', 'insertLineBreak'].includes(event.inputType)) return;
    const target = event.target;
    if (!(target instanceof HTMLTextAreaElement) && !target?.matches?.('[data-rich-message-editor]')) return;

    dispatchingSnapshot = true;
    try {
      target.dispatchEvent(makeSnapshotEvent());
    } finally {
      dispatchingSnapshot = false;
    }
    event.stopImmediatePropagation();
  }, true);

  const scheduleSync = () => queueMicrotask(syncTransport);
  form.addEventListener('input', scheduleSync, true);
  form.addEventListener('change', scheduleSync, true);
  form.addEventListener('compositionend', scheduleSync, true);
  send.addEventListener('pointerdown', syncTransport, true);
  send.addEventListener('touchstart', syncTransport, { capture: true, passive: true });

  // requestSubmit(send) always supplies the submitter. This avoids Safari occasionally
  // producing a submit without one, which the native iOS guard correctly rejected.
  send.addEventListener('click', (event) => {
    event.preventDefault();
    syncTransport();
    if (send.disabled || submittingExplicitly) return;

    submittingExplicitly = true;
    try {
      if (typeof form.requestSubmit === 'function') {
        form.requestSubmit(send);
      } else {
        const submitEvent = typeof SubmitEvent === 'function'
          ? new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: send })
          : new Event('submit', { bubbles: true, cancelable: true });
        form.dispatchEvent(submitEvent);
      }
    } finally {
      queueMicrotask(() => { submittingExplicitly = false; });
    }
  }, true);

  function previewText(message) {
    try {
      if (typeof messagePreviewText === 'function') return messagePreviewText(message);
    } catch {}
    const text = String(message?.text || '').trim();
    if (text) return text;
    const attachment = Array.isArray(message?.attachments) ? message.attachments[0] : null;
    if (attachment?.kind === 'image') return 'Фото';
    if (attachment?.kind === 'video') return 'Видео';
    return attachment ? 'Файл' : '';
  }

  function timeOf(value) {
    const result = new Date(value || 0).getTime();
    return Number.isFinite(result) ? result : 0;
  }

  function rememberPreview(chatId, message) {
    const id = String(chatId || message?.chatId || '');
    const text = previewText(message);
    if (!id || !text) return;
    const at = message?.createdAt || new Date().toISOString();
    const candidate = { id: String(message?.id || ''), text, at, time: timeOf(at) };
    const current = previewCache.get(id);
    if (!current || candidate.time >= current.time) previewCache.set(id, candidate);
  }

  function newestKnownMessage(chatId) {
    const messages = [];
    try {
      if (String(state?.activeChatId || '') === String(chatId) && Array.isArray(state?.messages)) {
        messages.push(...state.messages);
      }
      if (typeof transientMessagesForChat === 'function') messages.push(...transientMessagesForChat(chatId));
    } catch {}
    return messages.reduce((latest, message) => {
      if (!latest || timeOf(message?.createdAt) >= timeOf(latest?.createdAt)) return message;
      return latest;
    }, null);
  }

  function reconcilePreviews() {
    let chats = [];
    try { chats = Array.isArray(state?.chats) ? state.chats : []; } catch {}
    chats.forEach((chat) => {
      const id = String(chat?.id || '');
      if (!id) return;

      const remoteText = String(chat.lastMessage || '').trim();
      const remoteTime = timeOf(chat.lastAt);
      const cached = previewCache.get(id);
      if (remoteText && (!cached || remoteTime >= cached.time)) {
        previewCache.set(id, { id: '', text: remoteText, at: chat.lastAt, time: remoteTime });
      }

      const isActive = String(state?.activeChatId || '') === id;
      const newest = newestKnownMessage(id);
      if (newest) {
        rememberPreview(id, newest);
      } else if (isActive) {
        previewCache.delete(id);
        chat.lastMessage = '';
        chat.lastAt = '';
        return;
      }
      const preview = previewCache.get(id);
      if (!preview) return;

      const currentTime = timeOf(chat.lastAt);
      if (!chat.lastMessage || preview.time >= currentTime) {
        chat.lastMessage = preview.text;
        chat.lastAt = preview.at;
      }
    });
  }

  if (typeof setTransientMessage === 'function' && !setTransientMessage.__yachatPreviewRegressionFix) {
    const originalSetTransientMessage = setTransientMessage;
    const wrappedSetTransientMessage = function setTransientMessageWithPreview(chatId, message) {
      const result = originalSetTransientMessage.apply(this, arguments);
      rememberPreview(chatId, message);
      return result;
    };
    Object.defineProperty(wrappedSetTransientMessage, '__yachatPreviewRegressionFix', { value: true });
    setTransientMessage = wrappedSetTransientMessage;
  }

  if (typeof renderChatList === 'function' && !renderChatList.__yachatPreviewRegressionFix) {
    const originalRenderChatList = renderChatList;
    const wrappedRenderChatList = function renderChatListWithPreview(...args) {
      reconcilePreviews();
      return originalRenderChatList.apply(this, args);
    };
    Object.defineProperty(wrappedRenderChatList, '__yachatPreviewRegressionFix', { value: true });
    renderChatList = wrappedRenderChatList;
  }

  if (typeof deliverTransientMessage === 'function' && !deliverTransientMessage.__yachatPreviewRegressionFix) {
    const originalDeliverTransientMessage = deliverTransientMessage;
    const wrappedDeliverTransientMessage = async function deliverTransientMessageWithPreview(chat, message) {
      rememberPreview(chat?.id, message);
      reconcilePreviews();
      renderChatList?.();
      const delivered = await originalDeliverTransientMessage.apply(this, arguments);
      rememberPreview(chat?.id, message);
      reconcilePreviews();
      renderChatList?.();
      return delivered;
    };
    Object.defineProperty(wrappedDeliverTransientMessage, '__yachatPreviewRegressionFix', { value: true });
    deliverTransientMessage = wrappedDeliverTransientMessage;
  }

  updateSendState();
})();
