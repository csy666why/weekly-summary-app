"use strict";
/**
 * 数据备份：自动备份 + 导出/导入 zip
 */
const fs = require("fs");
const path = require("path");
const { writeZip, readZip } = require("./zip");
const DATA_DIR = process.env.WEEKLY_DATA_DIR ? path.resolve(process.env.WEEKLY_DATA_DIR) : path.join(__dirname, "..", "data");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const JSON_FILES = ["summaries.json", "spaces.json", "devices.json", "friends.json", "friend-requests.json", "messages.json", "announcements.json", "seed.json"];
function collectDataFiles() {
  const files = [];
  for (const f of JSON_FILES) {
    const fp = path.join(DATA_DIR, f);
    if (fs.existsSync(fp) && fs.statSync(fp).isFile()) files.push({ name: f, data: fs.readFileSync(fp) });
  }
  const imgDir = path.join(DATA_DIR, "images");
  if (fs.existsSync(imgDir)) {
    for (const f of fs.readdirSync(imgDir)) {
      const fp = path.join(imgDir, f);
      if (fs.statSync(fp).isFile()) files.push({ name: "images/" + f, data: fs.readFileSync(fp) });
    }
  }
  return files;
}
function backupNow() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const dir = path.join(BACKUP_DIR, stamp);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of collectDataFiles()) {
      const target = path.join(dir, f.name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, f.data);
    }
    const dirs = fs.readdirSync(BACKUP_DIR).filter((d) => /^\d{4}-/.test(d)).sort();
    while (dirs.length > 20) {
      fs.rmSync(path.join(BACKUP_DIR, dirs.shift()), { recursive: true, force: true });
    }
    return dir;
  } catch (e) {
    console.error("[backup]", e.message);
    return null;
  }
}
function exportZip() { return writeZip(collectDataFiles()); }
function restoreFromZip(buf) {
  const files = readZip(buf);
  let count = 0;
  for (const f of files) {
    if (f.name.startsWith("backups/")) continue;
    const target = path.join(DATA_DIR, f.name);
    if (target !== DATA_DIR && !target.startsWith(DATA_DIR + path.sep)) continue; // 防路径穿越
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.data);
    count++;
  }
  return count;
}
module.exports = { backupNow, exportZip, restoreFromZip, collectDataFiles };
