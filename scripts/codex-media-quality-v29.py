from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MEDIA = ROOT / "src" / "renderer" / "assets" / "media-emoji-upgrade.js"
APP = ROOT / "src" / "renderer" / "app.js"
API = ROOT / "api" / "index.py"
INDEX = ROOT / "src" / "renderer" / "index.html"


def regex_once(source: str, pattern: str, replacement: str, label: str, flags: int = 0) -> str:
    result, count = re.subn(pattern, replacement, source, count=1, flags=flags)
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, got {count}")
    return result


def replace_once(source: str, old: str, new: str, label: str) -> str:
    count = source.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, got {count}")
    return source.replace(old, new, 1)


media = MEDIA.read_text("utf-8")
media = replace_once(
    media,
    "  let mediaQueue = Promise.resolve();\n",
    '''  let mediaQueue = Promise.resolve();\n  const PHOTO_PACKAGE_BUDGET_BYTES = 7_500_000;\n  const PHOTO_SINGLE_TARGET_BYTES = 2_250_000;\n  const PHOTO_ORIGINAL_FALLBACK_BYTES = 5_800_000;\n  const PHOTO_MAX_SIDE = 3000;\n  const PHOTO_MAX_PIXELS = 14_000_000;\n  const PHOTO_PROCESS_TIMEOUT_MS = 18_000;\n''',
    "media constants",
)

new_encoder = r'''  function yieldToBrowser() {
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

'''
media = regex_once(
    media,
    r'''  async function encodePhotoWithoutBlocking\(file\) \{.*?\n  \}\n\n  function updateSendAvailability''',
    new_encoder + "  function updateSendAvailability",
    "photo encoder",
    re.S,
)

app = APP.read_text("utf-8")
new_crop = r'''function cropToDataUrl(source, crop = {}) {
  const image = crop.image;
  if (!image) return "";

  const sourceWidth = Math.max(1, image.naturalWidth || image.width || 1);
  const sourceHeight = Math.max(1, image.naturalHeight || image.height || 1);
  const naturalSide = Math.max(256, Math.min(sourceWidth, sourceHeight));
  const side = Math.min(1600, naturalSide);
  const canvas = document.createElement("canvas");
  canvas.width = side;
  canvas.height = side;
  const context = canvas.getContext("2d", { alpha: true });
  if (!context) return "";
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  const zoom = clamp(Number(crop.zoom) || 1, 1, 3);
  const scale = Math.max(side / sourceWidth, side / sourceHeight) * zoom;
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  const maxX = Math.max(0, (width - side) / 2);
  const maxY = Math.max(0, (height - side) / 2);
  const offsetX = clamp(Number(crop.x) || 0, -1, 1) * maxX;
  const offsetY = clamp(Number(crop.y) || 0, -1, 1) * maxY;
  context.drawImage(image, (side - width) / 2 + offsetX, (side - height) / 2 + offsetY, width, height);
  return canvas.toDataURL("image/webp", 0.96);
}
'''
app = regex_once(
    app,
    r'''function cropToDataUrl\(source, crop = \{\}\) \{.*?\n\}\n\nfunction closeAvatarCrop''',
    new_crop + "\nfunction closeAvatarCrop",
    "avatar crop quality",
    re.S,
)

api = API.read_text("utf-8")
api = replace_once(
    api,
    '''    if len(raw_code) != 6 or not any(character.isalpha() for character in raw_code) or not any(character.isdigit() for character in raw_code):\n        raise HTTPException(status_code=400, detail="Enter the complete six-character code.")''',
    '''    if not re.fullmatch(r"(?:[A-ZА-Я]{2}\\d{4}|[A-ZА-Я]{3}\\d{3})", raw_code):\n        raise HTTPException(status_code=400, detail="Enter the complete six-character code.")''',
    "strict device code format",
)

index = INDEX.read_text("utf-8")
index = index.replace(">Войти по QR-коду<", ">Войти по коду<")
index = index.replace("<h1>Вход по QR-коду</h1>", "<h1>Вход по коду</h1>")
index = index.replace("<p data-qr-status>Создаём код входа для нового устройства</p>", "<p data-qr-status>Введите код с другого устройства</p>")

for marker in (
    "PHOTO_PACKAGE_BUDGET_BYTES",
    "yieldToBrowser",
    "Math.sqrt(PHOTO_MAX_PIXELS",
    'canvas.toDataURL("image/webp", 0.96)',
):
    if marker not in (media + app):
        raise RuntimeError(f"missing media marker: {marker}")

MEDIA.write_text(media, "utf-8")
APP.write_text(app, "utf-8")
API.write_text(api, "utf-8")
INDEX.write_text(index, "utf-8")
