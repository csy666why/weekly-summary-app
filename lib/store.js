"use strict";
/**
 * 数据存储：data/summaries.json
 * - 每份周小结属于一个数据空间（spaceId），不同空间互不可见
 * - 原子写入；按字段/板块合并，多设备同时编辑互不干扰
 * - 板块支持 type：text 文本 / daily 每日完成情况 / checklist 清单
 */
const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.WEEKLY_DATA_DIR ? path.resolve(process.env.WEEKLY_DATA_DIR) : path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "summaries.json");
const SEED_FILE = path.join(DATA_DIR, "seed.json");

let cache = null;
let writeTimer = null;
let pending = false;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function nowISO() {
  return new Date().toISOString();
}

function defaultSections() {
  const now = nowISO();
  return [
    { id: "s-" + Date.now() + "-1", title: "（一）工作内容", content: "", type: "text", updatedAt: now },
    { id: "s-" + Date.now() + "-2", title: "（二）收获与体会", content: "", type: "text", updatedAt: now },
    { id: "s-" + Date.now() + "-3", title: "（三）下周计划", content: "", type: "text", updatedAt: now }
  ];
}

function newId() {
  return "w" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function load() {
  ensureDir();
  if (cache) return cache;
  try {
    if (fs.existsSync(DATA_FILE)) {
      cache = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      if (!Array.isArray(cache)) cache = [];
      for (const s of cache) {
        if (!Array.isArray(s.images)) s.images = [];
        for (const sec of s.sections || []) if (!sec.type) sec.type = "text";
      }
    } else if (fs.existsSync(SEED_FILE)) {
      cache = JSON.parse(fs.readFileSync(SEED_FILE, "utf8"));
      if (!Array.isArray(cache)) cache = [];
      for (const s of cache) {
        if (!Array.isArray(s.images)) s.images = [];
        for (const sec of s.sections || []) {
          if (!sec.updatedAt) sec.updatedAt = s.updatedAt || nowISO();
          if (!sec.type) sec.type = "text";
        }
      }
      persistNow();
    } else {
      cache = [];
      persistNow();
    }
  } catch (e) {
    console.error("[store] 读取数据失败，已重置为空列表:", e.message);
    cache = [];
  }
  return cache;
}

function persistNow() {
  ensureDir();
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), "utf8");
  fs.renameSync(tmp, DATA_FILE);
  pending = false;
}

function schedulePersist() {
  if (pending) return;
  pending = true;
  clearTimeout(writeTimer);
  writeTimer = setTimeout(persistNow, 300);
}

function list(spaceId) {
  const arr = load();
  return arr
    .filter((s) => !spaceId || s.spaceId === spaceId)
    .slice()
    .sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1))
    .map((s) => ({
      id: s.id,
      title: s.title || "",
      week: s.week || "",
      dateRange: s.dateRange || "",
      sectionCount: (s.sections || []).length,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt
    }));
}

function get(id, spaceId) {
  const s = load().find((x) => x.id === id);
  if (!s) return null;
  if (spaceId && s.spaceId !== spaceId) return null;
  return s;
}

function create(data, spaceId) {
  const arr = load();
  const count = arr.filter((x) => x.spaceId === spaceId).length;
  const now = nowISO();
  // 新周小结默认从空画布开始（不再强制套用模版），用户可自由添加文本/每日/清单块
  const rawSections = (data && Array.isArray(data.sections)) ? data.sections : [];
  const summary = {
    id: newId(),
    spaceId: spaceId || "",
    title: (data && data.title) || "第" + (count + 1) + "周——周小结",
    week: (data && data.week) || "第" + (count + 1) + "周",
    dateRange: (data && data.dateRange) || "",
    topic: (data && data.topic) || "",
    sections: rawSections.map((x) => ({ id: x.id || newId(), title: x.title || "", content: x.content || "", type: x.type || "text", updatedAt: now })),
    notes: (data && data.notes) || "",
    images: [],
    titleAt: now, weekAt: now, dateRangeAt: now, topicAt: now, notesAt: now,
    createdAt: now,
    updatedAt: now
  };
  arr.push(summary);
  schedulePersist();
  return summary;
}

function update(id, data, spaceId) {
  const arr = load();
  const idx = arr.findIndex((s) => s.id === id && (!spaceId || s.spaceId === spaceId));
  if (idx < 0) return null;
  const s = arr[idx];
  const now = nowISO();
  const edited = (data && data.edited && typeof data.edited === "object") ? data.edited : null;
  const legacy = !edited;
  let changed = false;

  const scalar = (key, val) => {
    if (typeof val === "string" && (legacy || edited[key])) {
      if (s[key] !== val) { s[key] = val; s[key + "At"] = now; changed = true; }
    }
  };
  scalar("title", data && data.title);
  scalar("week", data && data.week);
  scalar("dateRange", data && data.dateRange);
  scalar("topic", data && data.topic);
  scalar("notes", data && data.notes);

  const incoming = Array.isArray(data && data.sections) ? data.sections : [];
  const editedSecs = (edited && edited.sections) || {};

  if (legacy) {
    const merged = incoming.map((x) => ({ id: x.id || newId(), title: x.title || "", content: x.content || "", type: x.type || "text", updatedAt: now }));
    const incomingIds = new Set(incoming.map((x) => x.id));
    for (const sec of s.sections) {
      if (!incomingIds.has(sec.id)) merged.push(sec);
    }
    s.sections = merged;
    changed = true;
  } else {
    if (Array.isArray(data.deletedSections) && data.deletedSections.length) {
      const del = new Set(data.deletedSections);
      const before = s.sections.length;
      s.sections = s.sections.filter((x) => !del.has(x.id));
      if (s.sections.length !== before) changed = true;
    }
    for (const sec of incoming) {
      if (!editedSecs[sec.id]) continue;
      const ex = s.sections.find((x) => x.id === sec.id);
      if (ex) {
        const newTitle = sec.title || "";
        const newContent = sec.content || "";
        const newType = sec.type || "text";
        if (ex.title !== newTitle || ex.content !== newContent || ex.type !== newType) {
          ex.title = newTitle;
          ex.content = newContent;
          ex.type = newType;
          ex.updatedAt = now;
          changed = true;
        }
      } else {
        s.sections.push({ id: sec.id, title: sec.title || "", content: sec.content || "", type: sec.type || "text", updatedAt: now });
        changed = true;
      }
    }
    if (edited.reorder) {
      const order = incoming.map((x) => x.id).filter((id) => s.sections.some((x) => x.id === id));
      const rest = s.sections.filter((x) => !order.includes(x.id));
      s.sections = [...order.map((id) => s.sections.find((x) => x.id === id)), ...rest];
      changed = true;
    }
  }

  if (changed) {
    s.updatedAt = now;
    schedulePersist();
  }
  return s;
}

function remove(id, spaceId) {
  const arr = load();
  const idx = arr.findIndex((s) => s.id === id && (!spaceId || s.spaceId === spaceId));
  if (idx < 0) return false;
  arr.splice(idx, 1);
  schedulePersist();
  return true;
}

function addImage(summaryId, img, spaceId) {
  const s = get(summaryId, spaceId);
  if (!s) return null;
  if (!Array.isArray(s.images)) s.images = [];
  s.images.push({ id: img.id, name: img.name || "图片", mime: img.mime, width: img.width || 400, height: img.height || 300, size: img.size || 0, uploadedAt: new Date().toISOString() });
  s.updatedAt = nowISO();
  schedulePersist();
  return s;
}

function removeImageFromAll(imgId, spaceId) {
  const arr = load();
  const affected = [];
  const token = "{{img:" + imgId + "}}";
  for (const s of arr) {
    if (spaceId && s.spaceId !== spaceId) continue;
    let changed = false;
    if (Array.isArray(s.images)) {
      const before = s.images.length;
      s.images = s.images.filter((x) => x.id !== imgId);
      if (s.images.length !== before) changed = true;
    }
    for (const sec of s.sections || []) {
      if (sec.content && sec.content.includes(token)) {
        sec.content = sec.content.split(token).join("").replace(/\n{3,}/g, "\n\n");
        changed = true;
      }
    }
    if (changed) { s.updatedAt = nowISO(); affected.push(s); }
  }
  if (affected.length) schedulePersist();
  return affected;
}

/** 该图片是否属于某空间（用于图片读取鉴权） */
function imageInSpace(imgId, spaceId) {
  return load().some((s) => s.spaceId === spaceId && Array.isArray(s.images) && s.images.some((x) => x.id === imgId));
}

/** 迁移：把没有 spaceId 的旧数据归入指定空间 */
function assignSpaceId(spaceId) {
  const arr = load();
  let changed = false;
  for (const s of arr) {
    if (!s.spaceId) { s.spaceId = spaceId; changed = true; }
  }
  if (changed) schedulePersist();
  return changed;
}

module.exports = { list, get, create, update, remove, addImage, removeImageFromAll, imageInSpace, assignSpaceId, defaultSections };
