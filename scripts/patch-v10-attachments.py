from pathlib import Path

p=Path("src/renderer/app.js")
s=p.read_text(encoding="utf-8")
a=s.index("function readAttachmentFile(file) {")
b=s.index("\nasync function loadMessenger",a)
new=r'''function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(t("errSendMessage")));
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsDataURL(file);
  });
}

async function encodePhotoAttachment(file) {
  const url = URL.createObjectURL(file);
  try {
    const image = await loadImageElement(url);
    const spoiled = file.size > PHOTO_RULE_LIMIT_BYTES;
    const limit = spoiled ? 1280 : PHOTO_OUTPUT_MAX_SIDE;
    const scale = Math.min(1, limit / Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round((image.naturalWidth || image.width) * scale));
    canvas.height = Math.max(1, Math.round((image.naturalHeight || image.height) * scale));
    const context = canvas.getContext("2d");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const png = file.type === "image/png" && !spoiled && file.size <= 2.5 * 1024 * 1024;
    let dataUrl = canvas.toDataURL(png ? "image/png" : "image/jpeg", spoiled ? 0.68 : 0.86);
    if (!png && dataUrl.length > 4200000) dataUrl = canvas.toDataURL("image/jpeg", spoiled ? 0.56 : 0.72);
    return { dataUrl, spoiled };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function readAttachmentFile(file, mode = "media") {
  if (!file) throw new Error(t("errSendMessage"));
  const mime = file.type || "application/octet-stream";
  const documentMode = mode === "document";
  if ((documentMode || !mime.startsWith("image/")) && file.size > DOCUMENT_TRANSPORT_LIMIT_BYTES) throw new Error(t("attachLimit"));
  const encoded = !documentMode && mime.startsWith("image/")
    ? await encodePhotoAttachment(file)
    : { dataUrl: await readFileAsDataUrl(file), spoiled: false };
  return {
    id: globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `att-${Date.now()}-${Math.random()}`,
    name: file.name || "file", mime, size: file.size, originalSize: file.size,
    kind: documentMode ? "file" : mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : "file",
    sendAsDocument: documentMode, spoiled: encoded.spoiled, dataUrl: encoded.dataUrl
  };
}

function attachmentTypeLabel(item) {
  if (item.sendAsDocument || item.kind === "file") return t("attachmentDocument");
  return t(item.kind === "video" ? "attachmentVideo" : "attachmentPhoto");
}

function renderAttachmentTray() {
  if (!attachmentTray) return;
  const visible = state.pendingAttachments.length > 0;
  attachmentTray.hidden = !visible;
  if (attachmentPolicy) {
    attachmentPolicy.hidden = !visible;
    attachmentPolicy.innerHTML = visible ? `<strong>${escapeHtml(t("attachmentPolicyTitle"))}</strong> ${escapeHtml(t("attachmentPolicyText"))}` : "";
  }
  attachmentTray.innerHTML = state.pendingAttachments.map((item) => {
    const photo = item.kind === "image" && !item.sendAsDocument;
    const video = item.kind === "video" && !item.sendAsDocument;
    const preview = photo ? `<img src="${escapeHtml(item.dataUrl)}" alt="" />`
      : video ? `<video src="${escapeHtml(item.dataUrl)}" muted playsinline></video>` : iconSvg("file-text");
    return `<article class="attachment-preview${item.sendAsDocument ? " is-document" : ""}">
      <button class="attachment-preview-delete" type="button" data-remove-attachment="${escapeHtml(item.id)}" aria-label="${escapeHtml(t("menuDelete"))}">${iconSvg("trash")}</button>
      <div class="attachment-preview-media">${preview}</div>
      <button class="attachment-preview-remove" type="button" data-remove-attachment="${escapeHtml(item.id)}" aria-label="${escapeHtml(t("cancel"))}">${iconSvg("x")}</button>
      <div class="attachment-preview-copy"><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(attachmentTypeLabel(item))} · ${escapeHtml(formatFileSize(item.size))}</small></div>
    </article>`;
  }).join("");
  const chat = getActiveChat();
  if (sendButton) sendButton.disabled = !canSendToChat(chat) || (!messageInput.value.trim() && !visible);
}

async function addAttachments(files, mode = "media") {
  if (!canSendToChat(getActiveChat())) return;
  const selected = [...(files || [])].slice(0, 8 - state.pendingAttachments.length);
  try {
    const next = await Promise.all(selected.map((file) => readAttachmentFile(file, mode)));
    state.pendingAttachments = [...state.pendingAttachments, ...next].slice(0, 8);
    renderAttachmentTray();
  } catch (error) {
    showActionFeedback(translatedServerMessage(error.message, "errSendMessage"), { tone: "error", icon: "circle-alert", duration: 4200 });
  } finally {
    [attachmentInput, documentInput].forEach((input) => { if (input) input.value = ""; });
  }
}
'''
p.write_text(s[:a]+new+s[b:],encoding="utf-8")
