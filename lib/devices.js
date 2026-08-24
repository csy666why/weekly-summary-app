"use strict";
/**
 * 设备注册表：data/devices.json
 * 每台设备属于一个数据空间（spaceId）；空间成员通过「空间名+密码」加入。
 */
const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.WEEKLY_DATA_DIR ? path.resolve(process.env.WEEKLY_DATA_DIR) : path.join(__dirname, "..", "data");
const DEVICES_FILE = path.join(DATA_DIR, "devices.json");

let cache = null;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function persist() {
  ensureDir();
  const tmp = DEVICES_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ devices: cache }, null, 2), "utf8");
  fs.renameSync(tmp, DEVICES_FILE);
}

function load() {
  ensureDir();
  if (cache) return cache;
  try {
    if (fs.existsSync(DEVICES_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DEVICES_FILE, "utf8"));
      cache = Array.isArray(parsed.devices) ? parsed.devices : [];
    } else {
      cache = [];
      persist();
    }
  } catch (e) {
    console.error("[devices] 读取失败，已重置:", e.message);
    cache = [];
  }
  return cache;
}

function find(id) {
  return load().find((d) => d.id === id) || null;
}

function upsert(id, info) {
  const arr = load();
  let d = arr.find((x) => x.id === id);
  const now = new Date().toISOString();
  if (!d) {
    d = { id, name: (info && info.name) || "未知设备", device: (info && info.device) || "desktop", spaceId: (info && info.spaceId) || "", approved: false, owner: false, createdAt: now, approvedAt: null, lastSeen: now };
    arr.push(d);
    persist();
  } else {
    if (info && info.name) d.name = info.name;
    if (info && info.device) d.device = info.device;
    d.lastSeen = now;
    persist();
  }
  return d;
}

/** 是否已加入某空间（= 已获准使用） */
function hasSpace(id) {
  const d = find(id);
  return !!(d && d.spaceId);
}

function spaceOf(id) {
  const d = find(id);
  return (d && d.spaceId) || "";
}

/** 设备加入空间 */
function joinSpace(id, spaceId) {
  const d = find(id);
  if (!d) return false;
  d.spaceId = spaceId;
  d.approved = true;
  d.approvedAt = d.approvedAt || new Date().toISOString();
  persist();
  return true;
}

function isOwner(id) {
  const d = find(id);
  return !!(d && d.owner);
}

function setOwner(id) {
  const d = find(id);
  if (!d) return false;
  d.owner = true;
  d.approved = true;
  if (d.spaceId) d.approvedAt = d.approvedAt || new Date().toISOString();
  persist();
  return true;
}

/** 该空间内的所有设备 */
function bySpace(spaceId) {
  return load().filter((d) => d.spaceId === spaceId);
}

function remove(id) {
  const arr = load();
  const idx = arr.findIndex((x) => x.id === id);
  if (idx < 0) return false;
  arr.splice(idx, 1);
  persist();
  return true;
}

/** 第一个「已授权但还没空间」的设备（用于旧数据迁移） */
function firstApprovedWithoutSpace() {
  return load().find((d) => d.approved && !d.spaceId) || null;
}

function list() {
  return load().slice();
}

module.exports = { upsert, find, hasSpace, spaceOf, joinSpace, isOwner, setOwner, bySpace, remove, firstApprovedWithoutSpace, list };
