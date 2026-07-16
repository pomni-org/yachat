const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const BASE = 1254;
const COLOR_SIZE = 64;
const LOGO_POLYGONS = require("./yachat-brand-contours.json");
const PNG_SIZES = [16, 32, 48, 64, 96, 128, 180, 192, 256, 512, 1024];
const MASKABLE_SIZES = [192, 512];

function readZlibBase64(name, expected) {
  const encoded = fs.readFileSync(path.join(__dirname, name), "utf8").replace(/\s+/g, "");
  const decoded = zlib.inflateSync(Buffer.from(encoded, "base64"));
  if (decoded.length !== expected) throw new Error(`${name}: expected ${expected} bytes, got ${decoded.length}`);
  return decoded;
}

const ROUNDED_ALPHA = readZlibBase64("yachat-brand-rounded-alpha.base64", BASE * BASE);
const COLOR_GRID = readZlibBase64("yachat-brand-color-grid.base64", COLOR_SIZE * COLOR_SIZE * 3);

function crc32(buffer) {
  let table = crc32.table;
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let value = n;
      for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      table[n] = value >>> 0;
    }
    crc32.table = table;
  }
  let value = 0xffffffff;
  for (const byte of buffer) value = table[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  typeBuffer.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return output;
}

function encodePng(width, height, rgba) {
  const rowLength = width * 4;
  const raw = Buffer.alloc((rowLength + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (rowLength + 1);
    rgba.copy(raw, row + 1, y * rowLength, (y + 1) * rowLength);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from("\x89PNG\r\n\x1a\n", "binary"),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function colorAt(nx, ny) {
  const x = Math.max(0, Math.min(COLOR_SIZE - 1, nx * (COLOR_SIZE - 1)));
  const y = Math.max(0, Math.min(COLOR_SIZE - 1, ny * (COLOR_SIZE - 1)));
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(COLOR_SIZE - 1, x0 + 1), y1 = Math.min(COLOR_SIZE - 1, y0 + 1);
  const tx = x - x0, ty = y - y0;
  const pixel = (px, py, channel) => COLOR_GRID[(py * COLOR_SIZE + px) * 3 + channel];
  return [0, 1, 2].map(channel => Math.round(
    pixel(x0, y0, channel) * (1 - tx) * (1 - ty)
    + pixel(x1, y0, channel) * tx * (1 - ty)
    + pixel(x0, y1, channel) * (1 - tx) * ty
    + pixel(x1, y1, channel) * tx * ty
  ));
}

function axisWeights(sourceSize, destinationSize) {
  const scale = sourceSize / destinationSize;
  return Array.from({ length: destinationSize }, (_, index) => {
    const start = index * scale, end = (index + 1) * scale;
    const values = [];
    for (let source = Math.floor(start); source < Math.ceil(end); source += 1) {
      const weight = Math.max(0, Math.min(end, source + 1) - Math.max(start, source));
      if (weight) values.push([Math.min(sourceSize - 1, source), weight]);
    }
    return values;
  });
}

function resizeMask(mask, size) {
  const xWeights = axisWeights(BASE, size), yWeights = axisWeights(BASE, size);
  const output = new Uint8Array(size * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let sum = 0, total = 0;
      for (const [sourceY, wy] of yWeights[y]) {
        for (const [sourceX, wx] of xWeights[x]) {
          const weight = wx * wy;
          sum += mask[sourceY * BASE + sourceX] * weight;
          total += weight;
        }
      }
      output[y * size + x] = Math.round(sum / total);
    }
  }
  return output;
}

function rasterLogoMask(size, supersample = 4) {
  const highSize = size * supersample;
  const high = new Uint8Array(highSize * highSize);
  const scale = highSize / BASE;
  const polygons = LOGO_POLYGONS.map(polygon => polygon.map(([x, y]) => [x * scale, y * scale]));
  for (let y = 0; y < highSize; y += 1) {
    const scanY = y + 0.5;
    const intersections = [];
    for (const polygon of polygons) {
      for (let i = 0, previous = polygon.length - 1; i < polygon.length; previous = i, i += 1) {
        const [x1, y1] = polygon[i], [x2, y2] = polygon[previous];
        if ((y1 > scanY) !== (y2 > scanY)) intersections.push(x1 + (scanY - y1) * (x2 - x1) / (y2 - y1));
      }
    }
    intersections.sort((a, b) => a - b);
    for (let i = 0; i + 1 < intersections.length; i += 2) {
      const start = Math.max(0, Math.ceil(intersections[i] - 0.5));
      const end = Math.min(highSize - 1, Math.floor(intersections[i + 1] - 0.5));
      for (let x = start; x <= end; x += 1) high[y * highSize + x] = 255;
    }
  }
  const output = new Uint8Array(size * size);
  const area = supersample * supersample;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let sum = 0;
      for (let sy = 0; sy < supersample; sy += 1) {
        const row = (y * supersample + sy) * highSize + x * supersample;
        for (let sx = 0; sx < supersample; sx += 1) sum += high[row + sx];
      }
      output[y * size + x] = Math.round(sum / area);
    }
  }
  return output;
}

function render(size, variant) {
  const rgba = Buffer.alloc(size * size * 4);
  const logo = rasterLogoMask(size, size <= 64 ? 6 : 4);
  const rounded = variant === "rounded" ? resizeMask(ROUNDED_ALPHA, size) : null;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      const logoAlpha = logo[y * size + x] / 255;
      if (variant === "light" || variant === "dark" || variant === "notification") {
        const value = variant === "dark" ? 0 : 255;
        rgba[offset] = value;
        rgba[offset + 1] = value;
        rgba[offset + 2] = value;
        rgba[offset + 3] = Math.round(logoAlpha * 255);
        continue;
      }
      const backgroundAlpha = variant === "square" ? 1 : rounded[y * size + x] / 255;
      if (!backgroundAlpha) continue;
      const [red, green, blue] = colorAt((x + 0.5) / size, (y + 0.5) / size);
      rgba[offset] = Math.round(red * (1 - logoAlpha) + 255 * logoAlpha);
      rgba[offset + 1] = Math.round(green * (1 - logoAlpha) + 255 * logoAlpha);
      rgba[offset + 2] = Math.round(blue * (1 - logoAlpha) + 255 * logoAlpha);
      rgba[offset + 3] = Math.round(backgroundAlpha * 255);
    }
  }
  return encodePng(size, size, rgba);
}

function encodeIco(images) {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
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
  return Buffer.concat([header, ...images.map(image => image.png)]);
}

function svg(fileName, viewBox = 1024) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewBox} ${viewBox}" role="img" aria-label="ЯЧат"><title>ЯЧат</title><image width="${viewBox}" height="${viewBox}" href="${fileName}"/></svg>\n`;
}

function generate(outputDirectory) {
  fs.mkdirSync(outputDirectory, { recursive: true });
  const rendererDirectory = path.dirname(outputDirectory);
  const cache = new Map();
  const get = (size, variant) => {
    const key = `${size}:${variant}`;
    if (!cache.has(key)) cache.set(key, render(size, variant));
    return cache.get(key);
  };
  const rounded = new Map(PNG_SIZES.map(size => [size, get(size, "rounded")]));
  const square = new Map(MASKABLE_SIZES.map(size => [size, get(size, "square")]));
  const write = (name, data, directory = outputDirectory) => fs.writeFileSync(path.join(directory, name), data);
  const nearest = size => rounded.get(size) || rounded.get(size <= 24 ? 16 : size <= 40 ? 32 : size <= 56 ? 48 : size <= 80 ? 64 : size <= 112 ? 96 : size <= 154 ? 128 : size <= 186 ? 180 : size <= 224 ? 192 : size <= 384 ? 256 : size <= 768 ? 512 : 1024);
  const rounded1024 = rounded.get(1024), square1024 = get(1024, "square");
  const light1024 = get(1024, "light"), dark1024 = get(1024, "dark"), notification96 = get(96, "notification");

  write("yachat-brand-source.svg", svg("yachat-color-rounded.png"));
  write("yachat-brand.svg", svg("yachat-brand-rounded.png"));
  write("yachat-brand-square.svg", svg("yachat-brand-square.png"));
  write("yachat-brand-light.svg", svg("yachat-brand-light.png"));
  write("yachat-brand-dark.svg", svg("yachat-brand-dark.png"));
  for (const size of PNG_SIZES) write(`yachat-brand-${size}.png`, rounded.get(size));
  for (const size of MASKABLE_SIZES) write(`yachat-brand-maskable-${size}.png`, square.get(size));
  write("yachat-brand-rounded.png", rounded1024);
  write("yachat-brand-square.png", square1024);
  write("yachat-brand-light.png", light1024);
  write("yachat-brand-dark.png", dark1024);
  write("yachat-brand-notification.png", notification96);

  const roundedAliases = {
    "apple-touch-icon.png": 180, "apple-touch-icon-v2.png": 180,
    "yachat-app-icon-192.png": 192, "yachat-app-icon-512.png": 512, "yachat-app-icon-1024.png": 1024,
    "yachat-app-icon-v2-192.png": 192, "yachat-app-icon-v2-512.png": 512, "yachat-app-icon-v2-1024.png": 1024,
    "yachat-color-rounded.png": 1024,
    "yachat-favicon-16.png": 16, "yachat-favicon-32.png": 32, "yachat-favicon-48.png": 48,
    "yachat-favicon-64.png": 64, "yachat-favicon-128.png": 128, "yachat-favicon-256.png": 256,
    "yachat-favicon-v2-16.png": 16, "yachat-favicon-v2-32.png": 32, "yachat-favicon-v2-48.png": 48, "yachat-favicon-v2-256.png": 256,
    "yachat-shortcut-16.png": 16, "yachat-shortcut-32.png": 32, "yachat-shortcut-48.png": 48,
    "yachat-shortcut-64.png": 64, "yachat-shortcut-96.png": 96, "yachat-shortcut-128.png": 128,
    "yachat-shortcut-180.png": 180, "yachat-shortcut-192.png": 192, "yachat-shortcut-256.png": 256,
    "yachat-shortcut-512.png": 512, "yachat-shortcut-1024.png": 1024
  };
  for (const [name, size] of Object.entries(roundedAliases)) write(name, nearest(size));

  const squareAliases = {
    "yachat-app-icon-maskable-192.png": 192, "yachat-app-icon-maskable-512.png": 512,
    "yachat-app-icon-v2-maskable-192.png": 192, "yachat-app-icon-v2-maskable-512.png": 512,
    "yachat-shortcut-maskable-192.png": 192, "yachat-shortcut-maskable-512.png": 512
  };
  for (const [name, size] of Object.entries(squareAliases)) write(name, square.get(size));

  write("yachat-color-square.png", square1024);
  write("yachat-icon-square.png", square1024);
  write("yachat-logo-LIGHT.png", light1024);
  write("yachat-logo-light.png", light1024);
  write("yachat-logo-DARK.png", dark1024);
  write("yachat-logo-dark.png", dark1024);
  write("yachat-icon-mark.png", notification96);
  write("yachat-notification-mark.png", notification96);
  write("yachat-avatar.svg", svg("yachat-color-rounded.png"));
  write("yachat-color-square.svg", svg("yachat-color-square.png"));
  write("yachat-favicon.svg", svg("yachat-favicon-256.png", 256));
  write("yachat-icon.svg", svg("yachat-color-rounded.png"));
  write("yachat-logo-light.svg", svg("yachat-logo-light.png"));
  write("yachat-logo-dark.svg", svg("yachat-logo-dark.png"));
  write("yachat-notification-mark.svg", svg("yachat-notification-mark.png", 96));
  write("yachat-shortcut.svg", svg("yachat-shortcut-1024.png"));

  const ico = encodeIco([16, 32, 48, 64, 128, 256].map(size => ({ size, png: nearest(size) })));
  write("yachat-brand.ico", ico);
  write("yachat.ico", ico);
  write("favicon.ico", ico, rendererDirectory);
  write("favicon-v2.ico", ico, rendererDirectory);
  write("favicon-v3.ico", ico, rendererDirectory);
}

if (require.main === module) {
  const root = path.resolve(__dirname, "..");
  const target = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, "src", "renderer", "assets");
  generate(target);
  console.log(`Generated YaChat brand assets in ${target}`);
}

module.exports = { generate };
