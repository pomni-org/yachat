(() => {
  "use strict";

  const LABELS = Object.freeze({
    photo: "📷 Фото",
    video: "📹 Видео",
    emoji: "😀 Эмодзи",
    attachments: "🗂️ Вложения"
  });

  function normalizedKind(attachment) {
    const kind = String(attachment?.kind || "").trim().toLowerCase();
    const mime = String(
      attachment?.mime
      || attachment?.type
      || attachment?.dataMime
      || ""
    ).trim().toLowerCase();
    if (kind === "image" || kind === "photo" || mime.startsWith("image/")) return "image";
    if (kind === "video" || kind === "movie" || mime.startsWith("video/")) return "video";
    return "file";
  }

  function attachmentPreview(attachments) {
    const items = Array.isArray(attachments) ? attachments.filter(Boolean) : [];
    if (!items.length) return "";
    const kinds = new Set(items.map(normalizedKind));
    if (kinds.size === 1 && kinds.has("image")) return LABELS.photo;
    if (kinds.size === 1 && kinds.has("video")) return LABELS.video;
    return LABELS.attachments;
  }

  function graphemes(text) {
    if (typeof Intl?.Segmenter === "function") {
      return Array.from(
        new Intl.Segmenter("ru", { granularity: "grapheme" }).segment(text),
        (entry) => entry.segment
      );
    }
    return Array.from(text);
  }

  function isSingleEmoji(text) {
    const segments = graphemes(String(text || "").trim());
    if (segments.length !== 1) return false;
    const segment = segments[0];
    return (
      /\p{Extended_Pictographic}/u.test(segment)
      || /^(?:\p{Regional_Indicator}){2}$/u.test(segment)
      || /^[0-9#*]\uFE0F?\u20E3$/u.test(segment)
    );
  }

  function text(message) {
    const attachmentText = attachmentPreview(message?.attachments);
    if (attachmentText) return attachmentText;
    const plain = String(message?.text || "").replace(/\u0000/g, "").trim();
    if (!plain) return "";
    return isSingleEmoji(plain) ? LABELS.emoji : plain;
  }

  window.yachatMessagePreview = Object.freeze({
    labels: LABELS,
    text,
    attachmentPreview,
    isSingleEmoji
  });

  document.addEventListener("DOMContentLoaded", () => {
    if (document.querySelector('script[data-personal-identity-loader]')) return;
    const script = document.createElement("script");
    script.src = "./assets/personal-identity.js";
    script.dataset.personalIdentityLoader = "true";
    document.head.appendChild(script);
  }, { once: true });
})();
