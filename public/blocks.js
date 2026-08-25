"use strict";
/* ============================================================
   WEEKLY·OS — 自定义块扩展 (blocks.js)
   新增块类型：文本块 / 每日完成情况 / 清单 / 总结模板
   说明：本文件必须在 app.js 之后加载（index.html 底部已加）
   ============================================================ */

/* ---------- 注入样式 ---------- */
(function () {
  const css = [
    ".block-chip{display:inline-flex;align-items:center;gap:4px;font-size:10px;letter-spacing:.5px;padding:2px 9px;border-radius:20px;border:1px solid rgba(94,200,255,.35);color:var(--cyan-bright);background:rgba(34,211,238,.08);font-family:var(--mono);white-space:nowrap;flex:none}",
    ".block-chip.daily{color:#fbbf24;border-color:rgba(251,191,36,.4);background:rgba(251,191,36,.08)}",
    ".block-chip.checklist{color:#34d399;border-color:rgba(52,211,153,.4);background:rgba(52,211,153,.08)}",
    ".day-row{display:flex;gap:10px;align-items:flex-start;padding:10px 14px;border-bottom:1px dashed rgba(94,200,255,.12)}",
    ".day-date-wrap{display:flex;align-items:center;gap:6px;flex:none;width:150px;margin-top:2px}",
    ".day-date-wrap .day-date{flex:1;width:auto;min-width:0;margin-top:0;background:rgba(34,211,238,.06);border:1px solid rgba(94,200,255,.22);color:var(--cyan-bright);font-family:var(--mono);font-size:12px;border-radius:8px;padding:7px 8px;outline:none}",
    ".day-cal{flex:none;background:transparent;border:none;cursor:pointer;font-size:15px;line-height:1;padding:6px;border-radius:6px;color:var(--cyan-bright)}",
    ".day-cal:hover{background:rgba(34,211,238,.12)}",
    ".day-date-picker{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;overflow:hidden;border:0;padding:0}",
    ".day-date:focus{border-color:var(--cyan)}",
    ".day-content{flex:1;min-width:0;min-height:44px;background:transparent;border:none;color:var(--text);font-size:14px;line-height:1.7;outline:none;padding:2px;border-radius:6px}",
    ".day-content:focus{background:rgba(34,211,238,.04)}",
    ".day-content.rich:empty::before{content:attr(data-placeholder);color:var(--text-faint);pointer-events:none}",
    ".day-content.rich img.rich-img{max-width:220px;border-radius:8px;vertical-align:middle;margin:4px 0}",
    ".day-del,.cli-del{flex:none;margin-top:2px;background:transparent;border:none;color:var(--text-faint);cursor:pointer;font-size:14px;padding:6px 8px;border-radius:8px}",
    ".day-del:hover,.cli-del:hover{color:var(--red);background:rgba(251,113,133,.1)}",
    ".day-add,.cli-add{width:100%;background:transparent;border:1px dashed rgba(94,200,255,.22);color:var(--text-dim);font-size:13px;padding:9px;border-radius:10px;cursor:pointer;font-family:var(--body)}",
    ".day-add:hover,.cli-add:hover{color:var(--cyan-bright);border-color:var(--line-strong);background:rgba(34,211,238,.05)}",
    ".cli-item{display:flex;gap:10px;align-items:center;padding:7px 14px;border-bottom:1px dashed rgba(94,200,255,.12)}",
    ".cli-check{flex:none;width:16px;height:16px;accent-color:#22d3ee;cursor:pointer}",
    ".cli-text{flex:1;min-width:0;background:transparent;border:none;outline:none;color:var(--text);font-size:14px;padding:6px 2px;border-bottom:1px solid transparent}",
    ".cli-text:focus{border-bottom-color:var(--cyan)}",
    ".block-add-menu{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px}",
    ".block-add-btn{flex:1 1 170px;margin:0!important;color:var(--text-dim)}",
    ".empty-canvas{text-align:center;padding:40px 20px 8px}",
    ".empty-canvas-title{font-family:var(--display);font-size:15px;letter-spacing:2px;color:var(--cyan-bright)}",
    ".empty-canvas-sub{margin-top:8px;color:var(--text-faint);font-size:13px;line-height:1.8}",
    ".pv-date{color:var(--cyan-bright);font-family:var(--mono);font-weight:600}",
    "@media(max-width:720px){.day-row{flex-wrap:wrap}.day-date-wrap{width:100%}.day-date{width:100%}.day-content{flex-basis:100%}}"
  ].join("");
  const el = document.createElement("style");
  el.id = "blocks-css";
  el.textContent = css;
  document.head.appendChild(el);
})();

const _insertImageEl = window.insertImageEl;

/* ---------- 解析 / 序列化 ---------- */
function parseJSONSafe(str, fallback) {
  try { const v = JSON.parse(str); return Array.isArray(v) ? v : fallback; } catch (_) { return fallback; }
}

function parseDailyRows(content) {
  if (!content) return [];
  if (typeof content === "string" && content.trim().charAt(0) === "[") {
    return parseJSONSafe(content, []).filter((r) => r && typeof r === "object");
  }
  const rows = [];
  for (const line of String(content).split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const m = t.match(/^(\S{1,14}?)[：:]\s*([\s\S]*)$/);
    if (m) rows.push({ date: m[1].trim(), content: m[2].trim() });
    else rows.push({ date: "", content: t });
  }
  return rows;
}

function parseChecklistItems(content) {
  if (!content) return [];
  if (typeof content === "string" && content.trim().charAt(0) === "[") {
    return parseJSONSafe(content, []).filter((it) => it && typeof it === "object");
  }
  const items = [];
  for (const line of String(content).split("\n")) {
    const t = line.replace(/^[-*•]\s*/, "").trim();
    if (!t) continue;
    items.push({ done: /^\[[xX]\]/.test(t), text: t.replace(/^\[[ xX]\]\s*/, "") });
  }
  return items;
}

/* 从 DOM 收集卡片内容（按类型序列化） */
function serializeCardContent(card) {
  if (!card) return "";
  const type = card.dataset.type || "text";
  if (type === "daily") {
    const out = [];
    for (const row of card.querySelectorAll(".day-row")) {
      const date = (row.querySelector(".day-date").value || "").trim();
      const content = serializeRich(row.querySelector(".day-content")).trim();
      if (!date && !content) continue;
      out.push({ date, content });
    }
    return out.length ? JSON.stringify(out) : "";
  }
  if (type === "checklist") {
    const out = [];
    for (const item of card.querySelectorAll(".cli-item")) {
      const text = (item.querySelector(".cli-text").value || "").trim();
      if (!text) continue;
      out.push({ done: item.querySelector(".cli-check").checked, text });
    }
    return out.length ? JSON.stringify(out) : "";
  }
  const cEl = card.querySelector(".sec-content");
  return cEl ? serializeRich(cEl) : "";
}

/* 把结构化内容转成可读文本（给 AI 使用） */
function readableContent(sec) {
  const type = (sec && sec.type) || "text";
  const content = (sec && sec.content) || "";
  if (type === "daily") {
    return parseDailyRows(content).map((r) => (r.date ? r.date + "：" : "") + r.content).join("\n");
  }
  if (type === "checklist") {
    return parseChecklistItems(content).map((it) => (it.done ? "[已完成] " : "[待办] ") + it.text).join("\n");
  }
  return content;
}

/* ---------- 卡片通用工具 ---------- */
function toolsHtml() {
  return (
    '<button class="sec-btn img" title="插入图片">图</button>' +
    '<button class="sec-btn up" title="上移">▲</button>' +
    '<button class="sec-btn down" title="下移">▼</button>' +
    '<button class="sec-btn del" title="删除板块">✕</button>'
  );
}

function closestEl(node, sel) {
  let n = node;
  while (n && n !== document) {
    if (n.nodeType === 1 && n.matches && n.matches(sel)) return n;
    n = n.parentNode;
  }
  return null;
}

function makeSaveRichSel(sec) {
  return () => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && sel.getRangeAt(0)) {
      state.richSelection = { sectionId: sec.id, range: sel.getRangeAt(0).cloneRange() };
    }
  };
}

function bindRich(el, sec) {
  el.addEventListener("input", () => { state.edited.sections[sec.id] = true; markDirty(); autosize(el); });
  el.addEventListener("mouseup", makeSaveRichSel(sec));
  el.addEventListener("keyup", makeSaveRichSel(sec));
  el.addEventListener("paste", (e) => handleRichPaste(e, sec.id));
}

function bindCardCommon(card, sec) {
  const tEl = card.querySelector(".sec-title-input");
  tEl.addEventListener("input", () => { state.edited.sections[sec.id] = true; markDirty(); });
  card.querySelectorAll(".img").forEach((b) => b.addEventListener("click", () => openImageModal(true, sec.id)));
  card.querySelectorAll(".up").forEach((b) => b.addEventListener("click", () => moveSection(card, -1)));
  card.querySelectorAll(".down").forEach((b) => b.addEventListener("click", () => moveSection(card, 1)));
  card.querySelectorAll(".del").forEach((b) => b.addEventListener("click", () => removeSection(card)));
}

/* ---------- 文本块（原模板板块） ---------- */
function buildTextCard(sec, index) {
  const card = document.createElement("div");
  card.className = "section-card";
  card.dataset.id = sec.id;
  card.dataset.type = "text";
  card.innerHTML =
    '<div class="sec-head">' +
      '<span class="sec-index">SEC-' + pad2(index + 1) + "</span>" +
      '<span class="block-chip text">✎ 文本</span>' +
      '<input class="sec-title-input" placeholder="板块标题" value="' + escapeHtml(sec.title || "") + '" />' +
      '<div class="sec-tools">' + toolsHtml() + "</div>" +
    "</div>" +
    '<div class="sec-content rich" contenteditable="true" data-placeholder="在这里记录…（可粘贴图片）"></div>';
  bindCardCommon(card, sec);
  const cEl = card.querySelector(".sec-content");
  renderRichContent(cEl, sec.content || "");
  bindRich(cEl, sec);
  return card;
}

/* ---------- 日期工具（M.D 格式 + 日历） ---------- */
function todayMd() {
  const d = new Date();
  return (d.getMonth() + 1) + "." + d.getDate();
}
function isoToMd(iso) {
  const m = String(iso || "").match(/^\d{4}-(\d{2})-(\d{2})/);
  return m ? parseInt(m[1], 10) + "." + parseInt(m[2], 10) : "";
}
function mdToIso(md) {
  const m = String(md || "").match(/^(\d{1,2})\.(\d{1,2})/);
  if (!m) return "";
  const y = new Date().getFullYear();
  return y + "-" + String(parseInt(m[1], 10)).padStart(2, "0") + "-" + String(parseInt(m[2], 10)).padStart(2, "0");
}

/* ---------- 每日完成情况块 ---------- */
function dailyRowHtml(row) {
  const md = (row && row.date) || "";
  return (
    '<div class="day-row">' +
      '<span class="day-date-wrap">' +
        '<input class="day-date" placeholder="日期 如 8.17" value="' + escapeHtml(md) + '" />' +
        '<input type="date" class="day-date-picker" tabindex="-1" value="' + mdToIso(md) + '" aria-label="选择日期" />' +
        '<button type="button" class="day-cal" title="选择日期">📅</button>' +
      '</span>' +
      '<div class="day-content rich" contenteditable="true" data-placeholder="当天完成情况…"></div>' +
      '<button class="day-del" title="删除这一天">✕</button>' +
    '</div>'
  );
}

/* 绑定一行：内容 + 日期文本 + 日历选择器 */
function bindDayRow(row, sec, content) {
  const cEl = row.querySelector(".day-content");
  renderRichContent(cEl, content || "");
  bindRich(cEl, sec);
  const dEl = row.querySelector(".day-date");
  const pEl = row.querySelector(".day-date-picker");
  const cal = row.querySelector(".day-cal");
  dEl.addEventListener("input", () => { state.edited.sections[sec.id] = true; markDirty(); });
  if (cal) {
    cal.addEventListener("click", (e) => {
      e.preventDefault();
      if (pEl.showPicker) { try { pEl.showPicker(); } catch (_) { pEl.focus(); } }
      else { pEl.focus(); pEl.click(); }
    });
  }
  if (pEl) {
    pEl.addEventListener("change", () => {
      if (pEl.value) {
        dEl.value = isoToMd(pEl.value);
        state.edited.sections[sec.id] = true;
        markDirty();
      }
    });
  }
}

function buildDailyCard(sec, index) {
  const card = document.createElement("div");
  card.className = "section-card";
  card.dataset.id = sec.id;
  card.dataset.type = "daily";
  const rows = parseDailyRows(sec.content);
  card.innerHTML =
    '<div class="sec-head">' +
      '<span class="sec-index">SEC-' + pad2(index + 1) + "</span>" +
      '<span class="block-chip daily">每日</span>' +
      '<input class="sec-title-input" placeholder="板块标题" value="' + escapeHtml(sec.title || "") + '" />' +
      '<div class="sec-tools">' + toolsHtml() + "</div>" +
    "</div>" +
    '<div class="daily-rows">' + rows.map(dailyRowHtml).join("") + "</div>" +
    '<button class="day-add">＋ 添加一天</button>';
  bindCardCommon(card, sec);

  const rowsBox = card.querySelector(".daily-rows");
  rowsBox.querySelectorAll(".day-row").forEach((row, i) => {
    bindDayRow(row, sec, (rows[i] && rows[i].content) || "");
  });

  rowsBox.addEventListener("click", (e) => {
    const del = e.target.closest(".day-del");
    if (del) { del.closest(".day-row").remove(); state.edited.sections[sec.id] = true; markDirty(); }
  });

  card.querySelector(".day-add").addEventListener("click", () => {
    rowsBox.insertAdjacentHTML("beforeend", dailyRowHtml({ date: todayMd(), content: "" }));
    const row = rowsBox.lastElementChild;
    bindDayRow(row, sec, "");
    const dEl = row.querySelector(".day-date");
    dEl.focus();
    dEl.select();
    state.edited.sections[sec.id] = true;
    markDirty();
  });
  return card;
}

/* ---------- 清单块 ---------- */
function checklistItemHtml(it) {
  return (
    '<div class="cli-item">' +
      '<input type="checkbox" class="cli-check" ' + (it && it.done ? "checked" : "") + " />" +
      '<input class="cli-text" placeholder="待办事项…" value="' + escapeHtml((it && it.text) || "") + '" />' +
      '<button class="cli-del" title="删除">✕</button>' +
    "</div>"
  );
}

function buildChecklistCard(sec, index) {
  const card = document.createElement("div");
  card.className = "section-card";
  card.dataset.id = sec.id;
  card.dataset.type = "checklist";
  const items = parseChecklistItems(sec.content);
  card.innerHTML =
    '<div class="sec-head">' +
      '<span class="sec-index">SEC-' + pad2(index + 1) + "</span>" +
      '<span class="block-chip checklist">清单</span>' +
      '<input class="sec-title-input" placeholder="板块标题" value="' + escapeHtml(sec.title || "") + '" />' +
      '<div class="sec-tools">' + toolsHtml() + "</div>" +
    "</div>" +
    '<div class="checklist-items">' + items.map(checklistItemHtml).join("") + "</div>" +
    '<button class="cli-add">＋ 添加一项</button>';
  bindCardCommon(card, sec);

  const itemsBox = card.querySelector(".checklist-items");
  itemsBox.addEventListener("click", (e) => {
    if (e.target.classList && e.target.classList.contains("cli-check")) {
      state.edited.sections[sec.id] = true;
      markDirty();
    }
    const del = e.target.closest(".cli-del");
    if (del) { del.closest(".cli-item").remove(); state.edited.sections[sec.id] = true; markDirty(); }
  });
  itemsBox.addEventListener("input", (e) => {
    if (e.target.classList && e.target.classList.contains("cli-text")) { state.edited.sections[sec.id] = true; markDirty(); }
  });

  card.querySelector(".cli-add").addEventListener("click", () => {
    itemsBox.insertAdjacentHTML("beforeend", checklistItemHtml({ done: false, text: "" }));
    const item = itemsBox.lastElementChild;
    item.querySelector(".cli-text").focus();
    state.edited.sections[sec.id] = true;
    markDirty();
  });
  return card;
}

/* ---------- 覆盖 buildSectionCard：按类型渲染 ---------- */
function buildSectionCard(sec, index, total) {
  const type = (sec && sec.type) || "text";
  if (type === "daily") return buildDailyCard(sec, index, total);
  if (type === "checklist") return buildChecklistCard(sec, index, total);
  return buildTextCard(sec, index, total);
}

/* ---------- 空画布提示 ---------- */
function syncEmptyCanvas() {
  const box = $("sections");
  if (!box) return;
  const hasCards = !!box.querySelector(".section-card");
  let tip = box.querySelector(".empty-canvas");
  const shouldShow = state.current && !hasCards && (!state.current.sections || state.current.sections.length === 0);
  if (shouldShow && !tip) {
    tip = document.createElement("div");
    tip.className = "empty-canvas";
    tip.innerHTML =
      '<div class="empty-canvas-title">自由搭建你的记录</div>' +
      '<div class="empty-canvas-sub">不必按固定模版填写。点下方按钮添加「每日完成情况」「清单」「文本块」，最后再用 AI 一键生成小结。</div>';
    box.appendChild(tip);
  } else if (!shouldShow && tip) {
    tip.remove();
  }
}

/* ---------- 覆盖 collectFromDOM：带上 type ---------- */
window.collectFromDOM = function (base) {
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
      const tEl = c.querySelector(".sec-title-input");
      return {
        id: c.dataset.id,
        title: tEl ? tEl.value : "",
        content: serializeCardContent(c),
        type: c.dataset.type || old.type || "text",
        updatedAt: old.updatedAt
      };
    }),
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
    titleAt: b.titleAt, weekAt: b.weekAt, dateRangeAt: b.dateRangeAt, topicAt: b.topicAt, notesAt: b.notesAt,
    images: b.images || []
  };
};

/* ---------- 覆盖 reconcileEdits：结构化卡片比较 ---------- */
window.reconcileEdits = function (saved) {
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
    const tEl = card.querySelector(".sec-title-input");
    const title = tEl ? tEl.value : "";
    const content = serializeCardContent(card);
    if (title === (ss.title || "") && content === (ss.content || "")) delete state.edited.sections[id];
  }
  if (Object.keys(state.edited.sections).length === 0) state.edited.reorder = false;
  const savedIds = new Set(savedSecs.keys());
  state.deletedSections = state.deletedSections.filter((id) => savedIds.has(id));
  state.dirty = !!(state.edited.title || state.edited.dateRange || state.edited.topic || state.edited.notes || Object.keys(state.edited.sections).length > 0 || state.edited.reorder || state.deletedSections.length > 0);
};

/* ---------- 覆盖 insertImageEl：每日块图片插到当天行 ---------- */
window.insertImageEl = function (image, sectionId, range) {
  const card = sectionId ? $("sections").querySelector('.section-card[data-id="' + sectionId + '"]') : null;
  if (!card) return _insertImageEl ? _insertImageEl(image, sectionId, range) : false;
  const type = card.dataset.type || "text";
  if (type === "text") return _insertImageEl ? _insertImageEl(image, sectionId, range) : false;
  if (type === "checklist") {
    toast("清单块不支持插入图片，请在文本块或每日完成情况中添加", "err");
    return false;
  }
  let editor = null;
  if (range) editor = closestEl(range.commonAncestorContainer, ".day-content");
  if (!editor) {
    const active = document.activeElement;
    if (active && active.classList && active.classList.contains("day-content") && card.contains(active)) editor = active;
  }
  if (!editor) editor = card.querySelector(".day-content");
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
  imgEl.draggable = false;
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
};

/* ---------- 覆盖 previewSummary：结构化预览 ---------- */
function previewContentLines(content) {
  const out = [];
  const lines = String(content || "").split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    const rendered = line.replace(/\{\{img:([a-zA-Z0-9]+)\}\}/g, (m, id) => {
      const exists = (state.current.images || []).some((x) => x.id === id);
      return exists ? '<img class="pv-img" src="' + imageUrl(id) + '" alt="图片" />' : '<span class="pv-missing">[图片缺失]</span>';
    });
    out.push('<p class="pv-line">' + rendered + "</p>");
  }
  return out;
}

window.previewSummary = function () {
  if (!state.current) { toast("请先选择一份周小结", "err"); return; }
  const body = $("previewBody");
  const html = [];
  html.push('<div class="pv-title">' + escHtmlForPreview(state.current.title || "每周小结") + "</div>");
  if (state.current.dateRange) html.push('<div class="pv-meta">' + escHtmlForPreview(state.current.dateRange) + "</div>");
  for (const sec of state.current.sections) {
    if (!sec.title && !sec.content) continue;
    html.push('<div class="pv-head">' + escHtmlForPreview(sec.title || "板块") + "</div>");
    const type = sec.type || "text";
    if (type === "daily") {
      for (const r of parseDailyRows(sec.content)) {
        if (r.date) html.push('<p class="pv-line pv-date">' + escHtmlForPreview(r.date) + "</p>");
        html.push.apply(html, previewContentLines(r.content));
      }
    } else if (type === "checklist") {
      for (const it of parseChecklistItems(sec.content)) {
        html.push('<p class="pv-line pv-cli">' + (it.done ? "☑" : "☐") + " " + escHtmlForPreview(it.text) + "</p>");
      }
    } else {
      html.push.apply(html, previewContentLines(sec.content));
    }
  }
  body.innerHTML = html.join("");
  $("previewModal").classList.remove("hidden");
};

/* ---------- 覆盖 serializeSections：AI 看到可读文本 ---------- */
window.serializeSections = function (sections) {
  return (sections || []).map((s) => (s.title || "板块") + "：\n" + readableContent(s)).join("\n\n");
};

/* ---------- 覆盖 renderSections：空画布提示 ---------- */
window.renderSections = (function () {
  const orig = window.renderSections;
  return function () {
    orig.apply(window, arguments);
    syncEmptyCanvas();
  };
})();

/* ---------- 覆盖 mergeRemote：多端同步时按类型合并 ---------- */
window.mergeRemote = function (remote) {
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
    const rs = remoteMap.get(card.dataset.id);
    if (!rs) {
      if (!foc(tEl) && !card.contains(active)) { delete state.edited.sections[card.dataset.id]; card.remove(); }
      continue;
    }
    const type = card.dataset.type || "text";
    if (type === "text") {
      const cEl = card.querySelector(".sec-content");
      if (!foc(tEl)) tEl.value = rs.title || "";
      if (cEl && !foc(cEl)) renderRichContent(cEl, rs.content || "");
    } else {
      const titleChanged = tEl.value !== (rs.title || "");
      const contentChanged = serializeCardContent(card) !== (rs.content || "");
      if (!card.contains(active) && (titleChanged || contentChanged)) {
        const fresh = buildSectionCard(rs, remoteSections.indexOf(rs), remoteSections.length);
        card.replaceWith(fresh);
      } else if (!foc(tEl) && titleChanged) {
        tEl.value = rs.title || "";
      }
    }
    if (state.edited.sections[card.dataset.id] && !foc(tEl) && !card.contains(active)) {
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
  syncEmptyCanvas();
  const prevTarget = $("targetSelect").value;
  if (!foc($("targetSelect"))) renderTargets();
  const sel = $("targetSelect");
  if (![...sel.options].some((o) => o.value === prevTarget)) sel.value = "__smart__";
  updateCounts();
  if (!$("imageModal").classList.contains("hidden")) renderImageGrid();
};

/* ---------- 添加块 ---------- */
function addBlock(type) {
  if (!state.current) { toast("请先选择或新建一份周小结", "err"); return; }
  const now = new Date().toISOString();
  if (type === "template") {
    const titles = ["（一）工作内容", "（二）收获与体会", "（三）下周计划"];
    for (const t of titles) {
      const ns = { id: newId(), title: t, type: "text", content: "", updatedAt: now };
      state.current.sections.push(ns);
      state.edited.sections[ns.id] = true;
    }
    toast("已插入总结模版（工作内容 / 收获体会 / 下周计划）", "ok");
  } else {
    const defaults = { text: "文本", daily: "每日完成情况", checklist: "清单" };
    const ns = { id: newId(), title: defaults[type] || "文本", type: type || "text", content: type === "daily" ? JSON.stringify([{ date: todayMd(), content: "" }]) : "", updatedAt: now };
    state.current.sections.push(ns);
    state.edited.sections[ns.id] = true;
  }
  renderSections();
  renderTargets();
  markDirty();
  const cards = $("sections").querySelectorAll(".section-card");
  if (cards.length) cards[cards.length - 1].scrollIntoView({ behavior: "smooth", block: "center" });
}

/* ================= 自定义块：添加按钮（追加到末尾） ================= */
(function () {
  var DEFS = {
    text:      { label: "✎ 文本块",       title: "文本" },
    daily:     { label: "📅 每日完成情况", title: "每日完成情况" },
    checklist: { label: "✅ 清单",         title: "清单" },
    summary:   { label: "📄 总结模板",     title: "总结模板" }
  };

  function addBlock(type) {
    if (!state.current) return;
    var n = (state.current.sections || []).length + 1;
    var sec = {
      id: newId(),
      title: (DEFS[type] ? DEFS[type].title : "文本") + " " + n,
      content: type === "daily" ? JSON.stringify([{ date: todayMd(), content: "" }]) : "",
      type: type,
      updatedAt: new Date().toISOString()
    };
    if (type === "summary") {
      sec.type = "text";
      sec.content = "（一）本周工作内容\n\n（二）收获与体会\n\n（三）下周计划";
    }
    state.current.sections.push(sec);
    state.edited.sections[sec.id] = true;
    renderSections();
    renderTargets();
    markDirty();
  }

  function ensureMenu() {
    var box = $("sections");
    if (!box) return;
    if (document.getElementById("blockAddMenu")) return;
    var menu = document.createElement("div");
    menu.className = "block-add-menu";
    menu.id = "blockAddMenu";
    Object.keys(DEFS).forEach(function (k) {
      var b = document.createElement("button");
      b.className = "btn ghost block block-add-btn";
      b.textContent = DEFS[k].label;
      b.addEventListener("click", function () { addBlock(k); });
      menu.appendChild(b);
    });
    box.parentNode.insertBefore(menu, box.nextSibling);
    var old = $("btnAddSection");
    if (old) old.style.display = "none";
  }
  ensureMenu();
})();
