"use strict";
/**
 * 数据空间（多端隔离）：
 * 每个空间 = 一位用户的私有数据（周小结 + 图片）。
 * 设备通过「空间名 + 访问密码」加入空间；不同空间互不可见。
 * 文件：data/spaces.json
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = process.env.WEEKLY_DATA_DIR ? path.resolve(process.env.WEEKLY_DATA_DIR) : path.join(__dirname, "..", "data");
const SPACES_FILE = path.join(DATA_DIR, "spaces.json");

let cache = null;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function persist() {
  ensureDir();
  const tmp = SPACES_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ spaces: cache }, null, 2), "utf8");
  fs.renameSync(tmp, SPACES_FILE);
}

function load() {
  ensureDir();
  if (cache) return cache;
  try {
    if (fs.existsSync(SPACES_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(SPACES_FILE, "utf8"));
      cache = Array.isArray(parsed.spaces) ? parsed.spaces : [];
    } else {
      cache = [];
      persist();
    }
  } catch (e) {
    console.error("[spaces] 读取失败，已重置:", e.message);
    cache = [];
  }
  return cache;
}

function hashPin(pin) {
  return crypto.createHash("sha256").update(String(pin || "")).digest("hex");
}

function findByName(name) {
  const n = String(name || "").trim().toLowerCase();
  return load().find((s) => String(s.name || "").trim().toLowerCase() === n) || null;
}

function findById(id) {
  return load().find((s) => s.id === id) || null;
}

function create(name, ownerDeviceId, pin) {
  const arr = load();
  const space = {
    id: "sp" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: String(name || "").trim().slice(0, 30),
    pinHash: hashPin(pin),
    ownerDeviceId: ownerDeviceId || null,
    createdAt: new Date().toISOString()
  };
  arr.push(space);
  persist();
  return space;
}

function verifyPin(space, pin) {
  return !!(space && space.pinHash === hashPin(pin));
}

function setOwner(spaceId, deviceId) {
  const s = findById(spaceId);
  if (!s) return false;
  s.ownerDeviceId = deviceId;
  persist();
  return true;
}

function list() {
  return load().slice();
}

function any() {
  return load().length > 0;
}

function first() {
  return load()[0] || null;
}

module.exports = { findByName, findById, create, verifyPin, setOwner, list, any, first, hashPin };
