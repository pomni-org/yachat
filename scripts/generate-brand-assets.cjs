const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const BASE = 1254;
const RADIUS = 246;
const PNG_SIZES = [16, 32, 48, 64, 96, 128, 180, 192, 256, 512, 1024];
const MASKABLE_SIZES = [192, 512];
const LOGO_POLYGONS = require("./yachat-brand-contours.json");
const GRADIENT_GRID = require("./yachat-brand-gradient.json");
const GRADIENT_SIZE = Math.round(Math.sqrt(GRADIENT_GRID.length));

if (GRADIENT_SIZE * GRADIENT_SIZE !== GRADIENT_GRID.length) {
  throw new Error("Некорректная сетка градиента ЯЧата");
}

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    crc32.table = table;
  }
  let c = 0xffffffff;
  for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  typeBuf.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 8 + data.length);
  return out;
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    rgba.copy(raw, row + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from("\x89PNG\r\n\x1a\n", "binary"),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function gradientColor(nx, ny) {
  const u = clamp(nx) * (GRADIENT_SIZE - 1);
  const v = clamp(ny) * (GRADIENT_SIZE - 1);
  const x0 = Math.floor(u);
  const y0 = Math.floor(v);
  const x1 = Math.min(GRADIENT_SIZE - 1, x0 + 1);
  const y1 = Math.min(GRADIENT_SIZE - 1, y0 + 1);
  const tx = u - x0;
  const ty = v - y0;
  const c00 = GRADIENT_GRID[y0 * GRADIENT_SIZE + x0];
  const c10 = GRADIENT_GRID[y0 * GRADIENT_SIZE + x1];
  const c01 = GRADIENT_GRID[y1 * GRADIENT_SIZE + x0];
  const c11 = GRADIENT_GRID[y1 * GRADIENT_SIZE + x1];
  return [0, 1, 2].map((channel) => Math.round(
    c00[channel] * (1 - tx) * (1 - ty)
    + c10[channel] * tx * (1 - ty)
    + c01[channel] * (1 - tx) * ty
    + c11[channel] * tx * ty
  ));
}

function rasterLogoMask(size) {
  const samples = size <= 64 ? 8 : size <= 256 ? 4 : 2;
  const superSize = size * samples;
  const scale = superSize / BASE;
  const supersampled = new Uint8Array(superSize * superSize);

  for (let y = 0; y < superSize; y++) {
    const sourceY = (y + 0.5) / scale;
    const intersections = [];

    for (const polygon of LOGO_POLYGONS) {
      for (let index = 0; index < polygon.length; index++) {
        const [x1, y1] = polygon[index];
        const [x2, y2] = polygon[(index + 1) % polygon.length];
        if ((y1 > sourceY) === (y2 > sourceY)) continue;
        intersections.push((x1 + ((sourceY - y1) * (x2 - x1)) / (y2 - y1)) * scale);
      }
    }

    intersections.sort((left, right) => left - right);
    for (let index = 0; index + 1 < intersections.length; index += 2) {
      const from = Math.max(0, Math.ceil(intersections[index] - 0.5));
      const to = Math.min(superSize - 1, Math.floor(intersections[index + 1] - 0.5));
      supersampled.fill(255, y * superSize + from, y * superSize + to + 1);
    }
  }

  const output = new Uint8Array(size * size);
  const sampleCount = samples * samples;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sum = 0;
      for (let sy = 0; sy < samples; sy++) {
        const row = (y * samples + sy) * superSize + x * samples;
        for (let sx = 0; sx < samples; sx++) sum += supersampled[row + sx];
      }
      output[y * size + x] = Math.round(sum / sampleCount);
    }
  }

  return output;
}

function roundedCoverage(x, y, size) {
  const samples = size <= 64 ? 8 : 4;
  const radius = RADIUS / BASE * size;
  let inside = 0;

  for (let sy = 0; sy < samples; sy++) {
    for (let sx = 0; sx < samples; sx++) {
      const px = x + (sx + 0.5) / samples;
      const py = y + (sy + 0.5) / samples;
      let accepted = true;
      if (px < radius && py < radius) accepted = Math.hypot(px - radius, py - radius) <= radius;
      else if (px > size - radius && py < radius) accepted = Math.hypot(px - (size - radius), py - radius) <= radius;
      else if (px < radius && py > size - radius) accepted = Math.hypot(px - radius, py - (size - radius)) <= radius;
      else if (px > size - radius && py > size - radius) accepted = Math.hypot(px - (size - radius), py - (size - radius)) <= radius;
      if (accepted) inside++;
    }
  }

  return inside / (samples * samples);
}

function render(size, variant) {
  const rgba = Buffer.alloc(size * size * 4);
  const logo = rasterLogoMask(size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const index = (y * size + x) * 4;
      const logoAlpha = logo[y * size + x] / 255;

      if (variant === "light" || variant === "dark" || variant === "notification") {
        const value = variant === "dark" ? 0 : 255;
        rgba[index] = value;
        rgba[index + 1] = value;
        rgba[index + 2] = value;
        rgba[index + 3] = Math.round(logoAlpha * 255);
        continue;
      }

      const backgroundAlpha = variant === "square" ? 1 : roundedCoverage(x, y, size);
      const [r, g, b] = gradientColor((x + 0.5) / size, (y + 0.5) / size);
      const outputAlpha = backgroundAlpha + logoAlpha * (1 - backgroundAlpha);
      if (outputAlpha <= 0) continue;

      rgba[index] = Math.round((r * backgroundAlpha * (1 - logoAlpha) + 255 * logoAlpha) / outputAlpha);
      rgba[index + 1] = Math.round((g * backgroundAlpha * (1 - logoAlpha) + 255 * logoAlpha) / outputAlpha);
      rgba[index + 2] = Math.round((b * backgroundAlpha * (1 - logoAlpha) + 255 * logoAlpha) / outputAlpha);
      rgba[index + 3] = Math.round(outputAlpha * 255);
    }
  }

  return encodePng(size, size, rgba);
}

function encodeIco(images) {
  const count = images.length;
  const header = Buffer.alloc(6 + count * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);
  let offset = header.length;

  images.forEach(({ size, png }, index) => {
    const position = 6 + index * 16;
    header[position] = size >= 256 ? 0 : size;
    header[position + 1] = size >= 256 ? 0 : size;
    header.writeUInt16LE(1, position + 4);
    header.writeUInt16LE(32, position + 6);
    header.writeUInt32LE(png.length, position + 8);
    header.writeUInt32LE(offset, position + 12);
    offset += png.length;
  });

  return Buffer.concat([header, ...images.map((item) => item.png)]);
}

function ensureDir(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function write(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, data);
}

function svg(fileName, viewBox = 1024) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewBox} ${viewBox}" role="img" aria-label="ЯЧат"><title>ЯЧат</title><image width="${viewBox}" height="${viewBox}" href="${fileName}"/></svg>\n`;
}

function generate(outputDir) {
  ensureDir(outputDir);
  const rendererDir = path.dirname(outputDir);
  const cache = new Map();
  const get = (size, variant) => {
    const key = `${size}:${variant}`;
    if (!cache.has(key)) cache.set(key, render(size, variant));
    return cache.get(key);
  };

  const roundedBySize = new Map(PNG_SIZES.map((size) => [size, get(size, "rounded")]));
  const squareBySize = new Map(MASKABLE_SIZES.map((size) => [size, get(size, "square")]));
  const rounded1024 = roundedBySize.get(1024);
  const square1024 = get(1024, "square");
  const light1024 = get(1024, "light");
  const dark1024 = get(1024, "dark");
  const notification96 = get(96, "notification");
  const writeAsset = (name, data) => write(path.join(outputDir, name), data);
  const nearestRounded = (size) => roundedBySize.get(size)
    || roundedBySize.get(size <= 24 ? 16 : size <= 40 ? 32 : size <= 56 ? 48 : size <= 80 ? 64 : size <= 112 ? 96 : size <= 154 ? 128 : size <= 186 ? 180 : size <= 224 ? 192 : size <= 384 ? 256 : size <= 768 ? 512 : 1024);

  writeAsset("yachat-brand-source.svg", svg("yachat-brand-rounded.png"));
  writeAsset("yachat-brand.svg", svg("yachat-brand-rounded.png"));
  writeAsset("yachat-brand-square.svg", svg("yachat-brand-square.png"));
  writeAsset("yachat-brand-light.svg", svg("yachat-brand-light.png"));
  writeAsset("yachat-brand-dark.svg", svg("yachat-brand-dark.png"));

  for (const size of PNG_SIZES) writeAsset(`yachat-brand-${size}.png`, roundedBySize.get(size));
  for (const size of MASKABLE_SIZES) writeAsset(`yachat-brand-maskable-${size}.png`, squareBySize.get(size));
  writeAsset("yachat-brand-rounded.png", rounded1024);
  writeAsset("yachat-brand-square.png", square1024);
  writeAsset("yachat-brand-light.png", light1024);
  writeAsset("yachat-brand-dark.png", dark1024);
  writeAsset("yachat-brand-notification.png", notification96);

  const roundedAliases = {
    "apple-touch-icon.png": 180,
    "apple-touch-icon-v2.png": 180,
    "yachat-app-icon-192.png": 192,
    "yachat-app-icon-512.png": 512,
    "yachat-app-icon-1024.png": 1024,
    "yachat-app-icon-v2-192.png": 192,
    "yachat-app-icon-v2-512.png": 512,
    "yachat-app-icon-v2-1024.png": 1024,
    "yachat-color-rounded.png": 1024,
    "yachat-favicon-16.png": 16,
    "yachat-favicon-32.png": 32,
    "yachat-favicon-48.png": 48,
    "yachat-favicon-64.png": 64,
    "yachat-favicon-128.png": 128,
    "yachat-favicon-256.png": 256,
    "yachat-favicon-v2-16.png": 16,
    "yachat-favicon-v2-32.png": 32,
    "yachat-favicon-v2-48.png": 48,
    "yachat-favicon-v2-256.png": 256,
    "yachat-shortcut-16.png": 16,
    "yachat-shortcut-32.png": 32,
    "yachat-shortcut-48.png": 48,
    "yachat-shortcut-64.png": 64,
    "yachat-shortcut-96.png": 96,
    "yachat-shortcut-128.png": 128,
    "yachat-shortcut-180.png": 180,
    "yachat-shortcut-192.png": 192,
    "yachat-shortcut-256.png": 256,
    "yachat-shortcut-512.png": 512,
    "yachat-shortcut-1024.png": 1024
  };
  for (const [name, size] of Object.entries(roundedAliases)) writeAsset(name, nearestRounded(size));

  const squareAliases = {
    "yachat-app-icon-maskable-192.png": 192,
    "yachat-app-icon-maskable-512.png": 512,
    "yachat-app-icon-v2-maskable-192.png": 192,
    "yachat-app-icon-v2-maskable-512.png": 512,
    "yachat-shortcut-maskable-192.png": 192,
    "yachat-shortcut-maskable-512.png": 512
  };
  for (const [name, size] of Object.entries(squareAliases)) writeAsset(name, squareBySize.get(size));

  writeAsset("yachat-color-square.png", square1024);
  writeAsset("yachat-icon-square.png", square1024);
  writeAsset("yachat-logo-LIGHT.png", light1024);
  writeAsset("yachat-logo-light.png", light1024);
  writeAsset("yachat-logo-DARK.png", dark1024);
  writeAsset("yachat-logo-dark.png", dark1024);
  writeAsset("yachat-icon-mark.png", notification96);
  writeAsset("yachat-notification-mark.png", notification96);

  writeAsset("yachat-avatar.svg", svg("yachat-color-rounded.png"));
  writeAsset("yachat-color-square.svg", svg("yachat-color-square.png"));
  writeAsset("yachat-favicon.svg", svg("yachat-favicon-256.png", 256));
  writeAsset("yachat-icon.svg", svg("yachat-color-rounded.png"));
  writeAsset("yachat-logo-light.svg", svg("yachat-logo-light.png"));
  writeAsset("yachat-logo-dark.svg", svg("yachat-logo-dark.png"));
  writeAsset("yachat-notification-mark.svg", svg("yachat-notification-mark.png", 96));
  writeAsset("yachat-shortcut.svg", svg("yachat-shortcut-1024.png"));

  const icoSizes = [16, 32, 48, 64, 128, 256];
  const ico = encodeIco(icoSizes.map((size) => ({ size, png: nearestRounded(size) })));
  writeAsset("yachat-brand.ico", ico);
  writeAsset("yachat.ico", ico);
  write(path.join(rendererDir, "favicon.ico"), ico);
  write(path.join(rendererDir, "favicon-v2.ico"), ico);
  write(path.join(rendererDir, "favicon-v3.ico"), ico);
}

if (require.main === module) {
  const projectRoot = path.resolve(__dirname, "..");
  const target = process.argv[2] ? path.resolve(process.argv[2]) : path.join(projectRoot, "src", "renderer", "assets");
  generate(target);
}

module.exports = { generate };
