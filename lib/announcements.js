"use strict";
/**
 * 全局公告 / 通知：data/announcements.json
 * 任何已加入空间的用户都可发布；前端顶部滚动展示 + 通知面板长期显示。
 */
const fs = require("fs");
const path = require("path");
const DATA_DIR = process.env.WEEKLY_DATA_DIR ? path.resolve(process.env.WEEKLY_DATA_DIR) : path.join(__dirname, "..", "data");
const FILE = path.join(DATA_DIR, "announcements.json");
let cache = null;

function ensureDir() { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); }
function persist() { ensureDir(); fs.writeFileSync(FILE, JSON.stringify(cache, null, 2), "utf8"); }
function load() {
  if (cache) return cache;
  cache = { announcements: [] };
  if (fs.existsSync(FILE)) {
    try {
      const j = JSON.parse(fs.readFileSync(FILE, "utf8"));
      if (Array.isArray(j.announcements)) cache.announcements = j.announcements;
    } catch (_) {}
  }
  return cache;
}
function add({ from, fromName, content }) {
  load();
  const a = {
    id: "an" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    from: String(from || ""),
    fromName: String(fromName || "匿名"),
    content: String(content || "").slice(0, 500),
    createdAt: new Date().toISOString()
  };
  cache.announcements.push(a);
  if (cache.announcements.length > 100) cache.announcements = cache.announcements.slice(-100);
  persist();
  return a;
}
function list(limit) {
  load();
  const n = limit || 50;
  return cache.announcements.slice(-n);
}

function reload() { cache = null; }
module.exports = { reload, add, list };
