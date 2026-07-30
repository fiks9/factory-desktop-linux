"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ICNS_SIZES = new Map([
  ["ic04", 16],
  ["ic11", 32],
  ["ic12", 64],
  ["ic07", 128],
  ["ic08", 256],
  ["ic13", 256],
  ["ic09", 512],
  ["ic14", 512],
  ["ic10", 1024],
]);

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readPngDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 57 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("PNG signature or structure is invalid");
  }
  let offset = 8;
  let dimensions = null;
  let idat = false;
  let ended = false;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > buffer.length) throw new Error("PNG chunk exceeds file bounds");
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = buffer.readUInt32BE(offset + 8 + length);
    const actualCrc = crc32(Buffer.concat([Buffer.from(type, "ascii"), data]));
    if (expectedCrc !== actualCrc) throw new Error(`PNG ${type} chunk CRC is invalid`);
    if (dimensions === null && type !== "IHDR") throw new Error("PNG IHDR must be the first chunk");
    if (type === "IHDR") {
      if (dimensions !== null || length !== 13) throw new Error("PNG IHDR chunk is invalid");
      const width = data.readUInt32BE(0);
      const height = data.readUInt32BE(4);
      if (width === 0 || height === 0) throw new Error("PNG dimensions are invalid");
      dimensions = { width, height };
    } else if (type === "IDAT") {
      idat = true;
    } else if (type === "IEND") {
      if (length !== 0 || end !== buffer.length) throw new Error("PNG IEND chunk is invalid");
      ended = true;
      break;
    }
    offset = end;
  }
  if (dimensions === null || !idat || !ended) throw new Error("PNG is missing required chunks");
  return dimensions;
}

function readIcnsEntries(source) {
  const metadata = fs.lstatSync(source);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 16) {
    throw new Error("ICNS source must be a non-empty regular file");
  }
  const buffer = fs.readFileSync(source);
  if (buffer.subarray(0, 4).toString("ascii") !== "icns") throw new Error("ICNS magic is invalid");
  const totalSize = buffer.readUInt32BE(4);
  if (totalSize !== buffer.length) throw new Error("ICNS declared size does not match the file");
  const entries = [];
  let offset = 8;
  while (offset < totalSize) {
    if (offset + 8 > totalSize) throw new Error("ICNS entry header exceeds file bounds");
    const type = buffer.subarray(offset, offset + 4).toString("ascii");
    const entrySize = buffer.readUInt32BE(offset + 4);
    if (entrySize < 8 || offset + entrySize > totalSize) throw new Error("ICNS entry exceeds file bounds");
    entries.push({ type, data: buffer.subarray(offset + 8, offset + entrySize) });
    offset += entrySize;
  }
  return entries;
}

function extractPngIconFromIcns(source, output, targetSize = 512) {
  if (!Number.isInteger(targetSize) || targetSize <= 0) throw new Error("Icon target size is invalid");
  const candidates = [];
  for (const entry of readIcnsEntries(source)) {
    if (ICNS_SIZES.get(entry.type) !== targetSize || !entry.data.subarray(0, 8).equals(PNG_SIGNATURE)) continue;
    const dimensions = readPngDimensions(entry.data);
    if (dimensions.width === targetSize && dimensions.height === targetSize) {
      candidates.push({ ...entry, ...dimensions });
    }
  }
  if (candidates.length === 0) throw new Error(`ICNS does not contain a valid ${targetSize}x${targetSize} PNG icon`);
  candidates.sort((left, right) => left.data.length - right.data.length);
  const selected = candidates[0];
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o755 });
  const temporary = `${output}.partial-${process.pid}`;
  try {
    const descriptor = fs.openSync(temporary, "wx", 0o644);
    try {
      fs.writeFileSync(descriptor, selected.data);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, output);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  fs.chmodSync(output, 0o644);
  return {
    path: output,
    width: selected.width,
    height: selected.height,
    sha256: crypto.createHash("sha256").update(selected.data).digest("hex"),
  };
}

module.exports = { extractPngIconFromIcns, readPngDimensions };
