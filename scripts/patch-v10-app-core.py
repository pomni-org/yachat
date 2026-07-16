from pathlib import Path

p = Path("src/renderer/app.js")
s = p.read_text(encoding="utf-8")

def sw(old, new):
    global s
    if old not in s:
        raise SystemExit(f"missing: {old[:80]}")
    s = s.replace(old, new, 1)

sw('const TELEGRAM_BOT_URL = "https://t.me/code_yachatBot";', 'const TELEGRAM_BOT_URL = "https://t.me/code_yachatBot";\nconst PHOTO_RULE_LIMIT_BYTES = 20 * 1024 * 1024 * 1024;\nconst DOCUMENT_TRANSPORT_LIMIT_BYTES = 8 * 1024 * 1024;\nconst PHOTO_OUTPUT_MAX_SIDE = 2048;')
sw('''const attachmentButton = document.querySelector('[data-action="attach-file"]');
const attachmentInput = document.querySelector("[data-attachment-input]");
const stickersButton = document.querySelector('[data-action="open-stickers"]');
const attachmentTray = document.querySelector("[data-attachment-tray]");''', '''const attachmentButton = document.querySelector('[data-action="attach-file"]');
const attachmentInput = document.querySelector("[data-attachment-input]");
const documentButton = document.querySelector('[data-action="attach-document"]');
const documentInput = document.querySelector("[data-document-input]");
const stickersButton = document.querySelector('[data-action="open-stickers"]');
const attachmentTray = document.querySelector("[data-attachment-tray]");
const attachmentPolicy = document.querySelector("[data-attachment-policy]");''')
sw('    allChats: "Все",', '    allChats: "Чаты",')
sw('    attachLimit: "Файл слишком большой. Лимит 8 МБ.",', '''    attachLimit: "Этот файл пока нельзя отправить через сервер ЯЧата. Лимит документа — 8 МБ.",
    attachmentPhoto: "Фото",
    attachmentVideo: "Видео",
    attachmentDocument: "Документ без потерь",
    attachmentPolicyTitle: "Фото до 20 ГБ.",
    attachmentPolicyText: "Слишком большое фото ЯЧат уменьшит. Для исходного качества нажмите кнопку листика и отправьте его как документ.",''')
sw('    allChats: "All",', '    allChats: "Chats",')
sw('    attachLimit: "The file is too large. Limit is 8 MB.",', '''    attachLimit: "This file cannot yet pass through the YaChat server. Document limit is 8 MB.",
    attachmentPhoto: "Photo",
    attachmentVideo: "Video",
    attachmentDocument: "Lossless document",
    attachmentPolicyTitle: "Photos up to 20 GB.",
    attachmentPolicyText: "YaChat will reduce an oversized photo. Use the sheet button to send the original as a document.",''')
sw('function iconSvg(name, className = "lucide-icon") {\n  const body = ICONS[name] || ICONS.file;\n  return `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;\n}', 'function iconSvg(name, className = "iconoir-icon") {\n  const body = ICONS[name] || ICONS.file;\n  return `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" aria-hidden="true">${body}</svg>`;\n}')
sw('  [attachmentButton, stickersButton, attachmentInput].forEach((control) => {', '  [attachmentButton, documentButton, stickersButton, attachmentInput, documentInput].forEach((control) => {')
sw('''  const side = 256;
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");''', '''  const naturalSide = Math.max(256, Math.min(image.naturalWidth || image.width, image.naturalHeight || image.height));
  const side = Math.min(1024, naturalSide);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";''')
sw('  return canvas.toDataURL("image/jpeg", 0.9);', '  const outputType = String(source || "").startsWith("data:image/png") ? "image/png" : "image/jpeg";\n  return canvas.toDataURL(outputType, outputType === "image/jpeg" ? 0.97 : undefined);')
p.write_text(s, encoding="utf-8")
