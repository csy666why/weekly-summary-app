"use strict";
/**
 * 用户表情包收藏：data/stickers.json
 * 每个空间可收藏自己上传/外部添加的表情图（图片存于 data/images，这里记录引用）。
 */
const fs = require("fs");
const path = require("path");
const DATA_DIR = process.env.WEEKLY_DATA_DIR ? path.resolve(process.env.WEEKLY_DATA_DIR) : path.join(__dirname, "..", "data");
const FILE = path.join(DATA_DIR, "stickers.json");
let cache = null;
function ensureDir() { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); }
function persist() { ensureDir(); fs.writeFileSync(FILE, JSON.stringify(cache, null, 2), "utf8"); }
function load() {
  if (cache) return cache;
  cache = { stickers: [] };
  if (fs.existsSync(FILE)) {
    try { const j = JSON.parse(fs.readFileSync(FILE, "utf8")); if (Array.isArray(j.stickers)) cache.stickers = j.stickers; } catch (_) {}
  }
  return cache;
}
function list(spaceId) { return load().stickers.filter((s) => s.spaceId === spaceId); }
function add(spaceId, imageId, name) {
  load();
  const s = { id: "st" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), spaceId, imageId, name: String(name || "表情").slice(0, 50), createdAt: new Date().toISOString() };
  cache.stickers.push(s);
  persist();
  return s;
}
function remove(spaceId, id) {
  load();
  const before = cache.stickers.length;
  cache.stickers = cache.stickers.filter((x) => !(x.id === id && x.spaceId === spaceId));
  if (cache.stickers.length !== before) { persist(); return true; }
  return false;
}
function reload() { cache = null; }
module.exports = { list, add, remove, reload };
