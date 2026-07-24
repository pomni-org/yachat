(() => {
"use strict";
const TRIGGER_SELECTOR = "[data-avatar-view], [data-photo-view], [data-video-view]";
const ATTACHMENT_TRIGGER_SELECTOR = "[data-photo-view], [data-video-view]";
const MIN_SCALE = 1;
const MAX_SCALE = 6;
const SWIPE_THRESHOLD = 62;
let layer = null;
let stage = null;
let image = null;
let video = null;
let count = null;
let downloadButton = null;
let downloadSpacer = null;
let hint = null;
let previousBodyOverflow = "";
let previousHtmlOverflow = "";
let lastTrigger = null;
let items = [];
let activeIndex = 0;
let activeMedia = null;
let scale = 1;
let translateX = 0;
let translateY = 0;
let gesture = null;
let lastTapAt = 0;
function escapeAttribute(value) {
if (typeof escapeHtml === "function") return escapeHtml(String(value || ""));
return String(value || "")
.replaceAll("&", "&amp;")
.replaceAll('"', "&quot;")
.replaceAll("<", "&lt;")
.replaceAll(">", "&gt;");
}
function icon(name) {
if (typeof iconSvg === "function") return iconSvg(name);
const paths = {
download: '<path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14" />',
expand: '<path d="M8 3H3v5m13-5h5v5M8 21H3v-5m13 5h5v-5" />',
file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" />'
};
return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.file}</svg>`;
}
function parseBackgroundImage(value) {
const match = String(value || "").match(/^url\(["']?(.*?)["']?\)$/i);
return match?.[1] || "";
}
function sourceForTrigger(trigger) {
const explicit = String(
trigger?.dataset?.avatarSrc ||
trigger?.dataset?.photoSrc ||
trigger?.dataset?.videoSrc ||
trigger?.dataset?.attachmentSrc ||
""
).trim();
if (explicit) return explicit;
const nested = trigger?.matches?.("img,video")
? trigger
: trigger?.querySelector?.("img,video") || trigger?.closest?.("figure")?.querySelector?.("img,video");
const source = nested?.currentSrc || nested?.src || "";
if (source) return source;
const candidates = [trigger, trigger?.firstElementChild].filter(Boolean);
for (const candidate of candidates) {
const background = parseBackgroundImage(getComputedStyle(candidate).backgroundImage);
if (background) return background;
}
return "";
}
function triggerKind(trigger) {
if (trigger?.hasAttribute?.("data-video-view")) return "video";
return "image";
}
function triggerTitle(trigger) {
return String(
trigger?.dataset?.attachmentName ||
trigger?.dataset?.avatarTitle ||
trigger?.dataset?.photoTitle ||
trigger?.dataset?.videoTitle ||
trigger?.dataset?.avatarText ||
(triggerKind(trigger) === "video" ? "Видео" : "Изображение")
).trim();
}
function itemFromTrigger(trigger) {
const source = sourceForTrigger(trigger);
if (!source) return null;
return {
trigger,
source,
kind: triggerKind(trigger),
title: triggerTitle(trigger),
name: String(trigger?.dataset?.attachmentName || triggerTitle(trigger) || "attachment").trim(),
downloadable: trigger?.matches?.(ATTACHMENT_TRIGGER_SELECTOR) || false
};
}
function collectionForTrigger(trigger) {
const current = itemFromTrigger(trigger);
if (!current) return [];
if (!current.downloadable) return [current];
const scope = trigger.closest("[data-message-id]") || document;
const mediaItems = [...scope.querySelectorAll(ATTACHMENT_TRIGGER_SELECTOR)]
.map(itemFromTrigger)
.filter(Boolean);
return mediaItems.length ? mediaItems : [current];
}
function syncVisualViewport() {
if (!layer) return;
const viewport = window.visualViewport;
const height = Math.max(1, Math.round(viewport?.height || window.innerHeight || 1));
const width = Math.max(1, Math.round(viewport?.width || window.innerWidth || 1));
const left = Math.round(viewport?.offsetLeft || 0);
const top = Math.round(viewport?.offsetTop || 0);
layer.style.setProperty("--yachat-viewer-height", `${height}px`);
layer.style.setProperty("--yachat-viewer-width", `${width}px`);
layer.style.setProperty("--yachat-viewer-left", `${left}px`);
layer.style.setProperty("--yachat-viewer-top", `${top}px`);
constrainTransform();
applyTransform();
}
function ensureViewer() {
if (layer?.isConnected) return layer;
layer = document.createElement("section");
layer.className = "avatar-fullscreen-viewer";
layer.dataset.avatarFullscreen = "";
layer.hidden = true;
layer.setAttribute("role", "dialog");
layer.setAttribute("aria-modal", "true");
layer.setAttribute("aria-label", "Просмотр вложения");
layer.innerHTML = `
<header class="avatar-fullscreen-head">
<button class="avatar-fullscreen-close" type="button" data-avatar-fullscreen-close aria-label="Закрыть">
<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
</button>
<strong class="avatar-fullscreen-count">1/1</strong>
<button class="avatar-fullscreen-download" type="button" data-avatar-fullscreen-download aria-label="Скачать вложение" title="Скачать вложение">
${icon("download")}
</button>
<span class="avatar-fullscreen-head-spacer" aria-hidden="true"></span>
</header>
<div class="avatar-fullscreen-stage" data-avatar-fullscreen-stage>
<img class="avatar-fullscreen-image" alt="" draggable="false" />
<video class="avatar-fullscreen-video" controls playsinline preload="metadata" hidden></video>
<p class="avatar-fullscreen-hint">Разведите два пальца для увеличения</p>
</div>
`;
stage = layer.querySelector("[data-avatar-fullscreen-stage]");
image = layer.querySelector(".avatar-fullscreen-image");
video = layer.querySelector(".avatar-fullscreen-video");
count = layer.querySelector(".avatar-fullscreen-count");
downloadButton = layer.querySelector("[data-avatar-fullscreen-download]");
downloadSpacer = layer.querySelector(".avatar-fullscreen-head-spacer");
hint = layer.querySelector(".avatar-fullscreen-hint");
document.body.append(layer);
layer.addEventListener("click", (event) => {
if (event.target.closest("[data-avatar-fullscreen-close]")) {
event.preventDefault();
closeViewer();
return;
}
if (event.target.closest("[data-avatar-fullscreen-download]")) {
event.preventDefault();
void downloadActiveItem();
}
});
[image, video].forEach((media) => {
media.addEventListener("load", () => layer?.classList.add("is-media-ready"));
media.addEventListener("loadeddata", () => layer?.classList.add("is-media-ready"));
media.addEventListener("error", () => {
if (!layer?.hidden) closeViewer();
});
});
stage.addEventListener("touchstart", handleTouchStart, { passive: false });
stage.addEventListener("touchmove", handleTouchMove, { passive: false });
stage.addEventListener("touchend", handleTouchEnd, { passive: false });
stage.addEventListener("touchcancel", () => { gesture = null; }, { passive: true });
stage.addEventListener("dblclick", (event) => {
if (event.target.closest("video")) return;
event.preventDefault();
toggleZoom();
});
return layer;
}
function hideLegacyViewer() {
try {
if (typeof closeAvatarViewer === "function") closeAvatarViewer();
} catch {
// Старый просмотрщик не должен проступать под полноэкранным слоем.
}
document.querySelectorAll("[data-avatar-modal]").forEach((legacyLayer) => {
legacyLayer.hidden = true;
legacyLayer.setAttribute("aria-hidden", "true");
});
}
function resetTransform() {
scale = 1;
translateX = 0;
translateY = 0;
gesture = null;
applyTransform();
}
function activeElement() {
return activeMedia === "video" ? video : image;
}
function constrainTransform() {
if (!stage || scale <= 1) {
translateX = 0;
translateY = 0;
return;
}
const media = activeElement();
const stageRect = stage.getBoundingClientRect();
const sourceWidth = Math.max(1, media?.naturalWidth || media?.videoWidth || stageRect.width);
const sourceHeight = Math.max(1, media?.naturalHeight || media?.videoHeight || stageRect.height);
const fit = Math.min(stageRect.width / sourceWidth, stageRect.height / sourceHeight);
const baseWidth = sourceWidth * fit;
const baseHeight = sourceHeight * fit;
const maxX = Math.max(0, (baseWidth * scale - stageRect.width) / 2);
const maxY = Math.max(0, (baseHeight * scale - stageRect.height) / 2);
translateX = Math.min(maxX, Math.max(-maxX, translateX));
translateY = Math.min(maxY, Math.max(-maxY, translateY));
}
function applyTransform() {
const media = activeElement();
if (!media) return;
constrainTransform();
media.style.transform = `translate3d(${translateX}px, ${translateY}px, 0) scale(${scale})`;
media.style.cursor = scale > 1 ? "grab" : "default";
layer?.classList.toggle("is-zoomed", scale > 1.001);
}
function distance(first, second) {
return Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY);
}
function midpoint(first, second) {
return {
x: (first.clientX + second.clientX) / 2,
y: (first.clientY + second.clientY) / 2
};
}
function handleTouchStart(event) {
if (event.touches.length === 2) {
event.preventDefault();
const center = midpoint(event.touches[0], event.touches[1]);
gesture = {
type: "pinch",
startDistance: Math.max(1, distance(event.touches[0], event.touches[1])),
startScale: scale,
startX: translateX,
startY: translateY,
centerX: center.x,
centerY: center.y
};
hint?.classList.add("is-dismissed");
return;
}
if (event.touches.length !== 1 || event.target.closest("button")) return;
const touch = event.touches[0];
gesture = {
type: scale > 1 ? "pan" : "swipe",
startClientX: touch.clientX,
startClientY: touch.clientY,
startX: translateX,
startY: translateY,
moved: false,
targetWasVideo: Boolean(event.target.closest("video"))
};
}
function handleTouchMove(event) {
if (!gesture) return;
if (gesture.type === "pinch" && event.touches.length >= 2) {
event.preventDefault();
const nextDistance = Math.max(1, distance(event.touches[0], event.touches[1]));
scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, gesture.startScale * (nextDistance / gesture.startDistance)));
const center = midpoint(event.touches[0], event.touches[1]);
translateX = gesture.startX + (center.x - gesture.centerX);
translateY = gesture.startY + (center.y - gesture.centerY);
applyTransform();
return;
}
if (event.touches.length !== 1) return;
const touch = event.touches[0];
const dx = touch.clientX - gesture.startClientX;
const dy = touch.clientY - gesture.startClientY;
gesture.moved = gesture.moved || Math.abs(dx) > 4 || Math.abs(dy) > 4;
if (gesture.type === "pan") {
event.preventDefault();
translateX = gesture.startX + dx;
translateY = gesture.startY + dy;
applyTransform();
return;
}
if (gesture.type === "swipe" && !gesture.targetWasVideo && Math.abs(dx) > Math.abs(dy) + 8) {
event.preventDefault();
}
}
function handleTouchEnd(event) {
if (!gesture) return;
const completed = gesture;
gesture = null;
if (completed.type === "pinch") {
if (scale < 1.03) resetTransform();
else applyTransform();
return;
}
const touch = event.changedTouches?.[0];
if (!touch) return;
const dx = touch.clientX - completed.startClientX;
const dy = touch.clientY - completed.startClientY;
if (completed.type === "swipe" && !completed.targetWasVideo && Math.abs(dx) > SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy) * 1.25) {
showItem(activeIndex + (dx < 0 ? 1 : -1));
return;
}
if (!completed.moved && !completed.targetWasVideo) {
const now = Date.now();
if (now - lastTapAt < 330) {
toggleZoom();
lastTapAt = 0;
} else {
lastTapAt = now;
}
}
}
function toggleZoom() {
if (scale > 1.05) resetTransform();
else {
scale = 2.25;
translateX = 0;
translateY = 0;
hint?.classList.add("is-dismissed");
applyTransform();
}
}
function showItem(index) {
if (!items.length) return;
activeIndex = (index + items.length) % items.length;
const item = items[activeIndex];
activeMedia = item.kind;
resetTransform();
layer?.classList.remove("is-media-ready", "is-image", "is-video", "is-attachment");
layer?.classList.add(item.kind === "video" ? "is-video" : "is-image");
layer?.classList.toggle("is-attachment", item.downloadable);
if (count) count.textContent = `${activeIndex + 1}/${items.length}`;
const showDownload = Boolean(item.downloadable && item.source);
if (downloadButton) downloadButton.hidden = !showDownload;
if (downloadSpacer) downloadSpacer.hidden = showDownload;
if (item.kind === "video") {
image.hidden = true;
image.removeAttribute("src");
image.alt = "";
video.hidden = false;
video.setAttribute("aria-label", item.title || "Видео");
video.src = item.source;
video.load();
} else {
try { video.pause(); } catch {}
video.hidden = true;
video.removeAttribute("src");
video.removeAttribute("aria-label");
image.hidden = false;
image.alt = item.title || "Изображение";
image.src = item.source;
}
}
function openViewer(trigger) {
const nextItems = collectionForTrigger(trigger);
if (!nextItems.length) return false;
hideLegacyViewer();
ensureViewer();
syncVisualViewport();
lastTrigger = trigger;
items = nextItems;
const triggerSource = sourceForTrigger(trigger);
activeIndex = Math.max(0, items.findIndex((item) => item.trigger === trigger || item.source === triggerSource));
previousBodyOverflow = document.body.style.overflow;
previousHtmlOverflow = document.documentElement.style.overflow;
layer.classList.remove("is-visible", "is-media-ready", "is-zoomed");
layer.hidden = false;
layer.removeAttribute("aria-hidden");
hint?.classList.remove("is-dismissed");
showItem(activeIndex);
document.body.style.overflow = "hidden";
document.documentElement.style.overflow = "hidden";
document.body.classList.add("avatar-fullscreen-open");
document.documentElement.classList.add("avatar-fullscreen-open");
requestAnimationFrame(() => {
syncVisualViewport();
layer?.classList.add("is-visible");
layer?.querySelector("[data-avatar-fullscreen-close]")?.focus({ preventScroll: true });
});
return true;
}
function closeViewer() {
if (!layer || layer.hidden) return;
layer.classList.remove("is-visible", "is-media-ready", "is-image", "is-video", "is-attachment", "is-zoomed");
document.body.classList.remove("avatar-fullscreen-open");
document.documentElement.classList.remove("avatar-fullscreen-open");
document.body.style.overflow = previousBodyOverflow;
document.documentElement.style.overflow = previousHtmlOverflow;
try { video?.pause(); } catch {}
const trigger = lastTrigger;
lastTrigger = null;
items = [];
resetTransform();
window.setTimeout(() => {
if (!layer) return;
layer.hidden = true;
layer.setAttribute("aria-hidden", "true");
[
"--yachat-viewer-height",
"--yachat-viewer-width",
"--yachat-viewer-left",
"--yachat-viewer-top"
].forEach((property) => layer.style.removeProperty(property));
image?.removeAttribute("src");
if (image) image.alt = "";
video?.removeAttribute("src");
trigger?.focus?.({ preventScroll: true });
}, 150);
}
function safeFilename(value, fallback = "attachment") {
const cleaned = String(value || "")
.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_")
.trim()
.slice(0, 160);
return cleaned || fallback;
}
function extensionForSource(source, kind) {
const dataMime = String(source || "").match(/^data:([^;,]+)/i)?.[1] || "";
const mime = dataMime.toLowerCase();
if (mime.includes("jpeg")) return ".jpg";
if (mime.includes("png")) return ".png";
if (mime.includes("webp")) return ".webp";
if (mime.includes("gif")) return ".gif";
if (mime.includes("mp4")) return ".mp4";
if (mime.includes("webm")) return ".webm";
if (mime.includes("quicktime")) return ".mov";
return kind === "video" ? ".mp4" : "";
}
async function downloadSource(source, name, kind = "file") {
if (!source) return;
let filename = safeFilename(name, kind === "video" ? "video" : kind === "image" ? "photo" : "document");
if (!/\.[a-z0-9]{1,8}$/i.test(filename)) filename += extensionForSource(source, kind);
let href = source;
let objectUrl = "";
if (String(source).startsWith("data:")) {
try {
const blob = await fetch(source).then((response) => response.blob());
objectUrl = URL.createObjectURL(blob);
href = objectUrl;
} catch {
href = source;
}
}
const anchor = document.createElement("a");
anchor.href = href;
anchor.download = filename;
anchor.rel = "noopener";
anchor.style.display = "none";
document.body.append(anchor);
anchor.click();
anchor.remove();
if (objectUrl) window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
}
async function downloadActiveItem() {
const item = items[activeIndex];
if (!item?.downloadable) return;
await downloadSource(item.source, item.name, item.kind);
}
function patchAttachmentRendering() {
try {
attachmentInput?.setAttribute("accept", "image/*,video/*");
attachmentButton?.setAttribute("aria-label", state?.language === "en" ? "Add photo or video" : "Добавить фото или видео");
} catch {}
if (typeof renderAttachment !== "function") return;
renderAttachment = function renderDownloadableAttachment(attachment = {}) {
const rawName = String(attachment.name || "file");
const name = escapeAttribute(rawName);
const size = escapeAttribute(typeof formatFileSize === "function" ? formatFileSize(attachment.size) : String(attachment.size || ""));
const source = String(attachment.dataUrl || attachment.url || "");
const safeSource = escapeAttribute(source);
const kind = String(attachment.kind || "file");
if (kind === "image" && source) {
return `
<figure class="message-attachment is-image" data-photo-view data-photo-title="${name}" data-attachment-name="${name}" role="button" tabindex="0" aria-label="Открыть фото ${name}">
<img src="${safeSource}" alt="${name}" draggable="false" />
<figcaption>${name}</figcaption>
</figure>
`;
}
if (kind === "video" && source) {
return `
<figure class="message-attachment is-video">
<video src="${safeSource}" controls playsinline preload="metadata"></video>
<button class="message-attachment-open" type="button" data-video-view data-video-title="${name}" data-attachment-name="${name}" aria-label="Открыть видео ${name}" title="Открыть видео">
${icon("expand")}
</button>
<figcaption>${name}</figcaption>
</figure>
`;
}
return `
<div class="message-attachment is-file">
<span class="message-attachment-file-icon">${icon("file")}</span>
<span class="message-attachment-file-copy"><strong>${name}</strong><small>${size}</small></span>
${source ? `
<button class="message-attachment-download" type="button" data-attachment-direct-download data-attachment-src="${safeSource}" data-attachment-name="${name}" aria-label="Скачать ${name}" title="Скачать">
${icon("download")}
</button>
` : ""}
</div>
`;
};
try { renderMessages?.(); } catch {}
}
document.addEventListener("click", (event) => {
const directDownload = event.target.closest("[data-attachment-direct-download]");
if (directDownload) {
event.preventDefault();
event.stopImmediatePropagation();
void downloadSource(
directDownload.dataset.attachmentSrc || "",
directDownload.dataset.attachmentName || "document",
"file"
);
return;
}
const trigger = event.target.closest(TRIGGER_SELECTOR);
if (!trigger || event.target.closest("[data-avatar-fullscreen-close], [data-avatar-fullscreen-download]")) return;
if (trigger.matches("[data-video-view]") && event.target.closest("video")) return;
if (openViewer(trigger)) {
event.preventDefault();
event.stopImmediatePropagation();
}
}, true);
document.addEventListener("keydown", (event) => {
if (layer && !layer.hidden) {
if (event.key === "Escape") {
event.preventDefault();
event.stopImmediatePropagation();
closeViewer();
return;
}
if (event.key === "ArrowLeft" && items.length > 1) {
event.preventDefault();
showItem(activeIndex - 1);
return;
}
if (event.key === "ArrowRight" && items.length > 1) {
event.preventDefault();
showItem(activeIndex + 1);
return;
}
}
if ((event.key === "Enter" || event.key === " ") && event.target.closest(TRIGGER_SELECTOR)) {
if (openViewer(event.target.closest(TRIGGER_SELECTOR))) {
event.preventDefault();
event.stopImmediatePropagation();
}
}
}, true);
window.visualViewport?.addEventListener("resize", syncVisualViewport, { passive: true });
window.visualViewport?.addEventListener("scroll", syncVisualViewport, { passive: true });
window.addEventListener("resize", syncVisualViewport, { passive: true });
window.addEventListener("orientationchange", syncVisualViewport, { passive: true });
patchAttachmentRendering();
})();
