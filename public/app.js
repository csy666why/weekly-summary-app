"use strict";
/* ============================================================
   WEEKLY·OS 每周小结助手 — 前端逻辑
   访问控制 / 实时同步（WebSocket）/ 按字段合并保存 / AI 流式 / Word 导出
   ============================================================ */

const $ = (id) => document.getElementById(id);

const state = {
  deviceId: localStorage.getItem("wos_device_id") || "",
  summaries: [],
  current: null,
  config: null,
  clients: [],
  clientId: null,
  ws: null,
  wsRetry: 0,
  wsTimer: null,
  saveTimer: null,
  dirty: false,
  lastSavedAt: null,
  aiStreaming: false,
  aiAbort: null,
  gateTimer: null,
  auth: { joined: false, owner: false, serverAdmin: false, enabled: true, allowNewSpaces: true, spaceId: "", spaceName: "" },
  edited: emptyEdits(),
  deletedSections: [],
  devices: [],
  imageInsertTarget: null,
  richSelection: null,
  chat: { friends: [], activeFriend: null, unread: {} }
};

const PROVIDERS = {
  deepseek:   { baseURL: "https://api.deepseek.com", model: "deepseek-chat" },
  openai:     { baseURL: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  moonshot:   { baseURL: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k" },
  qwen:       { baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
  glm:        { baseURL: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash" },
  siliconflow:{ baseURL: "https://api.siliconflow.cn/v1", model: "deepseek-ai/DeepSeek-V3" },
  ollama:     { baseURL: "http://localhost:11434/v1", model: "qwen2.5:7b" },
  custom:     { baseURL: "", model: "" }
};

/* ---------- 工具 ---------- */
function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function pad2(n) { return String(n).padStart(2, "0"); }
function weekNum(week) {
  const m = String(week || "").match(/(\d+)/);
  return m ? pad2(parseInt(m[1], 10) % 100) : "01";
}
function fmtTime(d) {
  d = d || new Date();
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
}
function fmtShort(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return pad2(d.getMonth() + 1) + "." + pad2(d.getDate());
}
function newId() { return "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function emptyEdits() { return { title: false, dateRange: false, topic: false, notes: false, sections: {}, reorder: false }; }

function deviceKind() {
  return /Mobile|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ? "phone" : "desktop";
}
function deviceLabel() {
  const ua = navigator.userAgent;
  let browser = "浏览器";
  if (/Edg\//.test(ua)) browser = "Edge";
  else if (/Chrome\//.test(ua)) browser = "Chrome";
  else if (/Safari\//.test(ua)) browser = "Safari";
  else if (/Firefox\//.test(ua)) browser = "Firefox";
  else if (/MicroMessenger/i.test(ua)) browser = "微信";
  return (deviceKind() === "phone" ? "手机" : "电脑") + " · " + browser;
}

async function fetchJSON(url, opts) {
  opts = opts || {};
  opts.headers = Object.assign({}, opts.headers, { "X-Device-Id": state.deviceId });
  const res = await fetch(url, opts);
  const ct = res.headers.get("content-type") || "";
  let data = null;
  try { if (ct.includes("application/json")) data = await res.json(); } catch (_) {}
  if (!res.ok) {
    const err = new Error((data && data.error) || "请求失败 (" + res.status + ")");
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function toast(msg, type) {
  const box = $("toast");
  const el = document.createElement("div");
  el.className = "toast-item" + (type ? " " + type : "");
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; el.style.transition = "opacity .4s"; setTimeout(() => el.remove(), 400); }, 2600);
}

function autosize(el) {
  // 富文本（contenteditable）天然自适应高度，手动设高反而造成移动端每次按键跳动，直接跳过
  if (!el || el.isContentEditable) return;
  // 文本域：仅当高度真的变化时才调整，避免反复塌缩撑开
  const target = (el.scrollHeight + 2) + "px";
  if (el.style.height !== target) {
    el.style.height = "auto";
    el.style.height = target;
  }
}

/* ---------- 授权 / 门禁 ---------- */
async function registerDevice() {
  if (!state.deviceId) {
    state.deviceId = "d" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    localStorage.setItem("wos_device_id", state.deviceId);
  }
  try {
    const r = await fetchJSON("/api/auth/register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: state.deviceId, name: deviceLabel(), device: deviceKind() })
    });
    state.auth = { joined: !!r.joined, owner: !!r.owner, serverAdmin: !!r.serverAdmin, enabled: !!r.enabled, spaceId: r.spaceId || "", spaceName: r.spaceName || "" };
  } catch (e) {
    state.auth = { joined: false, owner: false, serverAdmin: false, enabled: true, spaceId: "", spaceName: "" };
  }
  updateSpaceChip();
}

function showGate() {
  $("gate").classList.remove("hidden");
  $("gateDevice").textContent = state.deviceId ? state.deviceId.slice(0, 14).toUpperCase() : "—";
  $("gateErr").textContent = "";
  setTimeout(() => $("gateSpaceName").focus(), 80);
}
function hideGate() { $("gate").classList.add("hidden"); }

function updateSpaceChip() {
  const chip = $("spaceChip");
  if (state.auth.joined && state.auth.spaceName) {
    chip.classList.remove("hidden");
    $("spaceName").textContent = state.auth.spaceName + (state.auth.owner ? " · 主" : "");
  } else {
    chip.classList.add("hidden");
  }
}

async function submitGateJoin(create) {
  const spaceName = $("gateSpaceName").value.trim();
  const pin = $("gatePin").value.trim();
  if (!spaceName) { $("gateErr").textContent = "请输入空间名称"; return; }
  if (!pin) { $("gateErr").textContent = "请输入空间访问密码"; return; }
  $("gateErr").textContent = "";
  try {
    const r = await fetchJSON("/api/auth/join", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: state.deviceId, spaceName, pin, create, name: deviceLabel(), device: deviceKind() })
    });
    if (!r.ok && r.notFound) {
      if (create) { $("gateErr").textContent = "创建失败，请重试"; return; }
      if (!confirm("空间「" + spaceName + "」不存在，是否创建？")) return;
      return submitGateJoin(true);
    }
    if (r.ok) {
      state.auth.joined = true;
      state.auth.owner = !!r.owner;
      state.auth.serverAdmin = !!r.serverAdmin;
      state.auth.spaceId = r.space.id;
      state.auth.spaceName = r.space.name;
      updateSpaceChip();
      hideGate();
      toast(r.created ? "空间创建成功，欢迎使用！" : "已进入空间「" + r.space.name + "」", "ok");
      await initApp();
    }
  } catch (e) {
    $("gateErr").textContent = e.message;
    $("gatePin").value = "";
  }
}

async function switchSpace() {
  try {
    await fetchJSON("/api/auth/leave", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
  } catch (_) {}
  state.auth.joined = false;
  state.auth.owner = false;
  state.auth.serverAdmin = false;
  state.auth.spaceId = "";
  state.auth.spaceName = "";
  state.summaries = [];
  state.current = null;
  closeDrawer();
  closeAiPanel();
  $("editorInner").classList.add("hidden");
  $("emptyState").classList.remove("hidden");
  updateSpaceChip();
  showGate();
}

/* ---------- 连接状态 / 保存状态 ---------- */
function setConn(mode, text) {
  const led = $("connLed");
  led.className = "led " + (mode === "ok" ? "led-ok" : mode === "connecting" ? "led-sync" : "led-err");
  $("connText").textContent = text || (mode === "ok" ? "已连接" : "连接断开");
}
function setSave(mode, text) {
  const led = $("saveState").querySelector(".led");
  led.className = "led " + (mode === "ok" ? "led-ok" : mode === "sync" ? "led-sync" : mode === "err" ? "led-err" : "led-sync");
  $("saveText").textContent = text;
}

/* ---------- WebSocket ---------- */
function connectWS() {
  clearTimeout(state.wsTimer);
  const proto = location.protocol === "https:" ? "wss" : "ws";
  let ws;
  try { ws = new WebSocket(proto + "://" + location.host + "/ws?deviceId=" + encodeURIComponent(state.deviceId)); } catch (e) { scheduleReconnect(); return; }
  state.ws = ws;
  setConn("connecting", "连接中…");
  ws.onopen = () => { state.wsRetry = 0; setConn("ok", "已连接"); };
  ws.onmessage = (ev) => { try { handleMessage(JSON.parse(ev.data)); } catch (_) {} };
  ws.onclose = () => { setConn("err", "连接断开"); scheduleReconnect(); };
  ws.onerror = () => { try { ws.close(); } catch (_) {} };
}
function scheduleReconnect() {
  clearTimeout(state.wsTimer);
  const delay = Math.min(1000 * Math.pow(2, state.wsRetry), 10000);
  state.wsRetry++;
  state.wsTimer = setTimeout(connectWS, delay);
}

function handleMessage(msg) {
  switch (msg.type) {
    case "hello":
      if (msg.needApproval) { state.auth.joined = false; break; }
      state.clientId = msg.clientId;
      state.clients = msg.clients || [];
      if (msg.summaries) { state.summaries = msg.summaries; renderList(); }
      renderDevices();
      loadChatFriendsSilent();
      if (state.current) refreshCurrent();
      break;
    case "clients":
      state.clients = msg.clients || [];
      renderDevices();
      break;
    case "list":
      state.summaries = msg.summaries || [];
      renderList();
      if (state.current && !state.summaries.some((s) => s.id === state.current.id)) clearCurrent();
      break;
    case "summary-created":
      if (!state.summaries.some((s) => s.id === msg.summary.id)) state.summaries.unshift({ id: msg.summary.id, title: msg.summary.title, week: msg.summary.week, dateRange: msg.summary.dateRange, sectionCount: (msg.summary.sections || []).length, createdAt: msg.summary.createdAt, updatedAt: msg.summary.updatedAt });
      renderList();
      if (!state.current) selectSummary(msg.summary.id);
      break;
    case "summary-updated":
      mergeRemote(msg.summary);
      break;
    case "summary-deleted":
      state.summaries = state.summaries.filter((s) => s.id !== msg.id);
      renderList();
      if (state.current && state.current.id === msg.id) clearCurrent();
      break;
    case "devices-changed":
      loadDevices(true);
      break;
    case "message-new":
      onChatMessage(msg);
      break;
    case "friend-status":
      updateFriendOnline(msg.spaceId, !!msg.online);
      break;
  }
}

async function refreshCurrent() {
  if (!state.current) return;
  try {
    const r = await fetchJSON("/api/summaries/" + encodeURIComponent(state.current.id));
    mergeRemote(r.summary);
  } catch (e) {
    if (e.status === 404) clearCurrent();
  }
}

/* ---------- 列表 ---------- */
function renderList() {
  const list = $("summaryList");
  list.innerHTML = "";
  if (!state.summaries.length) {
    list.innerHTML = '<div class="empty-list">NO DATA // 暂无周小结</div>';
  }
  for (const s of state.summaries) {
    const card = document.createElement("div");
    card.className = "summary-card" + (state.current && state.current.id === s.id ? " active" : "");
    card.dataset.id = s.id;
    const week = s.week || "周小结";
    const title = s.title || "（未命名）";
    card.innerHTML =
      '<div class="sc-week">' + escapeHtml(week) + "</div>" +
      '<div class="sc-title">' + escapeHtml(title) + "</div>" +
      '<div class="sc-meta"><span>' + (s.sectionCount || 0) + " 板块</span><span class=\"sc-date\">" + escapeHtml(s.dateRange || "—") + "</span><span>" + fmtShort(s.updatedAt) + "</span></div>";
    card.addEventListener("click", () => selectSummary(s.id));
    list.appendChild(card);
  }
  $("syncInfo").textContent = state.summaries.length + " 份小结 · " + state.clients.length + " 台设备在线";
}

function renderDevices() {
  const box = $("devices");
  box.innerHTML = "";
  for (const c of state.clients) {
    const chip = document.createElement("span");
    chip.className = "device-chip";
    const label = c.device === "phone" ? "手机" : "电脑";
    chip.innerHTML = '<span class="dot"></span>' + escapeHtml(label + " · " + (c.browser || "")) + (c.id === state.clientId ? "（本机）" : "");
    box.appendChild(chip);
  }
}

/* ---------- 选择 / 渲染编辑器 ---------- */
async function selectSummary(id) {
  if (state.dirty) { try { await saveCurrent(); } catch (_) {} }
  try {
    const data = await fetchJSON("/api/summaries/" + encodeURIComponent(id));
    state.current = data.summary;
    renderEditor();
    renderList();
    closeDrawer();
    setTabActive("edit");
  } catch (e) { toast("加载失败: " + e.message, "err"); }
}

function clearCurrent() {
  state.current = null;
  state.edited = emptyEdits();
  state.deletedSections = [];
  $("emptyState").classList.remove("hidden");
  $("editorInner").classList.add("hidden");
  renderList();
}

function renderEditor() {
  if (!state.current) { clearCurrent(); return; }
  $("emptyState").classList.add("hidden");
  $("editorInner").classList.remove("hidden");
  state.edited = emptyEdits();
  state.deletedSections = [];
  $("weekBadge").textContent = "WEEK " + weekNum(state.current.week);
  $("titleInput").value = state.current.title || "";
  $("dateRangeInput").value = state.current.dateRange || "";
  $("topicInput").value = state.current.topic || "";
  $("notesInput").value = state.current.notes || "";
  renderSections();
  renderTargets();
  updateCounts();
  setSave("ok", "已保存");
  if (!$("imageModal").classList.contains("hidden")) renderImageGrid();
}

function renderSections() {
  const box = $("sections");
  box.innerHTML = "";
  if (!state.current) return;
  state.current.sections.forEach((sec, i) => {
    const card = buildSectionCard(sec, i, state.current.sections.length);
    box.appendChild(card);
  });
}

function buildSectionCard(sec, index, total) {
  const card = document.createElement("div");
  card.className = "section-card";
  card.dataset.id = sec.id;
  card.innerHTML =
    '<div class="sec-head">' +
      '<span class="sec-index">SEC-' + pad2(index + 1) + "</span>" +
      '<input class="sec-title-input" placeholder="板块标题" value="' + escapeHtml(sec.title || "") + '" />' +
      '<div class="sec-tools">' +
        '<button class="sec-btn img" title="插入图片">🖼</button>' +
        '<button class="sec-btn up" title="上移">▲</button>' +
        '<button class="sec-btn down" title="下移">▼</button>' +
        '<button class="sec-btn del" title="删除板块">✕</button>' +
      "</div>" +
    "</div>" +
    '<div class="sec-content rich" contenteditable="true" data-placeholder="在这里记录本周工作…（可粘贴图片）"></div>';
  const tEl = card.querySelector(".sec-title-input");
  const cEl = card.querySelector(".sec-content");
  renderRichContent(cEl, sec.content || "");
  const saveRichSel = () => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && sel.getRangeAt(0)) {
      state.richSelection = { sectionId: sec.id, range: sel.getRangeAt(0).cloneRange() };
    }
  };
  tEl.addEventListener("input", () => { state.edited.sections[sec.id] = true; markDirty(); });
  cEl.addEventListener("input", () => { state.edited.sections[sec.id] = true; markDirty(); autosize(cEl); });
  cEl.addEventListener("mouseup", saveRichSel);
  cEl.addEventListener("keyup", saveRichSel);
  cEl.addEventListener("paste", (e) => handleRichPaste(e, sec.id));
  card.querySelector(".img").addEventListener("click", () => openImageModal(true, sec.id));
  card.querySelector(".up").addEventListener("click", () => moveSection(card, -1));
  card.querySelector(".down").addEventListener("click", () => moveSection(card, 1));
  card.querySelector(".del").addEventListener("click", () => removeSection(card));
  autosize(cEl);
  return card;
}

function updateSecIndices() {
  const cards = [...$("sections").querySelectorAll(".section-card")];
  cards.forEach((c, i) => { c.querySelector(".sec-index").textContent = "SEC-" + pad2(i + 1); });
}

function moveSection(card, dir) {
  const cards = [...$("sections").querySelectorAll(".section-card")];
  const idx = cards.indexOf(card);
  const ni = idx + dir;
  if (ni < 0 || ni >= cards.length) return;
  const box = $("sections");
  if (dir < 0) box.insertBefore(card, cards[ni]);
  else box.insertBefore(cards[ni], card);
  updateSecIndices();
  state.edited.reorder = true;
  syncFromDOM();
  markDirty();
}

function removeSection(card) {
  const title = card.querySelector(".sec-title-input").value || "该板块";
  if (!confirm("确定删除板块「" + title + "」？其内容将被移除。")) return;
  card.remove();
  updateSecIndices();
  state.deletedSections.push(card.dataset.id);
  delete state.edited.sections[card.dataset.id];
  syncFromDOM();
  markDirty();
}

function syncFromDOM() {
  if (!state.current) return;
  state.current = collectFromDOM(state.current);
  renderTargets();
}

/* 从 DOM 收集当前内容（保留服务端元数据） */
function collectFromDOM(base) {
  const cards = [...$("sections").querySelectorAll(".section-card")];
  const b = base || {};
  return {
    id: b.id,
    title: $("titleInput").value,
    week: b.week || "",
    dateRange: $("dateRangeInput").value,
    topic: $("topicInput").value,
    notes: $("notesInput").value,
    sections: cards.map((c) => {
      const old = (b.sections || []).find((x) => x.id === c.dataset.id) || {};
      return { id: c.dataset.id, title: c.querySelector(".sec-title-input").value, content: serializeRich(c.querySelector(".sec-content")), updatedAt: old.updatedAt };
    }),
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
    titleAt: b.titleAt, weekAt: b.weekAt, dateRangeAt: b.dateRangeAt, topicAt: b.topicAt, notesAt: b.notesAt,
    images: b.images || []
  };
}

/* ---------- 保存（按字段合并，互不干扰） ---------- */
function collectPayload() {
  const v = collectFromDOM(state.current);
  return Object.assign(v, {
    edited: JSON.parse(JSON.stringify(state.edited)),
    deletedSections: state.deletedSections.slice()
  });
}

function markDirty() {
  state.dirty = true;
  setSave("dirty", "未保存…");
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveCurrent, 700);
}

function saveCurrent() {
  const id = state.current && state.current.id;
  if (!id) return Promise.resolve();
  const payload = collectPayload();
  setSave("sync", "保存中…");
  return fetchJSON("/api/summaries/" + encodeURIComponent(id), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  }).then((res) => {
    state.current = res.summary;
    reconcileEdits(res.summary);
    state.lastSavedAt = new Date();
    setSave(state.dirty ? "dirty" : "ok", state.dirty ? "保存中，请稍候…" : "已保存 " + fmtTime());
    updateListMeta(res.summary);
    if (state.dirty) { clearTimeout(state.saveTimer); state.saveTimer = setTimeout(saveCurrent, 700); }
  }).catch((e) => {
    setSave("err", "保存失败，稍后重试");
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(saveCurrent, 3000);
    throw e;
  });
}

/* 保存成功后，核对 DOM 与服务端结果：保留保存期间的新输入 */
function reconcileEdits(saved) {
  if (!saved) return;
  if ($("titleInput").value === (saved.title || "")) state.edited.title = false;
  if ($("dateRangeInput").value === (saved.dateRange || "")) state.edited.dateRange = false;
  if ($("topicInput").value === (saved.topic || "")) state.edited.topic = false;
  if ($("notesInput").value === (saved.notes || "")) state.edited.notes = false;
  const savedSecs = new Map((saved.sections || []).map((x) => [x.id, x]));
  for (const id of Object.keys(state.edited.sections)) {
    const card = $("sections").querySelector('.section-card[data-id="' + id + '"]');
    const ss = savedSecs.get(id);
    if (!card || !ss) { delete state.edited.sections[id]; continue; }
    if (card.querySelector(".sec-title-input").value === (ss.title || "") && card.querySelector(".sec-content").value === (ss.content || "")) {
      delete state.edited.sections[id];
    }
  }
  if (Object.keys(state.edited.sections).length === 0) state.edited.reorder = false;
  const savedIds = new Set(savedSecs.keys());
  state.deletedSections = state.deletedSections.filter((id) => savedIds.has(id));
  state.dirty = !!(state.edited.title || state.edited.dateRange || state.edited.topic || state.edited.notes || Object.keys(state.edited.sections).length > 0 || state.edited.reorder || state.deletedSections.length > 0);
}

function updateListMeta(summary) {
  const idx = state.summaries.findIndex((s) => s.id === summary.id);
  if (idx >= 0) {
    state.summaries[idx] = {
      id: summary.id, title: summary.title, week: summary.week, dateRange: summary.dateRange,
      sectionCount: (summary.sections || []).length, createdAt: summary.createdAt, updatedAt: summary.updatedAt
    };
  }
  renderList();
}

/* ---------- 远程合并（不覆盖正在输入的内容） ---------- */
function mergeRemote(remote) {
  if (!remote) return;
  updateListMeta(remote);
  if (!state.current || state.current.id !== remote.id) return;

  const active = document.activeElement;
  const foc = (el) => active === el;

  if (!foc($("titleInput"))) { $("titleInput").value = remote.title || ""; state.edited.title = false; }
  if (!foc($("dateRangeInput"))) { $("dateRangeInput").value = remote.dateRange || ""; state.edited.dateRange = false; }
  if (!foc($("topicInput"))) { $("topicInput").value = remote.topic || ""; state.edited.topic = false; }
  if (!foc($("notesInput"))) { $("notesInput").value = remote.notes || ""; state.edited.notes = false; }
  $("weekBadge").textContent = "WEEK " + weekNum(remote.week);

  const box = $("sections");
  const remoteSections = Array.isArray(remote.sections) ? remote.sections : [];
  const remoteMap = new Map(remoteSections.map((s) => [s.id, s]));
  const existing = [...box.querySelectorAll(".section-card")];

  for (const card of existing) {
    const tEl = card.querySelector(".sec-title-input");
    const cEl = card.querySelector(".sec-content");
    const rs = remoteMap.get(card.dataset.id);
    if (!rs) {
      if (!foc(tEl) && !foc(cEl)) { delete state.edited.sections[card.dataset.id]; card.remove(); }
      continue;
    }
    if (!foc(tEl)) tEl.value = rs.title || "";
    if (!foc(cEl)) renderRichContent(cEl, rs.content || "");
    if (state.edited.sections[card.dataset.id] && !foc(tEl) && !foc(cEl)) {
      delete state.edited.sections[card.dataset.id];
    }
  }

  const present = new Set([...box.querySelectorAll(".section-card")].map((c) => c.dataset.id));
  let needReorder = false;
  for (const rs of remoteSections) {
    if (!present.has(rs.id)) {
      box.appendChild(buildSectionCard(rs, remoteSections.indexOf(rs), remoteSections.length));
      needReorder = true;
    }
  }
  if (needReorder) {
    for (const rs of remoteSections) {
      const card = box.querySelector('.section-card[data-id="' + rs.id + '"]');
      if (card) box.appendChild(card);
    }
    updateSecIndices();
  }

  state.current = collectFromDOM(remote);
  const prevTarget = $("targetSelect").value;
  if (!foc($("targetSelect"))) renderTargets();
  const sel = $("targetSelect");
  if (![...sel.options].some((o) => o.value === prevTarget)) sel.value = "__smart__";
  updateCounts();
  if (!$("imageModal").classList.contains("hidden")) renderImageGrid();
}

/* ---------- 目标板块 ---------- */
function renderTargets() {
  const sel = $("targetSelect");
  sel.innerHTML = "";
  const secs = state.current ? state.current.sections : [];
  for (let i = 0; i < secs.length; i++) {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = "§ " + (i + 1) + " " + (secs[i].title || "板块" + (i + 1));
    sel.appendChild(opt);
  }
  const smart = document.createElement("option");
  smart.value = "__smart__"; smart.textContent = "◇ 智能合并（按【板块】拆分替换）";
  sel.appendChild(smart);
  const nw = document.createElement("option");
  nw.value = "__new__"; nw.textContent = "＋ 新建板块";
  sel.appendChild(nw);
  sel.value = "__smart__";
}

function chooseDefaultTarget(mode) {
  const secs = state.current ? state.current.sections : [];
  const find = (keys) => { const i = secs.findIndex((s) => keys.some((k) => (s.title || "").includes(k))); return i >= 0 ? String(i) : null; };
  if (mode === "content") return find(["工作内容", "工作记录"]) || "__new__";
  if (mode === "insight") return find(["收获", "体会", "感悟"]) || "__new__";
  if (mode === "plan") return find(["下周", "计划"]) || "__new__";
  if (mode === "generate" || mode === "polish" || mode === "expand" || mode === "condense") return "__smart__";
  return "__new__";
}

/* ---------- AI 生成 ---------- */
function serializeSections(sections) {
  return (sections || []).map((s) => (s.title || "板块") + "：\n" + (s.content || "")).join("\n\n");
}

function parseResultSections(text) {
  const out = [];
  const re = /【([^】]+)】\s*([\s\S]*?)(?=【[^】]+】|$)/g;
  let m;
  while ((m = re.exec(text))) out.push({ title: m[1].trim(), content: m[2].trim() });
  if (out.length) return out;
  const re2 = /^（[一二三四五六七八九十百\d]+）\s*(.+)$/gm;
  const matches = [...text.matchAll(re2)];
  if (matches.length) {
    for (let i = 0; i < matches.length; i++) {
      const start = matches[i].index + matches[i][0].length;
      const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
      out.push({ title: matches[i][1].trim(), content: text.slice(start, end).trim() });
    }
    return out;
  }
  return [{ title: "", content: text.trim() }];
}

function matchTitle(a, b) {
  a = String(a || "").replace(/[（()）\d一二三四五六七八九十]/g, "");
  b = String(b || "").replace(/[（()）\d一二三四五六七八九十]/g, "");
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}

function appendText(existing, add) {
  existing = existing || "";
  return existing ? existing.replace(/\s*$/, "") + "\n" + add : add;
}

/* 收集文本中的图片标记 {{img:xxx}} */
function collectImageTokens(text) {
  const m = String(text || "").match(/\{\{img:[a-zA-Z0-9]+\}\}/g);
  return m ? Array.from(new Set(m)) : [];
}

async function generateAI() {
  if (state.aiStreaming) return;
  if (!state.current) { toast("请先选择或新建一份周小结", "err"); return; }
  const mode = $("modeSelect").value;
  const notes = $("notesInput").value;
  const sectionsText = serializeSections(state.current.sections);
  const target = $("targetSelect").value;

  const autoTarget = chooseDefaultTarget(mode);
  const sel = $("targetSelect");
  if ([...sel.options].some((o) => o.value === autoTarget)) sel.value = autoTarget;

  const resultEl = $("resultInput");
  resultEl.value = "";
  $("resultCount").textContent = "0 字";
  setResultStatus("生成中…");
  $("btnGenerate").classList.add("hidden");
  $("btnStop").classList.remove("hidden");

  const ctrl = new AbortController();
  state.aiAbort = ctrl;
  state.aiStreaming = true;

  try {
    const res = await fetch("/api/ai/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Device-Id": state.deviceId },
      body: JSON.stringify({ mode, notes, sectionsText, target, extra: "" }),
      signal: ctrl.signal
    });
    if (!res.ok) {
      let data = null;
      try { data = await res.json(); } catch (_) {}
      if (data && data.needConfig) {
        toast("请先在【设置】中填写 AI 接口密钥", "err");
        openSettings();
      } else if (data && data.needApproval) {
        state.auth.joined = false; showGate();
      } else {
        toast((data && data.error) || "生成失败 (" + res.status + ")", "err");
      }
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      resultEl.value += decoder.decode(value, { stream: true });
      autosize(resultEl);
      $("resultCount").textContent = resultEl.value.length + " 字";
      resultEl.scrollTop = resultEl.scrollHeight;
    }
  } catch (e) {
    if (e.name !== "AbortError") toast("生成中断: " + e.message, "err");
  } finally {
    state.aiStreaming = false;
    state.aiAbort = null;
    $("btnGenerate").classList.remove("hidden");
    $("btnStop").classList.add("hidden");
    const v = resultEl.value;
    if (/\[生成中断\]/.test(v)) setResultStatus("已中断");
    else if (v.trim()) setResultStatus("完成");
    else setResultStatus("无结果");
    autosize(resultEl);
    $("resultCount").textContent = resultEl.value.length + " 字";
  }
}

function stopAI() {
  if (state.aiAbort) { try { state.aiAbort.abort(); } catch (_) {} }
}

function setResultStatus(text) {
  const chip = $("resultStatus");
  if (!text) { chip.classList.add("hidden"); chip.textContent = ""; return; }
  chip.classList.remove("hidden");
  chip.textContent = text;
}

function cleanResult() {
  return $("resultInput").value.replace(/\n*\[生成中断\][\s\S]*$/, "").trim();
}

function applyResult(replace) {
  if (!state.current) { toast("请先选择一份周小结", "err"); return; }
  const text = cleanResult();
  if (!text) { toast("生成结果为空，请先生成内容", "err"); return; }
  // 收集原始记录/原小结中的图片标记，生成结果应用后补回，避免丢图
  const originImgs = collectImageTokens([
    $("notesInput").value,
    ...state.current.sections.map((s) => s.content || "")
  ].join("\n"));
  const target = $("targetSelect").value;
  const parsed = parseResultSections(text);
  const secs = state.current.sections;
  let changed = false;

  const markSection = (id) => { state.edited.sections[id] = true; changed = true; };

  if (target === "__smart__") {
    if (parsed.length <= 1 && !/【/.test(text) && !/^（[一二三四五六七八九十百\d]+）/.test(text)) {
      if (secs.length) { secs[0].content = replace ? text : appendText(secs[0].content, text); markSection(secs[0].id); }
      else { const ns = { id: newId(), title: "（一）工作内容", content: text, updatedAt: new Date().toISOString() }; secs.push(ns); markSection(ns.id); }
    } else {
      for (const p of parsed) {
        const idx = secs.findIndex((s) => matchTitle(s.title, p.title));
        if (idx >= 0) { secs[idx].content = replace ? p.content : appendText(secs[idx].content, p.content); markSection(secs[idx].id); }
        else { const ns = { id: newId(), title: p.title || "（补充）AI 生成", content: p.content, updatedAt: new Date().toISOString() }; secs.push(ns); markSection(ns.id); }
      }
    }
  } else if (target === "__new__") {
    const ns = { id: newId(), title: "（补充）AI 生成", content: text, updatedAt: new Date().toISOString() };
    secs.push(ns);
    markSection(ns.id);
  } else {
    const idx = parseInt(target, 10);
    if (!isNaN(idx) && secs[idx]) { secs[idx].content = replace ? text : appendText(secs[idx].content, text); markSection(secs[idx].id); }
  }

  // 图片保留：把原始图片标记补到生成/目标板块末尾（工作内容板块优先），避免生成结果丢图
  if (originImgs.length && secs.length) {
    const workIdx = secs.findIndex((s) => /工作内容|工作|内容/.test(s.title || ""));
    const idx = workIdx >= 0 ? workIdx : 0;
    const sec = secs[idx];
    const existing = new Set(collectImageTokens(sec.content || ""));
    const missing = originImgs.filter((t) => !existing.has(t));
    if (missing.length) {
      sec.content = appendText(sec.content, "现场照片：" + missing.join(" "));
      markSection(sec.id);
    }
  }

  if (changed) {
    renderSections();
    renderTargets();
    markDirty();
    saveCurrent().catch(() => {});
    toast(replace ? "已替换目标板块" : "已插入目标板块", "ok");
  } else {
    toast("没有可应用的板块", "err");
  }
}

/* ---------- 新建 / 删除 ---------- */
async function createSummary() {
  try {
    if (state.dirty) { try { await saveCurrent(); } catch (_) {} }
    const data = await fetchJSON("/api/summaries", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
    await selectSummary(data.summary.id);
    toast("已新建周小结", "ok");
    $("titleInput").focus();
  } catch (e) { toast("新建失败: " + e.message, "err"); }
}

async function deleteSummary() {
  if (!state.current) return;
  if (!confirm("确定删除「" + (state.current.title || "这份周小结") + "」？该操作不可撤销。")) return;
  try {
    await fetchJSON("/api/summaries/" + encodeURIComponent(state.current.id), { method: "DELETE" });
    toast("已删除", "ok");
  } catch (e) { toast("删除失败: " + e.message, "err"); }
}

/* ---------- 导出 Word ---------- */
async function exportWord() {
  if (!state.current) { toast("请先选择一份周小结", "err"); return; }
  setSave("sync", "正在导出…");
  try { await saveCurrent(); } catch (_) { setSave("err", "保存失败"); return; }
  const a = document.createElement("a");
  a.href = "/api/export/docx/" + encodeURIComponent(state.current.id) + "?deviceId=" + encodeURIComponent(state.deviceId);
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setSave("ok", "已导出 " + fmtTime());
  toast("Word 文档已生成并开始下载", "ok");
}

/* ---------- 空间聊天（好友 / 消息） ---------- */
function updateChatBadge() {
  const total = Object.values(state.chat.unread || {}).reduce((a2, b2) => a2 + b2, 0);
  const badge = $("chatBadge");
  if (badge) { badge.textContent = total; badge.classList.toggle("hidden", total === 0); }
}
async function openChat() {
  const box = $("chatModal");
  box.classList.remove("hidden");
  try {
    const data = await fetchJSON("/api/friends");
    state.chat.friends = data.friends || [];
    renderChatFriends();
    if (!state.chat.activeFriend && state.chat.friends.length) openConversation(state.chat.friends[0].spaceId);
  } catch (e) { toast("加载好友失败: " + e.message, "err"); }
  loadSpaceInfo();
  if (state.auth.serverAdmin) {
    loadAdminSpaces();
    clearInterval(state.chat.adminTimer);
    state.chat.adminTimer = setInterval(loadAdminSpaces, 8000);
  } else {
    const adm = $("chatAdmin");
    if (adm) adm.classList.add("hidden");
  }
}
async function loadAdminSpaces() {
  if (!state.auth.serverAdmin) return;
  try {
    const data = await fetchJSON("/api/admin/spaces");
    const box = $("chatAdminList");
    if (!box) return;
    box.innerHTML = "";
    if (!data.spaces.length) { box.innerHTML = '<div class="chat-friend-empty">暂无空间</div>'; }
    for (const sp of data.spaces) {
      const el = document.createElement("div");
      el.className = "chat-admin-row";
      el.innerHTML =
        '<span class="chat-dot ' + (sp.online ? "on" : "off") + '"></span>' +
        '<span class="chat-admin-name">' + escapeHtml(sp.name) + "</span>" +
        '<span class="chat-admin-id mono">ID ' + escapeHtml(sp.code) + "</span>" +
        '<span class="chat-admin-user">' + escapeHtml(sp.ownerName || "—") + "</span>" +
        '<span class="chat-admin-status ' + (sp.online ? "on" : "off") + '">' + (sp.online ? "在线" : "离线") + "</span>";
      box.appendChild(el);
    }
    const adm = $("chatAdmin");
    if (adm) adm.classList.remove("hidden");
  } catch (_) {}
}
async function loadSpaceInfo() {
  try {
    const data = await fetchJSON("/api/space");
    const codeEl = $("chatMyCode");
    if (codeEl) codeEl.textContent = (data.space && data.space.code) || "—";
    const statsEl = $("chatStats");
    if (statsEl && data.stats) statsEl.textContent = "全站 " + data.stats.totalSpaces + " 个空间 · " + data.stats.onlineSpaces + " 个在线";
  } catch (_) {}
}
function closeChat() {
  $("chatModal").classList.add("hidden");
  clearInterval(state.chat.adminTimer);
  state.chat.adminTimer = null;
}
function renderChatFriends() {
  const box = $("chatFriends");
  box.innerHTML = "";
  if (!state.chat.friends.length) {
    box.innerHTML = '<div class="chat-friend-empty">还没有好友<br/>点上方「添加好友」</div>';
    return;
  }
  for (const f of state.chat.friends) {
    const el = document.createElement("div");
    el.className = "chat-friend" + (state.chat.activeFriend === f.spaceId ? " active" : "");
    el.dataset.spaceId = f.spaceId;
    const un = state.chat.unread[f.spaceId] || 0;
    el.innerHTML =
      '<span class="chat-dot ' + (f.online ? "on" : "off") + '"></span>' +
      '<span class="chat-friend-name">' + escapeHtml(f.name) + "</span>" +
      (f.code ? '<span class="chat-friend-code mono">ID ' + escapeHtml(f.code) + "</span>" : "") +
      (un ? '<span class="badge chat-unread">' + un + "</span>" : "") +
      '<button class="chat-del" title="删除好友">✕</button>';
    el.addEventListener("click", (e) => {
      if (e.target.closest(".chat-del")) { removeChatFriend(f.spaceId); return; }
      openConversation(f.spaceId);
    });
    box.appendChild(el);
  }
}
function updateFriendOnline(spaceId, online) {
  const f = state.chat.friends.find((x) => x.spaceId === spaceId);
  if (f) { f.online = online; renderChatFriends(); }
}
async function openConversation(spaceId) {
  const f = state.chat.friends.find((x) => x.spaceId === spaceId);
  if (!f) return;
  state.chat.activeFriend = spaceId;
  state.chat.unread[spaceId] = 0;
  renderChatFriends();
  updateChatBadge();
  $("chatInputArea").classList.remove("hidden");
  $("chatEmpty").classList.add("hidden");
  $("chatTextInput").placeholder = "发给 " + f.name + "…";
  try {
    const data = await fetchJSON("/api/messages?friend=" + encodeURIComponent(spaceId));
    renderChatMessages(data.messages || []);
  } catch (e) { toast("加载消息失败: " + e.message, "err"); }
}
function renderChatMessages(list) {
  const conv = $("chatConv");
  conv.innerHTML = "";
  if (!list.length) {
    conv.innerHTML = '<div class="chat-empty" style="display:block">还没有消息，发一句打个招呼吧</div>';
    return;
  }
  for (const m of list) appendChatMessage(m, false);
  conv.scrollTop = conv.scrollHeight;
}
function appendChatMessage(m, scroll) {
  const conv = $("chatConv");
  const mine = m.from === state.auth.spaceId;
  const el = document.createElement("div");
  el.className = "chat-msg " + (mine ? "mine" : "theirs");
  el.dataset.id = m.id;
  const time = m.createdAt ? fmtShort(m.createdAt) + " " + String(m.createdAt).slice(11, 16) : "";
  let body = "";
  if (m.type === "image") {
    const url = "/api/images/" + encodeURIComponent(m.imageId);
    body = '<a class="chat-img" href="' + url + '" target="_blank" rel="noopener"><img src="' + url + '" loading="lazy" alt="图片" /></a>';
  } else {
    body = '<div class="chat-text">' + escapeHtml(m.content).replace(/\n/g, "<br>") + "</div>";
  }
  el.innerHTML = body + '<div class="chat-time">' + time + "</div>";
  conv.appendChild(el);
  if (scroll !== false) conv.scrollTop = conv.scrollHeight;
}
async function sendChatMessage() {
  const fid = state.chat.activeFriend;
  if (!fid) { toast("请先选择好友", "err"); return; }
  const input = $("chatTextInput");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  try {
    await fetchJSON("/api/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ toSpaceId: fid, type: "text", content: text }) });
  } catch (e) { toast("发送失败: " + e.message, "err"); input.value = text; }
}
async function uploadChatImage(file) {
  const fid = state.chat.activeFriend;
  if (!fid) { toast("请先选择好友", "err"); return; }
  const dataUrl = await readAsDataURL(file);
  try {
    const r = await fetchJSON("/api/chat/upload", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: dataUrl, name: file.name || "图片" }) });
    await fetchJSON("/api/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ toSpaceId: fid, type: "image", imageId: r.image.id }) });
    toast("图片已发送", "ok");
  } catch (e) { toast("图片发送失败: " + e.message, "err"); }
}
function removeChatFriend(spaceId) {
  const f = state.chat.friends.find((x) => x.spaceId === spaceId);
  if (!f) return;
  if (!confirm("确定删除好友「" + f.name + "」？")) return;
  fetchJSON("/api/friends/" + encodeURIComponent(spaceId), { method: "DELETE" })
    .then(() => {
      state.chat.friends = state.chat.friends.filter((x) => x.spaceId !== spaceId);
      if (state.chat.activeFriend === spaceId) { state.chat.activeFriend = null; $("chatInputArea").classList.add("hidden"); $("chatEmpty").classList.remove("hidden"); }
      renderChatFriends();
    })
    .catch((e) => toast("删除失败: " + e.message, "err"));
}
function onChatMessage(msg) {
  const m = msg.message;
  if (!m) return;
  const isMine = m.from === state.auth.spaceId;
  const chatVisible = !$("chatModal").classList.contains("hidden");
  if (!isMine) {
    if (!chatVisible || state.chat.activeFriend !== m.from) {
      state.chat.unread[m.from] = (state.chat.unread[m.from] || 0) + 1;
      if (!state.chat.friends.some((f) => f.spaceId === m.from)) loadChatFriendsSilent();
      else renderChatFriends();
      updateChatBadge();
      return;
    }
    fetchJSON("/api/messages/read", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ friendSpaceId: m.from }) }).catch(() => {});
  }
  if (chatVisible && state.chat.activeFriend === (isMine ? m.to : m.from)) {
    appendChatMessage(m, true);
  }
}
async function loadChatFriendsSilent() {
  try {
    const data = await fetchJSON("/api/friends");
    state.chat.friends = data.friends || [];
    renderChatFriends();
  } catch (_) {}
}
async function addFriendSubmit() {
  const query = $("friendQuery").value.trim();
  const errEl = $("friendErr");
  errEl.textContent = "";
  if (!query) { errEl.textContent = "请输入对方的空间ID或空间名称"; return; }
  try {
    const r = await fetchJSON("/api/friends", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query }) });
    $("friendModal").classList.add("hidden");
    $("friendQuery").value = "";
    toast("已添加好友「" + r.friend.name + "」", "ok");
    state.chat.friends.push(r.friend);
    renderChatFriends();
    openConversation(r.friend.spaceId);
  } catch (e) {
    errEl.textContent = e.message;
  }
}

/* ---------- 设置 ---------- */
function openSettings() {
  const cfg = state.config || {};
  $("cfgName").value = cfg.name || "";
  $("cfgDept").value = cfg.dept || "";
  $("cfgPort").value = cfg.port || 8080;
  const ai = cfg.ai || {};
  $("cfgProvider").value = ai.provider || "deepseek";
  $("cfgBaseURL").value = ai.baseURL || "";
  $("cfgModel").value = ai.model || "";
  $("cfgApiKey").value = "";
  $("cfgApiKey").placeholder = ai.keySet ? (ai.keyMask || "已配置") : "sk-…（未配置）";
  $("cfgTemp").value = ai.temperature != null ? ai.temperature : 0.7;
  $("cfgMaxTokens").value = ai.maxTokens || 4096;
  $("testResult").textContent = "";

  const ac = cfg.access || {};
  $("cfgAccessEnabled").checked = !!ac.enabled;
  $("cfgAllowNewSpaces").checked = !!ac.allowNewSpaces;
  $("cfgPublicURL").value = cfg.baseURL || "";

  const isAdmin = !!state.auth.serverAdmin;
  const isOwner = !!state.auth.owner;
  $("aiSettingsGroup").classList.toggle("hidden", !isAdmin);
  $("accessGroup").classList.toggle("hidden", !isAdmin);
  $("cfgPublicURLField").classList.toggle("hidden", !isAdmin);
  $("cfgPort").closest(".field").classList.toggle("hidden", !isAdmin);
  $("btnManageDevices").classList.toggle("hidden", !isOwner);

  $("settingsModal").classList.remove("hidden");
}

function closeModal(id) { $(id).classList.add("hidden"); }

function providerChanged() {
  const p = $("cfgProvider").value;
  const preset = PROVIDERS[p];
  if (!preset) return;
  $("cfgBaseURL").value = preset.baseURL;
  $("cfgModel").value = preset.model;
}

async function saveConfig() {
  const body = {
    name: $("cfgName").value.trim(),
    dept: $("cfgDept").value.trim(),
    port: parseInt($("cfgPort").value, 10) || undefined,
    ai: {
      provider: $("cfgProvider").value,
      baseURL: $("cfgBaseURL").value.trim(),
      model: $("cfgModel").value.trim(),
      apiKey: $("cfgApiKey").value.trim(),
      temperature: parseFloat($("cfgTemp").value),
      maxTokens: parseInt($("cfgMaxTokens").value, 10)
    },
    access: {
      enabled: $("cfgAccessEnabled").checked,
      allowNewSpaces: $("cfgAllowNewSpaces").checked
    },
    baseURL: $("cfgPublicURL").value.trim()
  };
  try {
    const res = await fetchJSON("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    state.config = res.config;
    closeModal("settingsModal");
    toast("设置已保存", "ok");
  } catch (e) { toast("保存失败: " + e.message, "err"); }
}

async function testAI() {
  $("testResult").textContent = "测试中…";
  try {
    const res = await fetchJSON("/api/ai/test", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseURL: $("cfgBaseURL").value.trim(),
        apiKey: $("cfgApiKey").value.trim(),
        model: $("cfgModel").value.trim()
      })
    });
    $("testResult").textContent = "✓ " + (res.reply || "连接成功");
  } catch (e) { $("testResult").textContent = "✗ " + e.message; }
}



/* ---------- 图片 ---------- */
function imageUrl(id) {
  return "/api/images/" + encodeURIComponent(id) + "?deviceId=" + encodeURIComponent(state.deviceId);
}

function openImageModal(insertMode, sectionId) {
  if (!state.current) { toast("请先选择一份周小结", "err"); return; }
  state.imageInsertTarget = insertMode ? sectionId : null;
  $("imageModalTip").textContent = insertMode
    ? "点击「插入」把图片放进当前板块（会直接显示在文本框里），可点「下载」直接保存原图。"
    : "图片库：上传、下载、删除图片；点「插入」可把图片加入正文。";
  renderImageGrid();
  $("uploadStatus").textContent = "";
  $("imageModal").classList.remove("hidden");
}

function renderImageGrid() {
  const grid = $("imageGrid");
  const imgs = (state.current && state.current.images) || [];
  grid.innerHTML = "";
  if (!imgs.length) {
    grid.innerHTML = '<div class="empty-devices">暂无图片，点击上方按钮上传</div>';
    return;
  }
  for (const img of imgs) {
    const card = document.createElement("div");
    card.className = "image-card";
    const kb = Math.round((img.size || 0) / 1024);
    card.innerHTML =
      '<div class="image-thumb"><img src="' + imageUrl(img.id) + '" alt="' + escapeHtml(img.name) + '" loading="lazy" /></div>' +
      '<div class="image-meta">' +
        '<div class="image-name">' + escapeHtml(img.name || "图片") + "</div>" +
        '<div class="image-size mono">' + (img.width || "?") + "×" + (img.height || "?") + " · " + kb + " KB</div>" +
      "</div>" +
      '<div class="image-actions">' +
        '<a class="btn ghost sm" data-act="dl" href="' + imageUrl(img.id) + '&download=1&name=' + encodeURIComponent(img.name || "图片") + '" download title="直接下载原图">下载</a>' +
        '<button class="btn primary sm" data-act="insert">插入</button>' +
        '<button class="btn danger sm" data-act="del">删除</button>' +
      "</div>";
    card.querySelector('[data-act="insert"]').addEventListener("click", () => insertImageToken(img));
    card.querySelector('[data-act="del"]').addEventListener("click", () => deleteImage(img));
    grid.appendChild(card);
  }
}

function readAsDataURL(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}

function loadImageEl(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("无法读取图片")); };
    img.src = url;
  });
}

/* 上传前压缩：超过 1600px 或超过 2MB 的图片等比缩小（手机拍照原图通常很大） */
async function prepareImageFile(file) {
  const MAX = 1600;
  let width = 0, height = 0;
  let source = file;
  try {
    if (typeof createImageBitmap === "function") {
      const bmp = await createImageBitmap(file);
      width = bmp.width; height = bmp.height;
      const needProcess = file.type === "image/webp" || width > MAX || height > MAX || file.size > 2 * 1024 * 1024;
      if (needProcess) {
        const scale = Math.min(MAX / width, MAX / height, 1);
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        const ctx = canvas.getContext("2d");
        ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
        const outType = file.type === "image/png" || file.type === "image/webp" ? "image/png" : "image/jpeg";
        const blob = await new Promise((r) => canvas.toBlob(r, outType, 0.85));
        source = blob;
        width = canvas.width; height = canvas.height;
      }
      try { bmp.close(); } catch (_) {}
    } else {
      const img = await loadImageEl(file);
      width = img.naturalWidth; height = img.naturalHeight;
    }
  } catch (_) {
    const img = await loadImageEl(file);
    width = img.naturalWidth; height = img.naturalHeight;
  }
  const dataUrl = await readAsDataURL(source);
  return { dataUrl, width, height, name: file.name || "图片" };
}

async function handleImageUpload(file, insertAfter) {
  if (!state.current) return;
  if (!file) return;
  if (insertAfter) $("uploadStatus").textContent = "上传中…";
  try {
    const prep = await prepareImageFile(file);
    const res = await fetchJSON("/api/upload", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ summaryId: state.current.id, name: prep.name, data: prep.dataUrl, width: prep.width, height: prep.height })
    });
    if (!state.current.images.some((x) => x.id === res.image.id)) {
      if (state.current.images) state.current.images.push(res.image);
      else state.current.images = [res.image];
    }
    if (insertAfter) {
      const secId = state.imageInsertTarget;
      const selInfo = state.richSelection;
      const range = selInfo && selInfo.sectionId === secId ? selInfo.range : null;
      insertImageEl(res.image, secId, range);
      markDirty();
      saveCurrent().catch(() => {});
      toast("已粘贴并插入图片", "ok");
      return;
    }
    renderImageGrid();
    $("uploadStatus").textContent = "✓ 已上传";
    toast("图片已上传", "ok");
  } catch (e) {
    $("uploadStatus").textContent = "✗ " + e.message;
    toast("上传失败: " + e.message, "err");
  }
}

/* 批量上传并插入多张图片 */
async function handleImagesUpload(files) {
  if (!state.current) { toast("请先选择一份周小结", "err"); return; }
  const list = Array.from(files || []);
  if (!list.length) return;
  const active = document.activeElement;
  const inEditor = active && active.classList && (active.classList.contains("sec-content") || active.classList.contains("day-content"));
  const secId = state.imageInsertTarget || (inEditor ? (active.closest(".section-card") ? active.closest(".section-card").dataset.id : null) : null)
    || (state.richSelection && state.richSelection.sectionId) || null;
  const statusEl = $("uploadStatus");
  if (statusEl) statusEl.textContent = "上传中 0/" + list.length;
  const imgs = [];
  for (let i = 0; i < list.length; i++) {
    try {
      const prep = await prepareImageFile(list[i]);
      const res = await fetchJSON("/api/upload", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ summaryId: state.current.id, name: prep.name, data: prep.dataUrl, width: prep.width, height: prep.height })
      });
      if (!state.current.images.some((x) => x.id === res.image.id)) state.current.images.push(res.image);
      imgs.push(res.image);
      if (statusEl) statusEl.textContent = "上传中 " + (i + 1) + "/" + list.length;
    } catch (e) {
      toast("第 " + (i + 1) + " 张上传失败: " + e.message, "err");
    }
  }
  if (secId && imgs.length) {
    const range = state.richSelection && state.richSelection.sectionId === secId ? state.richSelection.range : null;
    insertImagesEl(imgs, secId, range);
    markDirty();
    saveCurrent().catch(() => {});
    toast("已插入 " + imgs.length + " 张图片", "ok");
  } else if (imgs.length) {
    renderImageGrid();
    toast("已上传 " + imgs.length + " 张图片到图片库", "ok");
  }
  if (statusEl) statusEl.textContent = "";
}

function deleteImage(img) {
  if (!confirm("删除图片「" + (img.name || "图片") + "」？正文中的该图片标记也会被移除。")) return;
  fetchJSON("/api/images/" + encodeURIComponent(img.id), { method: "DELETE" })
    .then(() => {
      if (state.current && state.current.images) state.current.images = state.current.images.filter((x) => x.id !== img.id);
      renderImageGrid();
      toast("已删除图片", "ok");
    })
    .catch((e) => toast("删除失败: " + e.message, "err"));
}

/* ---------- 富文本渲染 / 序列化 ---------- */
function renderRichContent(el, text) {
  el.innerHTML = "";
  const lines = String(text || "").split("\n");
  const frag = document.createDocumentFragment();
  lines.forEach((line, i) => {
    if (i > 0) frag.appendChild(document.createElement("br"));
    appendRichLine(frag, line);
  });
  el.appendChild(frag);
  autosize(el);
}

function appendRichLine(parent, line) {
  const re = /\{\{img:([a-zA-Z0-9]+)\}\}/g;
  let last = 0, m;
  while ((m = re.exec(line))) {
    if (m.index > last) parent.appendChild(document.createTextNode(line.slice(last, m.index)));
    const img = document.createElement("img");
    img.className = "rich-img";
    img.dataset.imgId = m[1];
    img.src = imageUrl(m[1]);
    img.alt = "图片";
    img.draggable = true;
    img.addEventListener("error", () => img.classList.add("broken"));
    parent.appendChild(img);
    last = m.index + m[0].length;
  }
  if (last < line.length) parent.appendChild(document.createTextNode(line.slice(last)));
}

function serializeRich(el) {
  let out = "";
  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) { out += node.textContent; return; }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = node.tagName.toLowerCase();
    if (tag === "img") { const id = node.dataset && node.dataset.imgId; if (id) out += "{{img:" + id + "}}"; return; }
    if (tag === "br") { out += "\n"; return; }
    if (tag === "div" || tag === "p") {
      for (const c of node.childNodes) walk(c);
      out += "\n";
      return;
    }
    for (const c of node.childNodes) walk(c);
  };
  walk(el);
  return out.replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "");
}

/* 在指定板块光标处插入图片元素 */
function insertImageEl(image, sectionId, range) {
  const card = sectionId ? $("sections").querySelector('.section-card[data-id="' + sectionId + '"]') : null;
  const editor = card ? card.querySelector(".sec-content") : null;
  if (!editor) return false;
  editor.focus();
  let r = range;
  if (!r || !editor.contains(r.commonAncestorContainer)) {
    r = document.createRange();
    r.selectNodeContents(editor);
    r.collapse(false);
  }
  r.deleteContents();
  const imgEl = document.createElement("img");
  imgEl.className = "rich-img";
  imgEl.dataset.imgId = image.id;
  imgEl.src = imageUrl(image.id);
  imgEl.alt = "图片";
  imgEl.draggable = true;
  r.insertNode(imgEl);
  const br = document.createElement("br");
  r.setStartAfter(imgEl);
  r.insertNode(br);
  r.setStartAfter(br);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
  state.edited.sections[sectionId] = true;
  markDirty();
  autosize(editor);
  return true;
}

/* 连续插入多张图片（从左到右排列），末尾补一个换行 */
function insertImagesEl(images, sectionId, range) {
  const list = Array.isArray(images) ? images : [images];
  if (!list.length) return false;
  const card = sectionId ? $("sections").querySelector('.section-card[data-id="' + sectionId + '"]') : null;
  let editor = card ? (card.querySelector(".sec-content") || card.querySelector(".day-content")) : null;
  if (range && range.commonAncestorContainer) {
    const c = closestEl(range.commonAncestorContainer, ".sec-content, .day-content");
    if (c && card && card.contains(c)) editor = c;
  }
  if (!editor) return false;
  editor.focus();
  let r = range;
  if (!r || !editor.contains(r.commonAncestorContainer)) {
    r = document.createRange();
    r.selectNodeContents(editor);
    r.collapse(false);
  }
  r.deleteContents();
  list.forEach((image) => {
    const imgEl = document.createElement("img");
    imgEl.className = "rich-img";
    imgEl.dataset.imgId = image.id;
    imgEl.src = imageUrl(image.id);
    imgEl.alt = "图片";
    imgEl.draggable = true;
    r.insertNode(imgEl);
    r.setStartAfter(imgEl);
  });
  const br = document.createElement("br");
  r.insertNode(br);
  r.setStartAfter(br);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
  state.edited.sections[sectionId] = true;
  markDirty();
  autosize(editor);
  return true;
}

function insertImageToken(img) {
  const target = state.imageInsertTarget;
  const selInfo = state.richSelection;
  const range = selInfo && selInfo.sectionId === target ? selInfo.range : null;
  const ok = insertImageEl(img, target, range);
  if (!ok) {
    // 没有指定板块：插入第一板块
    if (state.current.sections.length) {
      const s0 = state.current.sections[0];
      s0.content = s0.content + (s0.content ? "\n" : "") + "{{img:" + img.id + "}}";
      state.edited.sections[s0.id] = true;
      renderSections();
      markDirty();
    }
  }
  saveCurrent().catch(() => {});
  closeModal("imageModal");
  toast("已插入图片", "ok");
}

/* ---------- 图片文字识别（OCR） ---------- */
let ocrLoading = null;
let lastOcrText = "";
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve();
  if (ocrLoading) return ocrLoading;
  ocrLoading = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "/vendor/tesseract.min.js";
    s.onload = () => resolve();
    s.onerror = () => { ocrLoading = null; reject(new Error("识别引擎加载失败，请检查网络后重试")); };
    document.head.appendChild(s);
  });
  return ocrLoading;
}
async function runOcr(file) {
  const statusEl = $("ocrStatus");
  const setStatus = (t) => { if (statusEl) statusEl.textContent = t; };
  setStatus("正在加载识别引擎…");
  await loadTesseract();
  setStatus("正在识别…");
  const result = await Tesseract.recognize(file, "chi_sim", {
    workerPath: "/vendor/worker.min.js",
    corePath: "/vendor/tesseract-core-simd.wasm.js",
    langPath: "/tessdata",
    logger: (m) => { if (m.status === "recognizing text") setStatus("识别中 " + Math.round((m.progress || 0) * 100) + "%"); }
  });
  return (result && result.data && result.data.text) || "";
}
/* 把识别文字插入正文：优先插到当前光标/最近编辑位置，否则追加到第一个板块 */
function insertOcrText(text) {
  const active = document.activeElement;
  if (active && (active.isContentEditable || active.tagName === "TEXTAREA")) {
    document.execCommand("insertText", false, text);
    return true;
  }
  const rs = state.richSelection;
  if (rs && rs.range && rs.sectionId) {
    const card = $("sections").querySelector('.section-card[data-id="' + rs.sectionId + '"]');
    const editor = card ? card.querySelector(".sec-content, .day-content") : null;
    if (editor && editor.contains(rs.range.commonAncestorContainer)) {
      editor.focus();
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(rs.range);
      document.execCommand("insertText", false, text);
      return true;
    }
  }
  if (state.current && state.current.sections.length) {
    const s0 = state.current.sections[0];
    s0.content = s0.content + (s0.content ? "\n" : "") + text;
    state.edited.sections[s0.id] = true;
    renderSections();
    markDirty();
    return true;
  }
  return false;
}

/* 粘贴图片：自动上传并插入光标处 */
async function handleRichPaste(e, sectionId) {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  let file = null;
  for (const it of items) {
    if (it.kind === "file" && it.type && it.type.startsWith("image/")) { file = it.getAsFile(); break; }
  }
  if (!file) return;
  e.preventDefault();
  const sel = window.getSelection();
  state.richSelection = { sectionId, range: sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null };
  state.imageInsertTarget = sectionId;
  await handleImageUpload(file, true);
}

/* ---------- 预览 ---------- */
function escHtmlForPreview(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function previewSummary() {
  if (!state.current) { toast("请先选择一份周小结", "err"); return; }
  const body = $("previewBody");
  const html = [];
  html.push('<div class="pv-title">' + escHtmlForPreview(state.current.title || "每周小结") + "</div>");
  if (state.current.dateRange) html.push('<div class="pv-meta">' + escHtmlForPreview(state.current.dateRange) + "</div>");
  for (const sec of state.current.sections) {
    if (!sec.title && !sec.content) continue;
    html.push('<div class="pv-head">' + escHtmlForPreview(sec.title || "板块") + "</div>");
    const lines = String(sec.content || "").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      const rendered = line.replace(/\{\{img:([a-zA-Z0-9]+)\}\}/g, (m, id) => {
        const exists = (state.current.images || []).some((x) => x.id === id);
        return exists ? '<img class="pv-img" src="' + imageUrl(id) + '" alt="图片" />' : '<span class="pv-missing">[图片缺失]</span>';
      });
      html.push('<p class="pv-line">' + rendered + "</p>");
    }
  }
  body.innerHTML = html.join("");
  $("previewModal").classList.remove("hidden");
}

/* ---------- 设备管理 ---------- */
async function loadDevices() {
  try {
    const r = await fetchJSON("/api/devices");
    state.devices = r.devices || [];
    renderDeviceModal();
  } catch (_) {}
}

function updatePendingBadge() {
  $("pendingBadge").classList.add("hidden");
}

function openDeviceModal() {
  closeModal("settingsModal");
  $("deviceModal").classList.remove("hidden");
  loadDevices();
}

function renderDeviceModal() {
  const box = $("deviceList");
  box.innerHTML = "";
  if (!state.devices.length) { box.innerHTML = '<div class="empty-devices">暂无设备记录</div>'; return; }
  const meCanRemove = !!state.auth.owner;
  for (const d of state.devices) {
    const row = document.createElement("div");
    row.className = "device-row";
    const isOwnerDev = !!d.owner;
    const statusCls = isOwnerDev ? "approved" : "approved";
    const statusTxt = isOwnerDev ? "空间主" : "成员";
    const meta = d.id.slice(0, 14).toUpperCase() + " · " + (d.online ? "在线" : "最后使用 " + fmtShort(d.lastSeen));
    row.innerHTML =
      '<span class="d-ico">' + (d.device === "phone" ? "📱" : "🖥️") + "</span>" +
      '<div class="d-info">' +
        '<div class="d-name">' + escapeHtml(d.name) + "</div>" +
        '<div class="d-meta">' + escapeHtml(meta) + "</div>" +
      "</div>" +
      '<span class="d-status ' + statusCls + '">' + statusTxt + "</span>" +
      '<div class="d-actions">' +
        (meCanRemove && d.id !== state.deviceId ? '<button class="btn danger sm" data-act="remove">移除</button>' : "") +
      "</div>";
    const bRemove = row.querySelector('[data-act="remove"]');
    if (bRemove) bRemove.addEventListener("click", () => removeDevice(d.id));
    box.appendChild(row);
  }
}

async function removeDevice(id) {
  if (!confirm("移除该设备后，它将无法再访问本网站，确定？")) return;
  try {
    await fetchJSON("/api/devices/remove", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
    toast("已移除该设备", "ok");
    await loadDevices();
  } catch (e) { toast(e.message, "err"); }
}

/* ---------- 手机连接 ---------- */
async function openPhone() {
  const modal = $("phoneModal");
  modal.classList.remove("hidden");
  const qrImg = $("qrImg");
  try {
    const status = await fetchJSON("/api/status");
    const url = status.url;
    $("phoneUrl").textContent = url;
    $("phoneUrl").classList.remove("hidden");
    // 二维码由服务器本地生成（离线可用）
    qrImg.classList.add("hidden");
    $("qrFallback").classList.add("hidden");
    qrImg.onload = () => { qrImg.classList.remove("hidden"); };
    qrImg.onerror = () => {
      qrImg.classList.add("hidden");
      $("qrFallback").textContent = url;
      $("qrFallback").classList.remove("hidden");
    };
    qrImg.src = "/api/qr?text=" + encodeURIComponent(url);
  } catch (e) {
    $("phoneUrl").textContent = "获取地址失败";
  }
}

async function copyUrl() {
  const url = $("phoneUrl").textContent;
  try {
    await navigator.clipboard.writeText(url);
    toast("网址已复制", "ok");
  } catch (_) {
    toast("复制失败，请手动输入", "err");
  }
}

/* ---------- 移动端导航 ---------- */
function setTabActive(tab) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
}
function closeDrawer() { document.body.classList.remove("drawer-open", "tab-list"); }
function closeAiPanel() { document.body.classList.remove("ai-open"); }
function onTab(tab) {
  if (tab === "list") {
    const willOpen = !document.body.classList.contains("drawer-open");
    document.body.classList.toggle("drawer-open", willOpen);
    document.body.classList.toggle("tab-list", willOpen);
    document.body.classList.remove("ai-open");
    setTabActive(willOpen ? "list" : "edit");
  } else if (tab === "ai") {
    const willOpen = !document.body.classList.contains("ai-open");
    document.body.classList.toggle("ai-open", willOpen);
    document.body.classList.remove("drawer-open", "tab-list");
    setTabActive(willOpen ? "ai" : "edit");
  } else if (tab === "edit") {
    closeDrawer(); closeAiPanel();
    setTabActive("edit");
  } else if (tab === "phone") {
    openPhone();
  }
}

/* ---------- 事件绑定 ---------- */
function bindEvents() {
  $("btnNew").addEventListener("click", createSummary);
  $("btnDelete").addEventListener("click", deleteSummary);
  $("btnExport").addEventListener("click", exportWord);
  $("btnImages").addEventListener("click", () => openImageModal(false, null));
  $("btnPreview").addEventListener("click", previewSummary);
  $("btnPickImage").addEventListener("click", () => $("imageFileInput").click());
  $("imageFileInput").addEventListener("change", (e) => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    e.target.value = "";
    if (files.length) handleImagesUpload(files);
  });
  $("btnOcr").addEventListener("click", () => $("ocrFileInput").click());
  $("ocrFileInput").addEventListener("change", async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!f) return;
    const box = $("ocrResult");
    if (box) box.classList.remove("hidden");
    $("ocrTextArea").value = "识别中…";
    $("ocrStatus").textContent = "";
    try {
      const text = await runOcr(f);
      lastOcrText = (text || "").trim();
      $("ocrTextArea").value = lastOcrText || "（未识别到文字，请换一张更清晰的图片）";
      $("ocrStatus").textContent = lastOcrText ? "识别完成" : "";
    } catch (err) {
      $("ocrTextArea").value = "";
      $("ocrStatus").textContent = "识别失败：" + err.message;
    }
  });
  $("btnOcrInsert").addEventListener("click", () => {
    const text = (lastOcrText || ($("ocrTextArea").value || "")).trim();
    if (!text) return toast("没有可插入的文字", "err");
    const ok = insertOcrText(text);
    if (ok) { closeModal("imageModal"); toast("已插入识别文字", "ok"); }
    else toast("请先在正文中点击要插入的位置，再点插入", "err");
  });
  $("btnOcrCopy").addEventListener("click", async () => {
    const text = (lastOcrText || ($("ocrTextArea").value || "")).trim();
    if (!text) return toast("没有可复制的文字", "err");
    try { await navigator.clipboard.writeText(text); toast("已复制", "ok"); }
    catch (_) { toast("复制失败，请手动选择复制", "err"); }
  });
  $("btnPreviewExport").addEventListener("click", () => { closeModal("previewModal"); exportWord(); });
  const addSectionBtn = $("btnAddSection");
  if (addSectionBtn) addSectionBtn.addEventListener("click", () => {
    if (!state.current) return;
    const n = state.current.sections.length + 1;
    const ns = { id: newId(), title: "（补充）记录" + n, content: "", updatedAt: new Date().toISOString() };
    state.current.sections.push(ns);
    state.edited.sections[ns.id] = true;
    renderSections(); renderTargets(); markDirty();
  });
  $("titleInput").addEventListener("input", () => { state.edited.title = true; markDirty(); });
  $("dateRangeInput").addEventListener("input", () => { state.edited.dateRange = true; markDirty(); });
  $("topicInput").addEventListener("input", () => { state.edited.topic = true; markDirty(); });
  $("notesInput").addEventListener("input", () => { state.edited.notes = true; markDirty(); updateCounts(); });
  $("btnClearNotes").addEventListener("click", () => { $("notesInput").value = ""; state.edited.notes = true; markDirty(); updateCounts(); });

  $("btnGenerate").addEventListener("click", generateAI);
  $("btnStop").addEventListener("click", stopAI);
  $("btnApply").addEventListener("click", () => applyResult(false));
  $("btnReplace").addEventListener("click", () => applyResult(true));
  $("btnCopy").addEventListener("click", async () => {
    const text = cleanResult();
    if (!text) { toast("生成结果为空", "err"); return; }
    try { await navigator.clipboard.writeText(text); toast("已复制", "ok"); }
    catch (_) { toast("复制失败", "err"); }
  });

  $("btnSettings").addEventListener("click", openSettings);
  $("btnSaveConfig").addEventListener("click", saveConfig);
  $("btnTestAI").addEventListener("click", testAI);
  $("cfgProvider").addEventListener("change", providerChanged);
  $("btnToggleKey").addEventListener("click", () => {
    const inp = $("cfgApiKey");
    inp.type = inp.type === "password" ? "text" : "password";
  });
  $("btnManageDevices").addEventListener("click", openDeviceModal);
  $("btnDevices").addEventListener("click", openDeviceModal);

  $("btnPhone").addEventListener("click", openPhone);
  $("btnChat").addEventListener("click", openChat);
  $("chatModal").querySelector('[data-close="chatModal"]').addEventListener("click", closeChat);
  $("btnAddFriend").addEventListener("click", () => { $("friendErr").textContent = ""; $("friendModal").classList.remove("hidden"); });
  $("btnFriendSubmit").addEventListener("click", addFriendSubmit);
  $("friendQuery").addEventListener("keydown", (e) => { if (e.key === "Enter") addFriendSubmit(); });
  $("btnCopyMyCode").addEventListener("click", () => {
    const code = $("chatMyCode").textContent;
    if (!code || code === "—") return toast("没有可复制的空间ID", "err");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).then(() => toast("空间ID已复制", "ok")).catch(() => toast("复制失败", "err"));
    } else {
      const ta = document.createElement("textarea");
      ta.value = code; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove();
      toast("空间ID已复制", "ok");
    }
  });
  $("btnChatSend").addEventListener("click", sendChatMessage);
  $("chatTextInput").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); sendChatMessage(); } });
  $("btnChatImage").addEventListener("click", () => $("chatFileInput").click());
  $("chatFileInput").addEventListener("change", (e) => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    e.target.value = "";
    for (const f of files) uploadChatImage(f);
  });
  $("btnCopyUrl").addEventListener("click", copyUrl);

  $("btnAiToggle").addEventListener("click", () => document.body.classList.toggle("ai-collapsed"));
  $("btnAiReopen").addEventListener("click", () => document.body.classList.remove("ai-collapsed"));

  $("btnGateJoin").addEventListener("click", () => submitGateJoin(false));
  $("btnGateCreate").addEventListener("click", () => submitGateJoin(true));
  $("gatePin").addEventListener("keydown", (e) => { if (e.key === "Enter") submitGateJoin(false); });
  $("btnSwitchSpace").addEventListener("click", switchSpace);

  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => onTab(t.dataset.tab)));
  document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => closeModal(b.dataset.close)));
  document.querySelectorAll(".modal-backdrop").forEach((m) => {
    m.addEventListener("click", (e) => { if (e.target === m) m.classList.add("hidden"); });
  });

  $("scrim").addEventListener("click", () => {
    closeDrawer(); closeAiPanel(); setTabActive("edit");
  });

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      saveCurrent().catch(() => {});
      toast("已保存", "ok");
    }
  });

  window.addEventListener("beforeunload", (e) => {
    if (state.dirty) { e.preventDefault(); e.returnValue = ""; }
  });
}

function updateCounts() {
  $("notesCount").textContent = $("notesInput").value.length + " 字";
  $("resultCount").textContent = $("resultInput").value.length + " 字";
}

/* ---------- 初始化 ---------- */
async function loadConfig() {
  try {
    const cfg = await fetchJSON("/api/config");
    state.config = cfg;
    document.title = "每周小结助手 · WEEKLY·OS" + (cfg.name ? " · " + cfg.name : "");
  } catch (_) {}
}

async function initApp() {
  await loadConfig();
  try {
    const data = await fetchJSON("/api/summaries");
    state.summaries = data.summaries;
    renderList();
    if (state.summaries.length) {
      await selectSummary(state.summaries[0].id);
    } else {
      clearCurrent();
    }
    if (state.auth.owner) { loadDevices(); }
  } catch (e) {
    if (e.status === 403 && e.data && e.data.needApproval) {
      state.auth.joined = false;
      showGate();
      return;
    }
    toast("加载数据失败: " + e.message, "err");
  }
  setTimeout(() => renderList(), 800);
}

async function init() {
  bindEvents();
  updateCounts();
  await registerDevice();
  connectWS();
  if (state.auth.joined || !state.auth.enabled) {
    await initApp();
  } else {
    showGate();
  }
}

document.addEventListener("DOMContentLoaded", init);
