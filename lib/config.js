"use strict";
/**
 * 配置管理：config.json 读写（含 AI 提供商、姓名、部门、端口等）
 * 不把完整 apiKey 暴露给前端，只返回是否已配置 + 掩码。
 */
const fs = require("fs");
const path = require("path");

const CONFIG_PATH = process.env.WEEKLY_CONFIG ? path.resolve(process.env.WEEKLY_CONFIG) : path.join(__dirname, "..", "config.json");

const DEFAULTS = {
  name: "陈思源",
  dept: "",
  port: 8080,
  ai: {
    provider: "deepseek", // 仅作展示标签
    baseURL: "https://api.deepseek.com",
    apiKey: "",
    model: "deepseek-chat",
    temperature: 0.7,
    maxTokens: 4096
  },
  access: {
    enabled: true,      // 访问控制：设备需通过「空间名+密码」加入空间
    allowNewSpaces: true // 是否允许创建新空间（多人各自独立使用时开启）
  }
};

function deepMerge(base, extra) {
  const out = { ...base };
  for (const k of Object.keys(extra || {})) {
    if (extra[k] && typeof extra[k] === "object" && !Array.isArray(extra[k]) && base[k] && typeof base[k] === "object") {
      out[k] = deepMerge(base[k], extra[k]);
    } else {
      out[k] = extra[k];
    }
  }
  return out;
}

function loadConfig() {
  let cfg;
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
      cfg = deepMerge(DEFAULTS, parsed);
    } else {
      cfg = JSON.parse(JSON.stringify(DEFAULTS));
    }
  } catch (e) {
    console.warn("[config] 读取 config.json 失败，使用默认配置:", e.message);
    cfg = JSON.parse(JSON.stringify(DEFAULTS));
  }
  // 环境变量覆盖（云端部署时通过环境变量注入，避免密钥进镜像）
  if (process.env.AI_API_KEY) cfg.ai.apiKey = process.env.AI_API_KEY;
  if (process.env.AI_BASE_URL) cfg.ai.baseURL = process.env.AI_BASE_URL;
  if (process.env.AI_MODEL) cfg.ai.model = process.env.AI_MODEL;
  if (process.env.BASE_URL) cfg.baseURL = process.env.BASE_URL;
  return cfg;
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf8");
}

/** 返回给前端的配置（隐藏 apiKey） */
function publicConfig(cfg) {
  const key = (cfg.ai && cfg.ai.apiKey) || "";
  return {
    name: cfg.name || "",
    dept: cfg.dept || "",
    port: cfg.port || 8080,
    baseURL: cfg.baseURL || "",
    ai: {
      provider: (cfg.ai && cfg.ai.provider) || "",
      baseURL: (cfg.ai && cfg.ai.baseURL) || "",
      model: (cfg.ai && cfg.ai.model) || "",
      temperature: (cfg.ai && typeof cfg.ai.temperature === "number") ? cfg.ai.temperature : 0.7,
      maxTokens: (cfg.ai && cfg.ai.maxTokens) || 4096,
      keySet: !!key,
      keyMask: key.length > 4 ? key.slice(0, 2) + "****" + key.slice(-4) : (key ? "****" : "")
    },
    access: {
      enabled: !!(cfg.access && cfg.access.enabled),
      allowNewSpaces: !(cfg.access && cfg.access.allowNewSpaces === false)
    }
  };
}

module.exports = { loadConfig, saveConfig, publicConfig, CONFIG_PATH, DEFAULTS };
