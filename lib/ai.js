"use strict";
/**
 * AI 调用：兼容 OpenAI Chat Completions 接口（OpenAI / DeepSeek / Kimi / 通义 / 智谱 / Ollama 等）
 * - 支持流式输出（SSE），也兼容不支持流式的服务
 * - 中文提示词模板，针对“每周小结”场景
 */
const DEFAULT_SYSTEM = [
  "你是一名经验丰富的企业实习生成文字助手，擅长把零散的日常工作记录整理成结构清晰、语言正式、符合中文公文/汇报习惯的每周小结。",
  "要求：",
  "1. 内容必须忠于原始记录，不得编造事实；原始记录没有的信息不要杜撰。",
  "2. 使用中文，语言正式、通顺、简洁，避免口语化。",
  "3. 按板块输出，例如【工作内容】【收获与体会】【下周计划】。",
  "4. 工作内容部分可按日期分条（如“8.17：……”），保留关键数据、设备名、工艺名词。",
  "5. 收获与体会要结合具体事件，写出真实感受和思考，不要空话套话。",
  "6. 如用户提供了现有小结，请在其基础上处理，不要丢失原有信息。"
].join("\n");

function buildSystem(mode) {
  if (mode === "polish" || mode === "expand" || mode === "condense") {
    return DEFAULT_SYSTEM + "\n当前任务是对现有小结进行处理，请保持事实不变，只调整表达。";
  }
  return DEFAULT_SYSTEM;
}

function buildUser(mode, { notes, sectionsText, extra, target }) {
  const parts = [];
  if (mode === "free") {
    parts.push(extra || "");
    if (notes) parts.push("\n【我的原始记录】\n" + notes);
    if (sectionsText) parts.push("\n【现有小结】\n" + sectionsText);
    return parts.join("\n");
  }

  parts.push("【我的原始记录】");
  parts.push(notes && notes.trim() ? notes.trim() : "（暂无原始记录，请根据现有内容处理）");
  if (sectionsText && sectionsText.trim()) {
    parts.push("\n【现有小结（供参考/处理）】\n" + sectionsText);
  }

  const instructions = {
    generate: "请根据以上原始记录，帮我写一份完整的每周小结，包含【工作内容】【收获与体会】【下周计划】三个板块。",
    content: "请根据以上原始记录，只写【工作内容】板块：按日期分条记录本周做了哪些事，保留关键数据和专业名词。",
    insight: "请根据以上原始记录，只写【收获与体会】板块：结合具体事件写出真实收获、思考与感悟。",
    plan: "请根据以上原始记录和现有内容，只写【下周计划】板块：结合当前进度安排下周的工作学习计划。",
    polish: "请把现有小结润色得更正式、通顺、精炼，保持结构（标题和板块）与事实不变。",
    expand: "请在忠实于事实的前提下，把现有小结适当扩写，让内容更充实、细节更具体。",
    condense: "请把现有小结精简到原有篇幅的一半左右，保留所有关键信息与结构。"
  };
  parts.push("\n任务：" + (instructions[mode] || instructions.generate));
  if (target && target !== "auto") {
    parts.push("请把结果直接作为【" + target + "】板块的内容输出，不要额外加说明。");
  }
  return parts.join("\n");
}

function normalizeBaseURL(url) {
  let u = String(url || "https://api.deepseek.com").trim();
  u = u.replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  return u;
}

function endpointFor(baseURL) {
  return normalizeBaseURL(baseURL) + "/chat/completions";
}

/**
 * 调用 AI 生成。
 * @param {object} opts
 * @param {string} opts.baseURL
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {number} opts.temperature
 * @param {number} opts.maxTokens
 * @param {Array}  opts.messages
 * @param {function} [opts.onChunk] 收到增量文本时回调
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<string>} 完整文本
 */
async function chat(opts) {
  const { baseURL, apiKey, model, temperature, maxTokens, messages, onChunk, signal } = opts;
  const url = endpointFor(baseURL);
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = "Bearer " + apiKey;

  const body = {
    model: model || "deepseek-chat",
    messages,
    temperature: typeof temperature === "number" ? temperature : 0.7,
    max_tokens: maxTokens || 4096,
    stream: true
  };

  let res;
  try {
    res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
  } catch (e) {
    throw new Error("无法连接 AI 服务（" + e.message + "），请检查网络或 baseURL");
  }

  if (!res.ok) {
    let detail = "";
    try {
      const j = await res.json();
      detail = (j && (j.error && (j.error.message || JSON.stringify(j.error)))) || JSON.stringify(j);
    } catch (_) {
      detail = await res.text().catch(() => "");
    }
    const err = new Error(`AI 服务返回错误 ${res.status}: ${detail || res.statusText}`);
    err.status = res.status;
    throw err;
  }

  const cType = res.headers.get("content-type") || "";
  if (!cType.includes("text/event-stream")) {
    // 非流式响应
    const j = await res.json();
    const text = (j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
    if (onChunk && text) onChunk(text);
    return text;
  }

  // 解析 SSE
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  let full = "";

  const emitLine = (line) => {
    const t = line.trim();
    if (!t || !t.startsWith("data:")) return;
    const data = t.slice(5).trim();
    if (data === "[DONE]") return;
    try {
      const j = JSON.parse(data);
      const delta = j.choices && j.choices[0] && j.choices[0].delta;
      const piece = (delta && (delta.content || "")) || "";
      if (piece) {
        full += piece;
        if (onChunk) onChunk(piece);
      }
    } catch (_) { /* 忽略无法解析的行 */ }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      emitLine(line);
    }
  }
  if (buf.trim()) emitLine(buf);
  return full;
}

module.exports = { chat, buildSystem, buildUser, normalizeBaseURL, endpointFor };
