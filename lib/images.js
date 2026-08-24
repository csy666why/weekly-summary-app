"use strict";
/**
 * 图片文件存储：data/images/
 * 上传的图片以 <id>.<ext> 保存在本地，通过 id 引用（{{img:id}} 标记）。
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = process.env.WEEKLY_DATA_DIR ? path.resolve(process.env.WEEKLY_DATA_DIR) : path.join(__dirname, "..", "data");
const IMAGES_DIR = path.join(DATA_DIR, "images");

const MIME_EXT = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif"
};

const MAX_BYTES = 15 * 1024 * 1024;

function ensureDir() {
  if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });
}

function imagePath(id, ext) {
  return path.join(IMAGES_DIR, id + "." + ext);
}

/** 通过文件头判断真实图片格式 */
function validateMagic(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  const head = buf.toString("latin1", 0, 6);
  if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  if (buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

function saveImage({ data, mime, width, height, name }) {
  ensureDir();
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data || ""), "base64");
  if (!buf.length || buf.length < 20) throw new Error("图片数据无效");
  if (buf.length > MAX_BYTES) throw new Error("图片过大（超过 15MB）");
  const realMime = validateMagic(buf);
  if (realMime === "image/webp") throw new Error("WebP 图片请先另存为 PNG/JPG 后再上传");
  if (!realMime) throw new Error("不是有效的图片文件（仅支持 PNG / JPG / GIF）");
  const ext = MIME_EXT[realMime];
  const id = "img" + Date.now().toString(36) + crypto.randomBytes(4).toString("hex");
  fs.writeFileSync(imagePath(id, ext), buf);
  return {
    id,
    ext,
    mime: realMime,
    width: Math.max(1, parseInt(width, 10) || 400),
    height: Math.max(1, parseInt(height, 10) || 300),
    size: buf.length,
    name: String(name || "图片").slice(0, 120)
  };
}

function loadImage(id) {
  for (const [mime, ext] of Object.entries(MIME_EXT)) {
    const p = imagePath(id, ext);
    if (fs.existsSync(p)) {
      return { buffer: fs.readFileSync(p), mime };
    }
  }
  return null;
}

function deleteImage(id) {
  for (const ext of Object.values(MIME_EXT)) {
    const p = imagePath(id, ext);
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      return true;
    }
  }
  return false;
}

module.exports = { saveImage, loadImage, deleteImage, validateMagic, IMAGES_DIR, MIME_EXT };
