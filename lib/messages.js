"use strict";
/**
 * 空间间聊天消息：data/messages.json
 * 消息是两个人空间之间的，保存在双方都可访问的存储里。
 */
const fs = require("fs");
const path = require("path");
const DATA_DIR = process.env.WEEKLY_DATA_DIR ? path.resolve(process.env.WEEKLY_DATA_DIR) : path.join(__dirname, "..", "data");
const FILE = path.join(DATA_DIR, "messages.json");
const MAX_PER_CONVO = 500;
let cache = null;

function ensureDir() { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); }
function persist() { ensureDir(); fs.writeFileSync(FILE, JSON.stringify(cache, null, 2), "utf8"); }
function load() {
  if (cache) return cache;
  cache = { messages: [] };
  if (fs.existsSync(FILE)) {
    try {
      const j = JSON.parse(fs.readFileSync(FILE, "utf8"));
      if (Array.isArray(j.messages)) cache.messages = j.messages;
    } catch (_) {}
  }
  return cache;
}
function newId() { return "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function pairKey(a, b) { return [String(a), String(b)].sort().join("|"); }
function list(a, b) {
  return load().messages
    .filter((m) => (m.from === a && m.to === b) || (m.from === b && m.to === a))
    .sort((x, y) => (x.createdAt < y.createdAt ? -1 : 1));
}
function listAll() { return load().messages; }
function add({ from, to, type, content, imageId }) {
  load();
  const m = {
    id: newId(),
    from: String(from),
    to: String(to),
    type: type === "image" ? "image" : "text",
    content: type === "image" ? "" : String(content || ""),
    imageId: imageId || "",
    createdAt: new Date().toISOString(),
    read: false
  };
  cache.messages.push(m);
  // 限制每条会话最多保留 MAX_PER_CONVO 条
  const k = pairKey(from, to);
  const conv = cache.messages.filter((m2) => pairKey(m2.from, m2.to) === k);
  if (conv.length > MAX_PER_CONVO) {
    const excess = conv.length - MAX_PER_CONVO;
    const drop = new Set(conv.slice(0, excess).map((m2) => m2.id));
    cache.messages = cache.messages.filter((m2) => !drop.has(m2.id));
  }
  persist();
  return m;
}
function markRead(a, b) {
  load();
  let changed = false;
  for (const m of cache.messages) {
    if (m.from === b && m.to === a && !m.read) { m.read = true; changed = true; }
  }
  if (changed) persist();
  return changed;
}
function unreadCount(spaceId) {
  return load().messages.filter((m) => m.to === spaceId && !m.read).length;
}
function clearConversation(a, b) {
  load();
  const k = pairKey(a, b);
  const before = cache.messages.length;
  cache.messages = cache.messages.filter((m) => pairKey(m.from, m.to) !== k);
  if (cache.messages.length !== before) { persist(); return true; }
  return false;
}
module.exports = { list, listAll, add, markRead, unreadCount, clearConversation };