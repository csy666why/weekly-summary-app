"use strict";
/**
 * 文档解析：docx / pptx / xlsx / doc / wps / pdf / txt / md / rtf
 * 返回 { text, images:[{data:Buffer,mime,name}], warning? }
 */
const { readZip } = require("./zip");

function cleanXmlText(xml, paraClose) {
  let s = String(xml || "");
  s = s.replace(/<w:tab[^>]*\/>/g, "\t").replace(/<a:tab[^>]*\/>/g, "\t");
  s = s.replace(/<w:br[^>]*\/>/g, "\n").replace(/<a:br[^>]*\/>/g, "\n");
  s = s.replace(new RegExp("</" + paraClose + ">", "g"), "\n");
  s = s.replace(/<[^>]+>/g, "");
  s = s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}
function mimeFromName(name) {
  const n = String(name || "").toLowerCase();
  if (n.endsWith(".png")) return "image/png";
  if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
  if (n.endsWith(".gif")) return "image/gif";
  if (n.endsWith(".bmp")) return "image/bmp";
  if (n.endsWith(".webp")) return "image/webp";
  return "image/png";
}
function scanEmbeddedImages(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length - 8) {
    let start = -1, end = -1, mime = "", name = "";
    if (buf[i] === 0x89 && buf[i+1] === 0x50 && buf[i+2] === 0x4e && buf[i+3] === 0x47) {
      mime = "image/png"; name = "image" + out.length + ".png";
      for (let j = i + 8; j < buf.length - 8; j++) {
        if (buf[j] === 0x49 && buf[j+1] === 0x45 && buf[j+2] === 0x4e && buf[j+3] === 0x44 && buf[j+4] === 0xae && buf[j+5] === 0x42 && buf[j+6] === 0x60 && buf[j+7] === 0x82) { end = j + 8; break; }
      }
    } else if (buf[i] === 0xff && buf[i+1] === 0xd8 && buf[i+2] === 0xff) {
      mime = "image/jpeg"; name = "image" + out.length + ".jpg";
      for (let j = i + 2; j < buf.length - 1; j++) { if (buf[j] === 0xff && buf[j+1] === 0xd9) { end = j + 2; break; } }
    } else if (buf[i] === 0x47 && buf[i+1] === 0x49 && buf[i+2] === 0x46) {
      mime = "image/gif"; name = "image" + out.length + ".gif";
      for (let j = i + 6; j < buf.length - 1; j++) { if (buf[j] === 0x3b && buf[j+1] === 0x00) { end = j + 2; break; } }
      if (end < 0) { for (let j = i + 6; j < buf.length; j++) { if (buf[j] === 0x3b) { end = j + 1; break; } } }
    }
    if (mime) {
      start = i;
      if (end > start && end - start >= 40) {
        out.push({ data: Buffer.from(buf.subarray(start, end)), mime, name });
        i = end;
        continue;
      }
    }
    i++;
  }
  return out;
}

async function parseDocx(buf) {
  let files;
  try { files = readZip(buf); } catch (e) { return { text: "", images: [], warning: "无法解析 docx（不是有效的文档）" }; }
  const byName = {};
  for (const f of files) byName[f.name] = f.data;
  const docXml = byName["word/document.xml"];
  let text = docXml ? cleanXmlText(docXml.toString("utf8"), "w:p") : "";
  const images = [];
  for (const f of files) {
    const nm = f.name.replace(/\\/g, "/");
    if (/^word\/media\//i.test(nm) && f.data.length >= 20) images.push({ data: f.data, mime: mimeFromName(f.name), name: nm.split("/").pop() || f.name });
  }
  return { text, images };
}

async function parsePptx(buf) {
  let files;
  try { files = readZip(buf); } catch (e) { return { text: "", images: [], warning: "无法解析 pptx" }; }
  const slides = files.filter((f) => /^ppt\/slides\/slide\d+\.xml$/i.test(f.name.replace(/\\/g, "/"))).sort((a, b) => {
    const na = parseInt(String(a.name).match(/slide(\d+)/i)[1], 10);
    const nb = parseInt(String(b.name).match(/slide(\d+)/i)[1], 10);
    return na - nb;
  });
  const parts = [];
  for (const s of slides) {
    const t = cleanXmlText(s.data.toString("utf8"), "a:p");
    if (t) parts.push("第" + (parts.length + 1) + "页：\n" + t);
  }
  const images = [];
  for (const f of files) {
    const nm = f.name.replace(/\\/g, "/");
    if (/^ppt\/media\//i.test(nm) && f.data.length >= 20) images.push({ data: f.data, mime: mimeFromName(f.name), name: nm.split("/").pop() || f.name });
  }
  return { text: parts.join("\n\n"), images };
}

async function parseXlsx(buf) {
  let files;
  try { files = readZip(buf); } catch (e) { return { text: "", images: [], warning: "无法解析 xlsx" }; }
  const byName = {};
  for (const f of files) byName[f.name.replace(/\\/g, "/")] = f.data;
  const shared = [];
  const sst = byName["xl/sharedStrings.xml"];
  if (sst) {
    const xml = sst.toString("utf8");
    const m = xml.matchAll(/<si[^>]*>([\s\S]*?)<\/si>/g);
    for (const mm of m) shared.push(cleanXmlText(mm[1], "t"));
  }
  const parts = [];
  const sheetKeys = Object.keys(byName).filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(k)).sort();
  for (const key of sheetKeys) {
    const xml = byName[key].toString("utf8");
    const cells = xml.matchAll(/<c[^>]*r="([A-Z]+\d+)"[^>]*>([\s\S]*?)<\/c>/g);
    const byRow = {};
    for (const c of cells) {
      const ref = c[1]; const rowNum = parseInt(ref.replace(/[A-Z]+/, ""), 10);
      let val = "";
      const t = c[2].match(/<t[^>]*>([\s\S]*?)<\/t>/);
      const v = c[2].match(/<v>([\s\S]*?)<\/v>/);
      if (t) val = t[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
      else if (v && c[2].indexOf('t="s"') >= 0) val = shared[parseInt(v[1], 10)] || "";
      else if (v) val = v[1];
      if (val) (byRow[rowNum] = byRow[rowNum] || []).push(val);
    }
    const rowNums = Object.keys(byRow).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    const sheetText = rowNums.map((rn) => byRow[rn].join(" | ")).join("\n");
    if (sheetText) parts.push(sheetText);
  }
  const images = [];
  for (const f of files) {
    const nm = f.name.replace(/\\/g, "/");
    if (/^xl\/media\//i.test(nm) && f.data.length >= 20) images.push({ data: f.data, mime: mimeFromName(f.name), name: nm.split("/").pop() || f.name });
  }
  return { text: parts.join("\n\n"), images };
}

async function parseDocOrWps(buf) {
  let text = "";
  const images = scanEmbeddedImages(buf);
  try {
    const WordExtractor = require("word-extractor");
    const extractor = new WordExtractor();
    const doc = await extractor.extract(buf);
    if (doc && typeof doc.getBody === "function") text = String(doc.getBody() || "").trim();
    else if (doc && typeof doc.getText === "function") text = String(doc.getText() || "").trim();
    else if (doc && typeof doc.getBodyText === "function") text = String(doc.getBodyText() || "").trim();
  } catch (e) {
    text = "";
  }
  const warning = text ? undefined : "未能解析出文字（.doc/.wps 为旧版二进制，建议另存为 .docx 更准确）";
  return { text, images, warning };
}

function parseRtf(buf) {
  let s = buf.toString("latin1");
  s = s.replace(/\\par[d]?[ ]?/g, "\n").replace(/\\line[ ]?/g, "\n").replace(/\\page[ ]?/g, "\n").replace(/\\tab[ ]?/g, "\t");
  s = s.replace(/\\'([0-9a-fA-F]{2})/g, (m, h) => { try { return Buffer.from(h, "hex").toString("utf8"); } catch (_) { return ""; } });
  s = s.replace(/\\u(\d+)\??/g, (m, d) => { const n = parseInt(d, 10); try { return String.fromCharCode(n >= 0 ? n : 65536 + n); } catch (_) { return ""; } });
  s = s.replace(/\\[a-zA-Z]+-?\d* ?/g, "");
  s = s.replace(/[{}]/g, "");
  s = s.replace(/\\/g, "");
  s = s.replace(/\n{3,}/g, "\n\n");
  return { text: s.trim(), images: [] };
}

async function parsePdf(buf) {
  const images = [];
  let text = "";
  let warning;
  try {
    const { PDFParse } = require("pdf-parse");
    const parser = new PDFParse({ data: new Uint8Array(buf) });
    try {
      const tr = await parser.getText();
      text = (tr && tr.text) || "";
      try {
        const ir = await parser.getImage({ imageBuffer: true, imageDataUrl: false, imageThreshold: 24 });
        if (ir && ir.pages) {
          for (const pg of ir.pages) {
            for (const im of (pg.images || [])) {
              if (!im.data || !im.data.length) continue;
              let data = Buffer.from(im.data);
              let mime = mimeFromName(im.name || "");
              const isRaster = (data[0] === 0x89 && data[1] === 0x50) || (data[0] === 0xff && data[1] === 0xd8);
              if (!isRaster) {
                try {
                  const { createCanvas } = require("@napi-rs/canvas");
                  const w = im.width || 100, h = im.height || 100;
                  const canvas = createCanvas(w, h);
                  const ctx = canvas.getContext("2d");
                  const imgData = ctx.createImageData(w, h);
                  const src = data.subarray(0, w * h * 4);
                  imgData.data.set(src);
                  ctx.putImageData(imgData, 0, 0);
                  data = canvas.toBuffer("image/png");
                  mime = "image/png";
                } catch (_) { continue; }
              }
              images.push({ data, mime, name: (im.name || ("pdf-image" + images.length + ".png")) });
            }
          }
        }
      } catch (_) {}
    } finally {
      try { await parser.destroy(); } catch (_) {}
    }
  } catch (e) {
    for (const im of scanEmbeddedImages(buf)) images.push(im);
    warning = "PDF 解析失败：" + e.message;
  }
  return { text, images, warning };
}

async function parseDocument(buffer, filename) {
  const name = String(filename || "document");
  const ext = name.toLowerCase().split(".").pop() || "";
  switch (ext) {
    case "docx": return parseDocx(buffer);
    case "pptx": return parsePptx(buffer);
    case "xlsx": return parseXlsx(buffer);
    case "rtf": return parseRtf(buffer);
    case "doc": case "wps": case "dot": return parseDocOrWps(buffer);
    case "txt": case "md": case "markdown": case "csv": case "log": return { text: buffer.toString("utf8"), images: [] };
    case "pdf": return parsePdf(buffer);
    default: {
      let text = "";
      try { const t = buffer.toString("utf8"); if (/[\u4e00-\u9fff\x20-\x7e]/.test(t.slice(0, 200))) text = t; } catch (_) {}
      return { text, images: scanEmbeddedImages(buffer), warning: text ? undefined : "不支持的文件格式 ." + ext + "，请转成 docx/txt/pdf 后上传" };
    }
  }
}

module.exports = { parseDocument };