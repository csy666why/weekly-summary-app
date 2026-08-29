"use strict";
/**
 * 空间好友关系：data/friends.json
 * 好友是双向的：A 添加 B 后，B 也能看到 A。
 */
const fs = require("fs");
const path = require("path");
const DATA_DIR = process.env.WEEKLY_DATA_DIR ? path.resolve(process.env.WEEKLY_DATA_DIR) : path.join(__dirname, "..", "data");
const FILE = path.join(DATA_DIR, "friends.json");
let cache = null;

function ensureDir() { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); }
function persist() { ensureDir(); fs.writeFileSync(FILE, JSON.stringify(cache, null, 2), "utf8"); }
function load() {
  if (cache) return cache;
  cache = { friendships: [] };
  if (fs.existsSync(FILE)) {
    try {
      const j = JSON.parse(fs.readFileSync(FILE, "utf8"));
      if (Array.isArray(j.friendships)) cache.friendships = j.friendships;
    } catch (_) {}
  }
  return cache;
}
function pairKey(a, b) { return [String(a), String(b)].sort().join("|"); }
function areFriends(a, b) { return load().friendships.some((f) => f.key === pairKey(a, b)); }
function friendsOf(spaceId) {
  return load().friendships
    .filter((f) => f.a === spaceId || f.b === spaceId)
    .map((f) => (f.a === spaceId ? f.b : f.a));
}
function addFriend(a, b) {
  load();
  if (areFriends(a, b)) return false;
  cache.friendships.push({ a, b, key: pairKey(a, b), addedAt: new Date().toISOString() });
  persist();
  return true;
}
function removeFriend(a, b) {
  load();
  const k = pairKey(a, b);
  const before = cache.friendships.length;
  cache.friendships = cache.friendships.filter((f) => f.key !== k);
  if (cache.friendships.length !== before) { persist(); return true; }
  return false;
}

/* ---------- 好友申请 ---------- */
const REQUESTS_FILE = path.join(DATA_DIR, "friend-requests.json");
let reqCache = null;
function loadRequests() {
  if (reqCache) return reqCache;
  reqCache = { requests: [] };
  if (fs.existsSync(REQUESTS_FILE)) {
    try {
      const j = JSON.parse(fs.readFileSync(REQUESTS_FILE, "utf8"));
      if (Array.isArray(j.requests)) reqCache.requests = j.requests;
    } catch (_) {}
  }
  return reqCache;
}
function persistRequests() { ensureDir(); fs.writeFileSync(REQUESTS_FILE, JSON.stringify(reqCache, null, 2), "utf8"); }
function createRequest(from, to) {
  const all = loadRequests().requests;
  const existing = all.find((r) => r.status === "pending" && ((r.from === from && r.to === to) || (r.from === to && r.to === from)));
  if (existing) return existing;
  const r = { id: "fr" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), from, to, status: "pending", createdAt: new Date().toISOString() };
  all.push(r);
  persistRequests();
  return r;
}
function requestsOf(spaceId) {
  const all = loadRequests().requests;
  return {
    incoming: all.filter((r) => r.to === spaceId && r.status === "pending").sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    outgoing: all.filter((r) => r.from === spaceId && r.status === "pending").sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  };
}
function respondRequest(id, spaceId, accept) {
  const all = loadRequests().requests;
  const r = all.find((x) => x.id === id && x.to === spaceId);
  if (!r) return null;
  r.status = accept ? "accepted" : "rejected";
  r.respondedAt = new Date().toISOString();
  persistRequests();
  if (accept) addFriend(r.from, r.to);
  return r;
}
module.exports = { areFriends, friendsOf, addFriend, removeFriend, createRequest, requestsOf, respondRequest };