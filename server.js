"use strict";
/**
// v1.0 部署测试
 * 每周小结助手 - 主服务
 * - 静态站点 + REST API + WebSocket 实时同步
 * - 数据空间隔离：设备通过「空间名+密码」加入空间，不同空间互不可见
 * - AI 流式生成 / Word 导出（内嵌图片）/ 图片库
 * - 云端适配：PORT 环境变量、BASE_URL 配置
 */
const path = require("path");
const os = require("os");
const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");

const configLib = require("./lib/config");
const store = require("./lib/store");
const devices = require("./lib/devices");
const spaces = require("./lib/spaces");
const images = require("./lib/images");
const ai = require("./lib/ai");
const { exportDocx } = require("./lib/docx-exporter");
const QRCode = require("qrcode");
const friends = require("./lib/friends");
const messages = require("./lib/messages");
const announcements = require("./lib/announcements");

const PUBLIC_DIR = path.join(__dirname, "public");
const VERSION = "2.0.0";

/* ---------- 工具 ---------- */
function getLANIP() {
  const nets = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal) candidates.push(net.address);
    }
  }
  candidates.sort((a, b) => {
    const score = (ip) => (ip.startsWith("192.168.") ? 0 : ip.startsWith("10.") ? 1 : ip.startsWith("172.") ? 2 : 3);
    return score(a) - score(b);
  });
  return candidates[0] || "127.0.0.1";
}

function clientDevice(ua) {
  ua = ua || "";
  if (/Mobile|Android|iPhone|iPad|iPod/i.test(ua)) return "phone";
  return "desktop";
}

function briefUA(ua) {
  ua = ua || "";
  let m = ua.match(/Edg\/([\d.]+)/);
  if (m) return "Edge";
  m = ua.match(/Chrome\/([\d.]+)/);
  if (m) return "Chrome";
  m = ua.match(/Safari\/([\d.]+)/);
  if (m) return "Safari";
  m = ua.match(/Firefox\/([\d.]+)/);
  if (m) return "Firefox";
  if (/MicroMessenger/i.test(ua)) return "微信内置";
  return "浏览器";
}

function deviceLabel(ua, device) {
  return (device === "phone" ? "手机" : "电脑") + " · " + briefUA(ua);
}

function getDeviceId(req) {
  let v = (req.headers && req.headers["x-device-id"]) || "";
  if (!v && req.query && req.query.deviceId) v = req.query.deviceId;
  if (!v && req.url) {
    const m = String(req.url).match(/[?&]deviceId=([^&]+)/);
    if (m) { try { v = decodeURIComponent(m[1]); } catch (_) { v = m[1]; } }
  }
  return String(v).slice(0, 64);
}

function accessEnabled() {
  const cfg = configLib.loadConfig();
  return !!(cfg.access && cfg.access.enabled);
}

function allowNewSpaces() {
  const cfg = configLib.loadConfig();
  return !(cfg.access && cfg.access.allowNewSpaces === false);
}

/** 服务器管理员 = 第一个空间的创建者 */
function isSuperAdmin(deviceId) {
  if (!deviceId) return false;
  const sp = spaces.first();
  if (sp && sp.ownerDeviceId && sp.ownerDeviceId === deviceId) return true;
  const cfg = configLib.loadConfig();
  const list = (cfg && cfg.access && Array.isArray(cfg.access.adminDeviceIds)) ? cfg.access.adminDeviceIds : [];
  return list.indexOf(deviceId) >= 0;
}
function isServerAdmin(deviceId) {
  if (isSuperAdmin(deviceId)) return true;
  if (!deviceId) return false;
  const d = devices.find(deviceId);
  if (d && d.spaceId) {
    const sp = spaces.findById(d.spaceId);
    if (sp && sp.isAdmin && sp.ownerDeviceId === deviceId) return true;
  }
  return false;
}

/* ---------- App ---------- */
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

app.use(express.json({ limit: "25mb" }));
app.use(express.static(PUBLIC_DIR, {
  index: "index.html",
  extensions: ["html"],
  // 防缓存：HTML 每次强制重新获取；静态资源不缓存，配合 index.html 里的 ?v= 版本号使用
  setHeaders(res, filePath) {
    if (String(filePath).endsWith(".html")) {
      res.setHeader("Cache-Control", "no-store");
    } else {
      res.setHeader("Cache-Control", "no-cache");
    }
  }
}));

const clients = new Map(); // ws -> { id, deviceId, device, browser, spaceId, ua }

function isWsJoined(info) {
  return !!(info && info.deviceId && devices.spaceOf(info.deviceId));
}

function broadcast(obj, except, spaceId) {
  const msg = JSON.stringify(obj);
  for (const [ws, info] of clients) {
    if (ws === except) continue;
    if (ws.readyState !== ws.OPEN) continue;
    if (!isWsJoined(info)) continue;
    if (spaceId && devices.spaceOf(info.deviceId) !== spaceId) continue;
    ws.send(msg);
  }
}

function broadcastClients(spaceId) {
  const list = [...clients.values()]
    .filter((c) => isWsJoined(c) && (!spaceId || devices.spaceOf(c.deviceId) === spaceId))
    .map((c) => ({ id: c.id, device: c.device, browser: c.browser, deviceId: c.deviceId, connectedAt: c.connectedAt }));
  broadcast({ type: "clients", clients: list }, null, spaceId);
}

function broadcastDevices(spaceId) {
  broadcast({ type: "devices-changed" }, null, spaceId);
}

/* 广播给所有已加入空间的在线客户端（用于全局公告等） */
function broadcastAll(obj) {
  const msg = JSON.stringify(obj);
  for (const [ws, info] of clients) {
    if (ws.readyState !== ws.OPEN) continue;
    if (!isWsJoined(info)) continue;
    ws.send(msg);
  }
}

/* ---------- 空间好友 / 消息辅助 ---------- */
function onlineSpaces() {
  const set = new Set();
  for (const [, info] of clients) {
    if (isWsJoined(info)) set.add(devices.spaceOf(info.deviceId));
  }
  return set;
}
function spaceOnline(spaceId) { return onlineSpaces().has(spaceId); }
function broadcastFriendStatus(spaceId) {
  const online = onlineSpaces();
  for (const fid of friends.friendsOf(spaceId)) {
    broadcast({ type: "friend-status", spaceId, online: online.has(spaceId) }, null, fid);
  }
}
/* 图片跨空间访问：本空间的小结图片，或聊天消息里共享的图片 */
function imageAccessible(spaceId, imageId) {
  if (store.imageInSpace(imageId, spaceId)) return true;
  return messages.listAll().some((m) => m.imageId === imageId && (m.from === spaceId || m.to === spaceId));
}

function fullSummaryPayload(s) {
  return { type: "summary-updated", summary: s };
}

/* ---------- WebSocket ---------- */
wss.on("connection", (ws, req) => {
  try {
    const ua = req.headers["user-agent"] || "";
    const device = clientDevice(ua);
    const deviceId = getDeviceId(req);
    const info = { id: "c" + Math.random().toString(36).slice(2, 8), deviceId, device, browser: briefUA(ua), ua, connectedAt: Date.now() };
    clients.set(ws, info);

    const dev = deviceId ? devices.find(deviceId) : null;
    if (!dev || !dev.spaceId) {
      ws.send(JSON.stringify({ type: "hello", needApproval: true, deviceId: deviceId || "" }));
    } else {
      const spaceId = dev.spaceId;
      ws.send(JSON.stringify({
        type: "hello",
        clientId: info.id,
        deviceId,
        spaceId,
        clients: [...clients.values()].filter((c) => isWsJoined(c) && devices.spaceOf(c.deviceId) === spaceId).map((c) => ({ id: c.id, device: c.device, browser: c.browser, connectedAt: c.connectedAt })),
        summaries: store.list(spaceId)
      }));
      broadcastClients(spaceId);
      broadcastFriendStatus(spaceId);
    }

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
        if (msg.type === "auth-changed") broadcastClients();
      } catch (_) {}
    });
    ws.on("close", () => {
      clients.delete(ws);
      if (info.deviceId) {
        const sid = devices.spaceOf(info.deviceId);
        broadcastClients(sid);
        broadcastFriendStatus(sid);
      }
    });
    ws.on("error", () => {
      clients.delete(ws);
      if (info.deviceId) {
        const sid = devices.spaceOf(info.deviceId);
        broadcastClients(sid);
        broadcastFriendStatus(sid);
      }
    });
  } catch (e) {
    console.error("[ws] 连接处理错误:", e.message);
    try { ws.close(); } catch (_) {}
  }
});

setInterval(() => {
  for (const [ws] of clients) {
    if (ws.readyState === ws.OPEN) ws.ping();
  }
}, 30000);

/* ---------- 授权接口（无需预先加入空间） ---------- */
app.post("/api/auth/register", (req, res) => {
  const body = req.body || {};
  const deviceId = getDeviceId(req) || body.deviceId || "";
  if (!deviceId) return res.status(400).json({ error: "缺少设备标识" });
  const ua = req.headers["user-agent"] || "";
  const device = body.device || clientDevice(ua);
  const name = body.name || deviceLabel(ua, device);
  const d = devices.upsert(deviceId, { name, device });
  const space = d.spaceId ? spaces.findById(d.spaceId) : null;
  res.json({
    deviceId,
    joined: !!d.spaceId,
    spaceId: d.spaceId || "",
    spaceName: space ? space.name : "",
    owner: !!d.owner,
    serverAdmin: isServerAdmin(deviceId),
    needJoin: !d.spaceId,
    enabled: accessEnabled()
  });
});

app.post("/api/auth/join", (req, res) => {
  const body = req.body || {};
  const deviceId = body.deviceId || getDeviceId(req) || "";
  if (!deviceId) return res.status(400).json({ error: "缺少设备标识" });
  const spaceName = String(body.spaceName || "").trim();
  const pin = String(body.pin || "");
  if (!spaceName) return res.status(400).json({ error: "请输入空间名称" });
  devices.upsert(deviceId, { name: body.name, device: body.device });

  let space = spaces.findByName(spaceName);
  if (!space) {
    if (!body.create) return res.json({ ok: false, notFound: true, message: "该空间不存在，是否创建？" });
    if (!allowNewSpaces()) return res.status(403).json({ error: "服务器已禁止创建新空间，请加入已有空间" });
    const firstSpace = !spaces.any();
    space = spaces.create(spaceName, deviceId, pin);
    devices.joinSpace(deviceId, space.id);
    devices.setOwner(deviceId);
    if (firstSpace) store.assignSpaceId(space.id); // 首个空间认领旧数据（含示例）
    broadcastDevices(space.id);
    broadcastClients(space.id);
    return res.json({ ok: true, space: { id: space.id, name: space.name }, owner: true, created: true });
  }
  if (!spaces.verifyPin(space, pin)) return res.status(403).json({ error: "空间密码错误", pinWrong: true });
  devices.joinSpace(deviceId, space.id);
  broadcastDevices(space.id);
  broadcastClients(space.id);
  res.json({ ok: true, space: { id: space.id, name: space.name }, owner: !!devices.find(deviceId).owner, serverAdmin: isServerAdmin(deviceId) });
});

app.post("/api/auth/leave", (req, res) => {
  const deviceId = getDeviceId(req);
  if (deviceId) {
    const d = devices.find(deviceId);
    if (d && d.spaceId) {
      const oldSpace = d.spaceId;
      d.spaceId = "";
      d.approved = false;
      devices.upsert(deviceId, { name: d.name, device: d.device });
      broadcastDevices(oldSpace);
      broadcastClients(oldSpace);
    }
  }
  res.json({ ok: true });
});

app.get("/api/auth/status", (req, res) => {
  const deviceId = getDeviceId(req);
  const d = deviceId ? devices.find(deviceId) : null;
  const space = d && d.spaceId ? spaces.findById(d.spaceId) : null;
  res.json({
    enabled: accessEnabled(),
    allowNewSpaces: allowNewSpaces(),
    deviceId: deviceId || "",
    joined: !!(d && d.spaceId),
    spaceId: (d && d.spaceId) || "",
    spaceName: space ? space.name : "",
    spaceCode: space ? (space.code || "") : "",
    owner: !!(d && d.owner),
    serverAdmin: isServerAdmin(deviceId)
  });
});

/* ---------- 访问控制中间件 ---------- */
function accessGate(req, res, next) {
  const deviceId = getDeviceId(req);
  const cfg = configLib.loadConfig();
  if (!cfg.access || !cfg.access.enabled) {
    // 未开启访问控制：自动进入默认空间（所有人共享）
    const d = deviceId ? devices.find(deviceId) : null;
    if (d && !d.spaceId) {
      let sp = spaces.first();
      if (!sp) { sp = spaces.create("默认空间", deviceId, ""); }
      if (!sp.ownerDeviceId) spaces.setOwner(sp.id, deviceId);
      devices.joinSpace(deviceId, sp.id);
      if (d.owner) spaces.setOwner(sp.id, deviceId);
    }
    return next();
  }
  if (!deviceId) return res.status(403).json({ error: "缺少设备标识", needApproval: true });
  const d = deviceId ? devices.find(deviceId) : null;
  if (!d || !d.spaceId) {
    return res.status(403).json({ error: "请先加入一个数据空间", needApproval: true, deviceId, pending: true });
  }
  return next();
}

function spaceIdOf(req) {
  return devices.spaceOf(getDeviceId(req));
}

/* ---------- 二维码（无需授权） ---------- */
app.get("/api/qr", async (req, res) => {
  const text = String(req.query.text || "").slice(0, 500);
  if (!text) return res.status(400).json({ error: "缺少 text 参数" });
  try {
    const buf = await QRCode.toBuffer(text, { width: 220, margin: 1, errorCorrectionLevel: "M" });
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-cache");
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: "二维码生成失败: " + e.message });
  }
});

app.get("/api/status", (req, res) => {
  const cfg = configLib.loadConfig();
  const deviceId = getDeviceId(req);
  const d = deviceId ? devices.find(deviceId) : null;
  res.json({
    ok: true,
    version: VERSION,
    time: new Date().toISOString(),
    lanIP: getLANIP(),
    port: cfg.port,
    url: cfg.baseURL || ("http://" + getLANIP() + ":" + cfg.port),
    aiConfigured: !!(cfg.ai && cfg.ai.apiKey),
    aiProvider: (cfg.ai && cfg.ai.provider) || "",
    aiModel: (cfg.ai && cfg.ai.model) || "",
    accessEnabled: accessEnabled(),
    joined: !!(d && d.spaceId),
    owner: !!(d && d.owner),
    serverAdmin: isServerAdmin(deviceId)
  });
});

/* ---------- 业务接口（需已加入空间） ---------- */
app.use("/api", accessGate);

app.get("/api/config", (req, res) => {
  res.json(configLib.publicConfig(configLib.loadConfig()));
});

app.post("/api/config", (req, res) => {
  const reqDeviceId = getDeviceId(req);
  if (!isServerAdmin(reqDeviceId)) return res.status(403).json({ error: "仅服务器管理员可修改系统设置" });
  const cfg = configLib.loadConfig();
  const body = req.body || {};
  if (typeof body.name === "string") cfg.name = body.name.trim();
  if (typeof body.dept === "string") cfg.dept = body.dept.trim();
  if (typeof body.baseURL === "string") cfg.baseURL = body.baseURL.trim();
  if (body.port) {
    const p = parseInt(body.port, 10);
    if (!isNaN(p) && p > 0 && p < 65536) cfg.port = p;
  }
  if (body.ai && typeof body.ai === "object") {
    const a = body.ai;
    if (typeof a.baseURL === "string" && a.baseURL.trim()) cfg.ai.baseURL = a.baseURL.trim();
    if (typeof a.model === "string" && a.model.trim()) cfg.ai.model = a.model.trim();
    if (typeof a.provider === "string") cfg.ai.provider = a.provider.trim();
    if (typeof a.temperature === "number") cfg.ai.temperature = Math.min(2, Math.max(0, a.temperature));
    if (typeof a.maxTokens === "number") cfg.ai.maxTokens = Math.min(32000, Math.max(256, Math.floor(a.maxTokens)));
    if (typeof a.apiKey === "string" && a.apiKey.trim()) cfg.ai.apiKey = a.apiKey.trim();
  }
  if (body.access && typeof body.access === "object") {
    cfg.access = cfg.access || {};
    if (typeof body.access.enabled === "boolean") cfg.access.enabled = body.access.enabled;
    if (typeof body.access.allowNewSpaces === "boolean") cfg.access.allowNewSpaces = body.access.allowNewSpaces;
  }
  configLib.saveConfig(cfg);
  broadcastDevices();
  res.json({ ok: true, config: configLib.publicConfig(cfg), note: "若修改了端口，需要重启服务生效。" });
});

app.get("/api/summaries", (req, res) => {
  res.json({ summaries: store.list(spaceIdOf(req)) });
});

app.get("/api/summaries/:id", (req, res) => {
  const s = store.get(req.params.id, spaceIdOf(req));
  if (!s) return res.status(404).json({ error: "未找到该周小结" });
  res.json({ summary: s });
});

app.post("/api/summaries", (req, res) => {
  const spaceId = spaceIdOf(req);
  const s = store.create(req.body || {}, spaceId);
  broadcast({ type: "summary-created", summary: s }, null, spaceId);
  res.json({ summary: s });
});

app.put("/api/summaries/:id", (req, res) => {
  const spaceId = spaceIdOf(req);
  const s = store.update(req.params.id, req.body || {}, spaceId);
  if (!s) return res.status(404).json({ error: "未找到该周小结" });
  broadcast(fullSummaryPayload(s), null, spaceId);
  res.json({ summary: s });
});

app.delete("/api/summaries/:id", (req, res) => {
  const spaceId = spaceIdOf(req);
  const ok = store.remove(req.params.id, spaceId);
  if (!ok) return res.status(404).json({ error: "未找到该周小结" });
  broadcast({ type: "summary-deleted", id: req.params.id }, null, spaceId);
  res.json({ ok: true });
});

/* ---------- 图片 ---------- */
app.post("/api/upload", (req, res) => {
  const spaceId = spaceIdOf(req);
  const body = req.body || {};
  const summaryId = String(body.summaryId || "");
  if (!summaryId) return res.status(400).json({ error: "缺少 summaryId" });
  const summary = store.get(summaryId, spaceId);
  if (!summary) return res.status(404).json({ error: "未找到该周小结" });
  const dataUrl = String(body.data || "");
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return res.status(400).json({ error: "图片数据格式错误" });
  try {
    const img = images.saveImage({ data: Buffer.from(m[2], "base64"), mime: m[1].toLowerCase(), width: body.width, height: body.height, name: body.name });
    const updated = store.addImage(summaryId, img, spaceId);
    if (!updated) return res.status(404).json({ error: "未找到该周小结" });
    broadcast(fullSummaryPayload(updated), null, spaceId);
    res.json({ image: { id: img.id, name: img.name, mime: img.mime, width: img.width, height: img.height, size: img.size, url: "/api/images/" + img.id, uploadedAt: new Date().toISOString() } });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/api/images/:id", (req, res) => {
  const spaceId = spaceIdOf(req);
  if (!imageAccessible(spaceId, req.params.id)) return res.status(404).json({ error: "图片不存在" });
  const img = images.loadImage(req.params.id);
  if (!img) return res.status(404).json({ error: "图片文件缺失" });
  res.setHeader("Content-Type", img.mime);
  res.setHeader("Cache-Control", "public, max-age=86400");
  if (String(req.query.download || "") === "1") {
    const name = (req.query.name || "图片").toString().slice(0, 120);
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  }
  res.send(img.buffer);
});

app.delete("/api/images/:id", (req, res) => {
  const spaceId = spaceIdOf(req);
  const id = req.params.id;
  if (!store.imageInSpace(id, spaceId)) return res.status(404).json({ error: "图片不存在" });
  images.deleteImage(id);
  const affected = store.removeImageFromAll(id, spaceId);
  for (const s of affected) broadcast(fullSummaryPayload(s), null, spaceId);
  res.json({ ok: true });
});

/* ---------- 设备管理（本空间内） ---------- */
app.get("/api/devices", (req, res) => {
  const spaceId = spaceIdOf(req);
  const online = new Set([...clients.values()].map((c) => c.deviceId).filter(Boolean));
  const list = devices.bySpace(spaceId).map((d) => ({
    id: d.id, name: d.name, device: d.device, owner: !!d.owner,
    createdAt: d.createdAt, approvedAt: d.approvedAt, lastSeen: d.lastSeen, online: online.has(d.id)
  }));
  res.json({ devices: list, serverAdmin: isServerAdmin(getDeviceId(req)) });
});

app.post("/api/devices/remove", (req, res) => {
  const me = devices.find(getDeviceId(req));
  const id = (req.body && req.body.id) || "";
  if (!me || !id) return res.status(400).json({ error: "参数错误" });
  const target = devices.find(id);
  if (!target || target.spaceId !== me.spaceId) return res.status(404).json({ error: "设备不存在" });
  if (id === me.id) return res.status(400).json({ error: "不能移除当前设备" });
  if (!me.owner && !target.owner) return res.status(403).json({ error: "仅空间创建者可移除设备" });
  devices.remove(id);
  broadcastDevices(me.spaceId);
  broadcastClients(me.spaceId);
  res.json({ ok: true });
});

/* ---------- AI 生成（流式） ---------- */
app.post("/api/ai/generate", async (req, res) => {
  const cfg = configLib.loadConfig();
  const { mode, notes, sectionsText, target, extra } = req.body || {};

  if (!cfg.ai || !cfg.ai.apiKey) {
    return res.status(400).json({ error: "尚未配置 AI 接口密钥，请先到设置中填写。", needConfig: true });
  }

  const messages = [
    { role: "system", content: ai.buildSystem(mode) },
    { role: "user", content: ai.buildUser(mode || "generate", { notes, sectionsText, extra, target }) }
  ];

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");

  const ctrl = new AbortController();
  let resFinished = false;
  res.on("finish", () => { resFinished = true; });
  res.on("close", () => { if (!resFinished) { try { ctrl.abort(); } catch (_) {} } });

  let started = false;
  try {
    await ai.chat({
      baseURL: cfg.ai.baseURL,
      apiKey: cfg.ai.apiKey,
      model: cfg.ai.model,
      temperature: cfg.ai.temperature,
      maxTokens: cfg.ai.maxTokens,
      messages,
      signal: ctrl.signal,
      onChunk: (piece) => { started = true; res.write(piece); }
    });
    res.end();
  } catch (e) {
    if (!started) {
      try { res.status(500).json({ error: e.message }); } catch (_) {}
    } else {
      try { res.write("\n\n[生成中断] " + e.message); res.end(); } catch (_) {}
    }
  }
});

app.post("/api/ai/test", async (req, res) => {
  const cfg = configLib.loadConfig();
  const body = req.body || {};
  const baseURL = body.baseURL || cfg.ai.baseURL;
  const apiKey = body.apiKey || cfg.ai.apiKey;
  const model = body.model || cfg.ai.model;
  if (!apiKey) return res.status(400).json({ error: "请填写 API Key" });
  try {
    const text = await ai.chat({
      baseURL, apiKey, model,
      temperature: 0.3, maxTokens: 64,
      messages: [
        { role: "system", content: "你只回复：连接成功" },
        { role: "user", content: "测试" }
      ]
    });
    res.json({ ok: true, reply: (text || "").slice(0, 120), baseURL, model });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* ---------- Word 导出 ---------- */
async function handleExport(summary, cfg, res) {
  try {
    const { buffer, fileName } = await exportDocx(summary, cfg);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    res.setHeader("Content-Length", buffer.length);
    res.send(Buffer.from(buffer));
  } catch (e) {
    res.status(500).json({ error: "导出失败: " + e.message });
  }
}

app.post("/api/export/docx", async (req, res) => {
  const cfg = configLib.loadConfig();
  const summary = req.body && req.body.summary;
  if (!summary || !Array.isArray(summary.sections)) {
    return res.status(400).json({ error: "缺少小结内容" });
  }
  await handleExport(summary, cfg, res);
});

app.get("/api/export/docx/:id", async (req, res) => {
  const cfg = configLib.loadConfig();
  const s = store.get(req.params.id, spaceIdOf(req));
  if (!s) return res.status(404).json({ error: "未找到该周小结" });
  await handleExport(s, cfg, res);
});

/* ---------- 空间聊天（好友 / 消息） ---------- */
app.get("/api/friends", (req, res) => {
  const spaceId = spaceIdOf(req);
  if (!spaceId) return res.status(403).json({ error: "请先加入一个数据空间" });
  const list = friends.friendsOf(spaceId)
    .map((fid) => {
      const sp = spaces.findById(fid);
      return { spaceId: fid, name: sp ? sp.name : "已删除的空间", code: sp ? (sp.code || "") : "", online: spaceOnline(fid) };
    })
    .sort((a, b) => (a.online === b.online ? 0 : a.online ? -1 : 1));
  const reqs = friends.requestsOf(spaceId);
  const incoming = reqs.incoming.map((r) => {
    const sp = spaces.findById(r.from);
    return { id: r.id, from: r.from, fromName: sp ? sp.name : "已删除的空间", fromCode: sp ? (sp.code || "") : "", createdAt: r.createdAt };
  });
  const outgoing = reqs.outgoing.map((r) => {
    const sp = spaces.findById(r.to);
    return { id: r.id, to: r.to, toName: sp ? sp.name : "已删除的空间", toCode: sp ? (sp.code || "") : "", createdAt: r.createdAt };
  });
  const rejected = reqs.rejected.map((r) => {
    const sp = spaces.findById(r.to);
    return { id: r.id, to: r.to, toName: sp ? sp.name : "已删除的空间", toCode: sp ? (sp.code || "") : "", reason: r.reason || "", createdAt: r.createdAt };
  });
  res.json({ friends: list, requests: { incoming, outgoing, rejected }, unread: messages.unreadCount(spaceId) });
});

app.post("/api/friends", (req, res) => {
  const spaceId = spaceIdOf(req);
  if (!spaceId) return res.status(403).json({ error: "请先加入一个数据空间" });
  const body = req.body || {};
  const query = String(body.query || body.spaceName || "").trim();
  if (!query) return res.status(400).json({ error: "请输入对方的空间ID或空间名称" });
  // 支持：空间ID（6位码） / 内部ID / 空间名称
  let sp = spaces.findByCode(query) || spaces.findById(query) || spaces.findByName(query);
  if (!sp) return res.status(404).json({ error: "找不到该空间，请确认空间ID或名称" });
  if (sp.id === spaceId) return res.status(400).json({ error: "不能添加自己为好友" });
  const fr = friends.createRequest(spaceId, sp.id);
  broadcast({ type: "friend-request", request: fr }, null, sp.id);
  res.json({ ok: true, pending: true, request: fr, friend: { spaceId: sp.id, name: sp.name, code: sp.code || "", online: spaceOnline(sp.id) } });
});

app.get("/api/space", (req, res) => {
  const spaceId = spaceIdOf(req);
  if (!spaceId) return res.status(403).json({ error: "请先加入一个数据空间" });
  const sp = spaces.findById(spaceId);
  if (!sp) return res.status(404).json({ error: "空间不存在" });
  const totalSpaces = spaces.list().length;
  res.json({
    space: { id: sp.id, code: sp.code || "", name: sp.name, online: spaceOnline(spaceId) },
    stats: { totalSpaces, onlineSpaces: onlineSpaces().size, onlineDevices: [...clients.values()].filter(isWsJoined).length }
  });
});

app.post("/api/friends/respond", (req, res) => {
  const spaceId = spaceIdOf(req);
  if (!spaceId) return res.status(403).json({ error: "请先加入一个数据空间" });
  const body = req.body || {};
  const id = String(body.requestId || "");
  const accept = body.accept === true || body.accept === "true";
  if (!id) return res.status(400).json({ error: "缺少申请ID" });
  const reason = String(body.reason || "");
  const r = friends.respondRequest(id, spaceId, accept, reason);
  if (!r) return res.status(404).json({ error: "申请不存在或已处理" });
  if (accept) {
    broadcastFriendStatus(r.from);
    broadcastFriendStatus(spaceId);
    broadcast({ type: "friend-accepted", request: r }, null, r.from);
    broadcast({ type: "friend-accepted", request: r }, null, spaceId);
  } else {
    broadcast({ type: "friend-rejected", request: r }, null, r.from);
  }
  res.json({ ok: true, status: r.status });
});

app.delete("/api/friends/:spaceId", (req, res) => {
  const spaceId = spaceIdOf(req);
  const fid = String(req.params.spaceId || "");
  if (!spaceId || !fid) return res.status(400).json({ error: "参数错误" });
  friends.removeFriend(spaceId, fid);
  broadcastFriendStatus(fid);
  broadcastFriendStatus(spaceId);
  res.json({ ok: true });
});

app.get("/api/messages", (req, res) => {
  const spaceId = spaceIdOf(req);
  const friend = String(req.query.friend || "");
  if (!spaceId) return res.status(403).json({ error: "请先加入一个数据空间" });
  if (!friend || !friends.areFriends(spaceId, friend)) return res.status(403).json({ error: "不是好友" });
  messages.markRead(spaceId, friend);
  res.json({ messages: messages.list(spaceId, friend) });
});

app.post("/api/messages", (req, res) => {
  const spaceId = spaceIdOf(req);
  const body = req.body || {};
  const to = String(body.toSpaceId || "");
  if (!spaceId || !to) return res.status(400).json({ error: "参数错误" });
  if (!friends.areFriends(spaceId, to)) return res.status(403).json({ error: "不是好友" });
  const type = body.type === "image" ? "image" : "text";
  if (type === "text" && !String(body.content || "").trim()) return res.status(400).json({ error: "消息内容不能为空" });
  if (type === "image" && !String(body.imageId || "")) return res.status(400).json({ error: "缺少图片" });
  const msg = messages.add({ from: spaceId, to, type, content: String(body.content || ""), imageId: String(body.imageId || "") });
  broadcast({ type: "message-new", message: msg }, null, to);
  broadcast({ type: "message-new", message: msg }, null, spaceId);
  res.json({ message: msg });
});

app.post("/api/messages/read", (req, res) => {
  const spaceId = spaceIdOf(req);
  const friend = String((req.body || {}).friendSpaceId || "");
  if (spaceId && friend) messages.markRead(spaceId, friend);
  res.json({ ok: true });
});

app.post("/api/chat/upload", (req, res) => {
  const spaceId = spaceIdOf(req);
  if (!spaceId) return res.status(403).json({ error: "请先加入一个数据空间" });
  const body = req.body || {};
  const dataUrl = String(body.data || "");
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return res.status(400).json({ error: "图片数据格式错误" });
  try {
    const img = images.saveImage({ data: Buffer.from(m[2], "base64"), mime: m[1].toLowerCase(), width: body.width, height: body.height, name: body.name || "聊天图片" });
    res.json({ image: { id: img.id, name: img.name, mime: img.mime, width: img.width, height: img.height, size: img.size, url: "/api/images/" + img.id, uploadedAt: new Date().toISOString() } });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* ---------- 全站空间列表（仅管理员可见，不含密码） ---------- */
app.get("/api/admin/spaces", (req, res) => {
  const deviceId = getDeviceId(req);
  if (!isServerAdmin(deviceId)) return res.status(403).json({ error: "仅管理员可查看" });
  const online = onlineSpaces();
  const list = spaces.list().map((sp) => {
    const owner = sp.ownerDeviceId ? devices.find(sp.ownerDeviceId) : null;
    return {
      id: sp.id,
      code: sp.code || "",
      name: sp.name,
      ownerName: owner ? (owner.name || "") : "",
      online: online.has(sp.id),
      isAdmin: !!sp.isAdmin,
      canManage: isSuperAdmin(deviceId),
      createdAt: sp.createdAt || ""
    };
  });
  const onlineCount = list.filter((x) => x.online).length;
  res.json({ spaces: list, total: list.length, online: onlineCount });
});

/* 任命/撤销协管（仅超级管理员） */
app.post("/api/admin/appoint", (req, res) => {
  const deviceId = getDeviceId(req);
  if (!isSuperAdmin(deviceId)) return res.status(403).json({ error: "仅超级管理员可任命管理员" });
  const body = req.body || {};
  const query = String(body.query || "").trim();
  const action = body.action === "remove" ? "remove" : "add";
  if (!query) return res.status(400).json({ error: "请输入空间ID或名称" });
  const sp = spaces.findByCode(query) || spaces.findById(query) || spaces.findByName(query);
  if (!sp) return res.status(404).json({ error: "找不到该空间" });
  if (sp.id === (spaces.first() || {}).id) return res.status(400).json({ error: "不能操作主管理员空间" });
  spaces.setAdmin(sp.id, action === "add");
  res.json({ ok: true, space: { id: sp.id, name: sp.name, code: sp.code || "", isAdmin: action === "add" } });
});

/* ---------- 公告 / 通知 ---------- */
app.get("/api/announcements", (req, res) => {
  const spaceId = spaceIdOf(req);
  if (!spaceId) return res.status(403).json({ error: "请先加入一个数据空间" });
  res.json({ announcements: announcements.list(50) });
});

app.post("/api/announcements", (req, res) => {
  const deviceId = getDeviceId(req);
  if (!isServerAdmin(deviceId)) return res.status(403).json({ error: "仅管理员可发布公告" });
  const spaceId = spaceIdOf(req);
  if (!spaceId) return res.status(403).json({ error: "请先加入一个数据空间" });
  const content = String((req.body || {}).content || "").trim();
  if (!content) return res.status(400).json({ error: "公告内容不能为空" });
  const sp = spaces.findById(spaceId);
  const a = announcements.add({ from: spaceId, fromName: sp ? sp.name : "匿名", content });
  broadcastAll({ type: "announcement-new", announcement: a });
  res.json({ announcement: a });
});

/* ---------- 404 / 错误 ---------- */
app.use("/api", (req, res) => res.status(404).json({ error: "接口不存在" }));

app.use((err, req, res, next) => {
  console.error("[server] 错误:", err.message);
  res.status(500).json({ error: "服务器内部错误: " + err.message });
});

/* ---------- 旧数据迁移 ---------- */
function migrate() {
  const cfg = configLib.loadConfig();
  if (!spaces.any()) {
    const legacy = devices.firstApprovedWithoutSpace();
    if (legacy) {
      const name = (cfg.name ? cfg.name + " 的空间" : "默认空间");
      const sp = spaces.create(name, legacy.id, "");
      devices.joinSpace(legacy.id, sp.id);
      devices.setOwner(legacy.id);
      store.assignSpaceId(sp.id);
    }
    // 无历史设备：不预创建，首个「创建新空间」的设备将认领数据
  } else {
    store.assignSpaceId(spaces.first().id);
    const first = spaces.first();
    for (const d of devices.list()) {
      if (d.approved && !d.spaceId) devices.joinSpace(d.id, first.id);
    }
    if (!first.ownerDeviceId) {
      const legacy = devices.bySpace(first.id)[0];
      if (legacy) spaces.setOwner(first.id, legacy.id);
    }
  }
  console.log("[migrate] 空间数: " + spaces.list().length + " | 周小结数: " + store.list().length);
}

/* ---------- 启动 ---------- */
migrate();

const cfg = configLib.loadConfig();
const port = process.env.PORT ? parseInt(process.env.PORT, 10) : (cfg.port || 8080);
const lanIP = getLANIP();

server.listen(port, "0.0.0.0", () => {
  console.log("");
  console.log("  ╔══════════════════════════════════════════════╗");
  console.log("  ║       每周小结助手 WEEKLY·OS  v" + VERSION.padEnd(14) + "║");
  console.log("  ╚══════════════════════════════════════════════╝");
  console.log("");
  console.log("  本机访问:   http://localhost:" + port);
  console.log("  局域网访问: http://" + lanIP + ":" + port + "   （同一 Wi-Fi）");
  console.log("  外网访问:   " + (cfg.baseURL ? cfg.baseURL : "未配置（详见 部署到云端.md）"));
  console.log("");
  console.log("  AI 状态:   " + (cfg.ai && cfg.ai.apiKey ? "已配置 (" + (cfg.ai.model || "") + ")" : "未配置 → 打开网站后在【设置】中填写 API Key"));
  console.log("  访问控制:   " + (cfg.access && cfg.access.enabled ? "已开启（按空间隔离，需空间名+密码）" : "未开启（所有人共享默认空间）"));
  console.log("  数据文件:   " + path.join(__dirname, "data", "summaries.json"));
  console.log("");

  if (process.env.AUTO_OPEN === "1") {
    setTimeout(() => {
      try { require("child_process").exec('start "" "http://localhost:' + port + '"'); } catch (_) {}
    }, 800);
  }
});
