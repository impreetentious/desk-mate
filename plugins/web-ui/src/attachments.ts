import type { Attachment } from "./model-types.ts";

/**
 * Turning a dropped file into an attachment the model can read.
 *
 * Text extraction is done here rather than pulled in from a document-processing library, and the
 * split of tools is deliberate:
 *
 * - **OOXML** (`.docx`, `.pptx`, `.xlsx`) is a ZIP of XML. `jszip` is already a direct
 *   dependency of this plugin, so those three formats cost nothing extra. In particular this
 *   avoids the `xlsx` package, whose npm releases lag its vendor's own distribution and have a
 *   history of prototype-pollution advisories — not a dependency worth taking for a text dump.
 * - **PDF** needs a real parser; `pdfjs-dist` is Mozilla's, is actively maintained, and is
 *   loaded lazily so it never enters the initial bundle.
 * - Images and text files need neither.
 *
 * Every extractor is best-effort: a file that cannot be parsed still becomes an attachment with
 * its bytes intact and no `extractedText`, which is what the composer already falls back to.
 */

const OOXML_TEXT_TAG = /<a:t[^>]*>([^<]*)<\/a:t>/g;
const WORD_TEXT_TAG = /<w:t[^>]*>([^<]*)<\/w:t>/g;
const SHEET_CELL = /<c\b[^>]*>[\s\S]*?<\/c>|<c\b[^>]*\/>/g;
const SHEET_VALUE = /<v>([^<]*)<\/v>/;
const SHEET_INLINE = /<t[^>]*>([^<]*)<\/t>/;
const CELL_REF = /\br="([A-Z]+)(\d+)"/;
const CELL_TYPE = /\bt="([a-z]+)"/;

const TEXT_EXTENSIONS = [
  ".txt",
  ".md",
  ".json",
  ".xml",
  ".html",
  ".css",
  ".js",
  ".ts",
  ".jsx",
  ".tsx",
  ".yml",
  ".yaml",
  ".csv",
];

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&");
}

function matchAll(xml: string, pattern: RegExp): string[] {
  const out: string[] = [];
  for (const match of xml.matchAll(new RegExp(pattern.source, pattern.flags))) {
    const text = match[1];
    if (text) out.push(decodeXmlEntities(text));
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  // Chunked so a large file cannot blow the argument limit of String.fromCharCode.
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/** Sort `slide1.xml`, `slide2.xml`, `slide10.xml` the way a human expects. */
function byTrailingNumber(prefix: string): (a: string, b: string) => number {
  const num = (name: string) => Number.parseInt(new RegExp(`${prefix}(\\d+)\\.xml$`).exec(name)?.[1] ?? "0", 10);
  return (a, b) => num(a) - num(b);
}

type Zip = Awaited<ReturnType<typeof loadZip>>;

async function loadZip(buffer: ArrayBuffer) {
  const { default: JSZip } = await import("jszip");
  return new JSZip().loadAsync(buffer);
}

async function readEntry(zip: Zip, path: string): Promise<string | undefined> {
  const file = zip.file(path);
  return file ? file.async("text") : undefined;
}

async function extractDocx(buffer: ArrayBuffer, fileName: string): Promise<string | undefined> {
  const zip = await loadZip(buffer);
  const xml = await readEntry(zip, "word/document.xml");
  if (!xml) return undefined;
  // Paragraph breaks carry the document's shape; runs within a paragraph are joined tightly.
  const paragraphs = xml
    .split(/<\/w:p>/)
    .map((chunk) => matchAll(chunk, WORD_TEXT_TAG).join(""))
    .filter((line) => line.trim());
  return `<docx filename="${fileName}">\n${paragraphs.join("\n")}\n</docx>`;
}

async function extractPptx(buffer: ArrayBuffer, fileName: string): Promise<string | undefined> {
  const zip = await loadZip(buffer);
  const slides = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort(byTrailingNumber("slide"));
  if (!slides.length) return undefined;
  const parts: string[] = [`<pptx filename="${fileName}">`];
  for (const [index, path] of slides.entries()) {
    const xml = await readEntry(zip, path);
    const lines = xml ? matchAll(xml, OOXML_TEXT_TAG).filter((t) => t.trim()) : [];
    if (lines.length) parts.push(`<slide number="${index + 1}">`, ...lines, "</slide>");
  }
  const notes = Object.keys(zip.files)
    .filter((name) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name))
    .sort(byTrailingNumber("notesSlide"));
  for (const path of notes) {
    const xml = await readEntry(zip, path);
    const lines = xml ? matchAll(xml, OOXML_TEXT_TAG).filter((t) => t.trim()) : [];
    const number = /notesSlide(\d+)\.xml$/.exec(path)?.[1];
    if (lines.length) parts.push(`[Slide ${number} notes]: ${lines.join(" ")}`);
  }
  parts.push("</pptx>");
  return parts.join("\n");
}

/**
 * Read a workbook as CSV per sheet.
 *
 * Cells with `t="s"` index the shared-strings table; everything else carries its value inline.
 * Gaps in a row are preserved by column reference so columns still line up.
 */
async function extractXlsx(buffer: ArrayBuffer, fileName: string): Promise<string | undefined> {
  const zip = await loadZip(buffer);
  const workbook = await readEntry(zip, "xl/workbook.xml");
  if (!workbook) return undefined;
  const sharedXml = await readEntry(zip, "xl/sharedStrings.xml");
  const shared = sharedXml
    ? sharedXml
        .split(/<si>/)
        .slice(1)
        .map((chunk) => matchAll(chunk, /<t[^>]*>([^<]*)<\/t>/g).join(""))
    : [];
  const names = matchAll(workbook, /<sheet[^>]*name="([^"]*)"/g);
  const sheets = Object.keys(zip.files)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort(byTrailingNumber("sheet"));
  const parts: string[] = [`<excel filename="${fileName}">`];
  for (const [index, path] of sheets.entries()) {
    const xml = await readEntry(zip, path);
    if (!xml) continue;
    const rows: string[] = [];
    for (const rowXml of xml.split(/<\/row>/)) {
      const cells = rowXml.match(SHEET_CELL) ?? [];
      if (!cells.length) continue;
      const byColumn = new Map<number, string>();
      for (const cell of cells) {
        const column = CELL_REF.exec(cell)?.[1];
        if (!column) continue;
        const type = CELL_TYPE.exec(cell)?.[1];
        const raw = SHEET_VALUE.exec(cell)?.[1] ?? SHEET_INLINE.exec(cell)?.[1] ?? "";
        const value = type === "s" ? (shared[Number(raw)] ?? "") : decodeXmlEntities(raw);
        byColumn.set(columnIndex(column), value);
      }
      if (!byColumn.size) continue;
      const width = Math.max(...byColumn.keys()) + 1;
      rows.push(Array.from({ length: width }, (_, i) => csvCell(byColumn.get(i) ?? "")).join(","));
    }
    parts.push(`<sheet name="${names[index] ?? `Sheet${index + 1}`}" index="${index + 1}">`, ...rows, "</sheet>");
  }
  parts.push("</excel>");
  return parts.join("\n");
}

function columnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

async function extractPdf(buffer: ArrayBuffer, fileName: string): Promise<string | undefined> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
  try {
    const pages: string[] = [`<pdf filename="${fileName}">`];
    for (let page = 1; page <= doc.numPages; page++) {
      const content = await (await doc.getPage(page)).getTextContent();
      const text = content.items
        .map((item) => (typeof item === "object" && item && "str" in item ? String(item.str) : ""))
        .filter((str) => str.trim())
        .join(" ");
      pages.push(`<page number="${page}">`, text, "</page>");
    }
    pages.push("</pdf>");
    return pages.join("\n");
  } finally {
    await doc.destroy();
  }
}

function hasExtension(fileName: string, ...extensions: string[]): boolean {
  const lower = fileName.toLowerCase();
  return extensions.some((ext) => lower.endsWith(ext));
}

/**
 * Read a file into an attachment, extracting text where the format allows.
 *
 * Never throws for a readable file: an unparseable document still returns with its bytes and no
 * `extractedText`, so the caller decides what an un-extracted file means.
 */
export async function loadAttachment(file: File, fileName?: string): Promise<Attachment> {
  const name = fileName ?? file.name ?? "unnamed";
  const buffer = await file.arrayBuffer();
  const base = {
    id: `${name}_${Date.now()}_${Math.random()}`,
    fileName: name,
    size: file.size ?? buffer.byteLength,
    content: bytesToBase64(new Uint8Array(buffer)),
  };
  const mimeType = file.type || "application/octet-stream";

  if (mimeType.startsWith("image/")) return { ...base, type: "image", mimeType };

  const extract = async (): Promise<{ mimeType: string; extractedText?: string } | undefined> => {
    if (mimeType === "application/pdf" || hasExtension(name, ".pdf"))
      return { mimeType: "application/pdf", extractedText: await extractPdf(buffer, name) };
    if (mimeType === DOCX_MIME || hasExtension(name, ".docx"))
      return { mimeType: DOCX_MIME, extractedText: await extractDocx(buffer, name) };
    if (mimeType === PPTX_MIME || hasExtension(name, ".pptx"))
      return { mimeType: PPTX_MIME, extractedText: await extractPptx(buffer, name) };
    if (mimeType === XLSX_MIME || hasExtension(name, ".xlsx"))
      return { mimeType: XLSX_MIME, extractedText: await extractXlsx(buffer, name) };
    if (mimeType.startsWith("text/") || hasExtension(name, ...TEXT_EXTENSIONS))
      return {
        mimeType: mimeType.startsWith("text/") ? mimeType : "text/plain",
        extractedText: new TextDecoder().decode(buffer),
      };
    return undefined;
  };

  let resolved: { mimeType: string; extractedText?: string } | undefined;
  try {
    resolved = await extract();
  } catch {
    resolved = undefined;
  }
  return {
    ...base,
    type: "document",
    mimeType: resolved?.mimeType ?? mimeType,
    ...(resolved?.extractedText ? { extractedText: resolved.extractedText } : {}),
  };
}
