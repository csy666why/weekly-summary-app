"use strict";
/**
 * Word 导出：使用 docx 库生成符合中文汇报习惯的 .docx
 * - 标题居中黑体，落款行（姓名/部门/时间），板块标题黑体，正文宋体、首行缩进2字符、1.5倍行距
 */
const {
  Document, Packer, Paragraph, TextRun, ImageRun, AlignmentType
} = require("docx");
const images = require("./images");

const CN_FONT = {
  body: "宋体",
  head: "黑体",
  ascii: "Times New Roman"
};

function runFont(eastAsia, bold) {
  return {
    ascii: CN_FONT.ascii,
    hAnsi: CN_FONT.ascii,
    eastAsia,
    hint: "eastAsia"
  };
}

function titleParagraph(title) {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 240, line: 360 },
    children: [
      new TextRun({ text: title || "每周小结", font: runFont(CN_FONT.head), bold: true, size: 32 }) // 16pt 三号
    ]
  });
}

function metaParagraph(meta) {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 240, line: 360 },
    children: [
      new TextRun({ text: meta, font: runFont(CN_FONT.body), size: 24 }) // 12pt 小四
    ]
  });
}

function sectionHeading(text) {
  return new Paragraph({
    spacing: { before: 200, after: 120, line: 360 },
    children: [
      new TextRun({ text, font: runFont(CN_FONT.head), bold: true, size: 28 }) // 14pt 四号
    ]
  });
}

/** 把正文拆成段落；以日期开头（如 8.17、8.18日）的行，日期前缀加粗 */
const IMG_TOKEN_RE = /\{\{img:([a-zA-Z0-9]+)\}\}/g;

/** 把一个文本行拆成「文字 + 图片」的 runs */
function runsForLine(line) {
  const runs = [];
  let last = 0;
  for (const m of line.matchAll(IMG_TOKEN_RE)) {
    if (m.index > last) {
      runs.push(new TextRun({ text: line.slice(last, m.index), font: runFont(CN_FONT.body), size: 24 }));
    }
    const img = images.loadImage(m[1]);
    if (img) {
      const w = Math.max(1, parseInt(img.width, 10) || 400);
      const h = Math.max(1, parseInt(img.height, 10) || 300);
      const scale = Math.min(1, 480 / w);
      const typeMap = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif" };
      runs.push(new ImageRun({
        type: typeMap[img.mime] || "png",
        data: img.buffer,
        transformation: { width: Math.round(w * scale), height: Math.round(h * scale) }
      }));
    }
    last = m.index + m[0].length;
  }
  if (last < line.length) {
    runs.push(new TextRun({ text: line.slice(last), font: runFont(CN_FONT.body), size: 24 }));
  }
  if (!runs.length) runs.push(new TextRun({ text: line, font: runFont(CN_FONT.body), size: 24 }));
  return runs;
}

function bodyParagraphs(content) {
  const text = String(content || "").replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  const paras = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(\d{1,2}[\.\-\/]\d{1,2}(?:日|号)?[：:]\s*)(.*)$/);
    if (m && m[2]) {
      paras.push(
        new Paragraph({
          spacing: { after: 60, line: 360 },
          indent: { firstLine: 480 },
          children: [
            new TextRun({ text: m[1], font: runFont(CN_FONT.body), bold: true, size: 24 }),
            ...runsForLine(m[2])
          ]
        })
      );
    } else {
      paras.push(
        new Paragraph({
          spacing: { after: 60, line: 360 },
          indent: { firstLine: 480 },
          children: runsForLine(line)
        })
      );
    }
  }
  return paras;
}

function sanitizeFileName(name) {
  return String(name || "每周小结").replace(/[\\/:*?"<>|\r\n\t]/g, "_").trim() || "每周小结";
}

/**
 * 生成 docx 文件 Buffer
 * @param {object} summary { title, week, dateRange, sections:[{title,content}] }
 * @param {object} cfg     { name, dept }
 */
async function exportDocx(summary, cfg) {
  const title = (summary.title || "每周小结").trim();
  const metaBits = [];
  if (cfg && cfg.name) metaBits.push("姓名：" + cfg.name);
  if (cfg && cfg.dept) metaBits.push("部门：" + cfg.dept);
  if (summary.dateRange) metaBits.push("时间：" + summary.dateRange);
  const meta = metaBits.join("　　");

  const children = [titleParagraph(title)];
  if (meta) children.push(metaParagraph(meta));

  const sections = Array.isArray(summary.sections) ? summary.sections : [];
  for (const sec of sections) {
    if (!sec || !sec.title) continue;
    children.push(sectionHeading(sec.title.trim()));
    children.push(...bodyParagraphs(sec.content));
  }

  const doc = new Document({
    creator: (cfg && cfg.name) || "每周小结助手",
    title,
    description: "由每周小结助手生成",
    styles: { default: { document: { run: { font: runFont(CN_FONT.body), size: 24 } } } },
    sections: [{ properties: { page: { margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } }, children }]
  });

  const buffer = await Packer.toBuffer(doc);
  const fileName = sanitizeFileName(title) + ".docx";
  return { buffer, fileName };
}

module.exports = { exportDocx, sanitizeFileName };
