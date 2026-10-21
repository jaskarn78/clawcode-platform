/**
 * Phase 101 T02 — file-type detection.
 *
 * Classifies an input buffer + filename into one of six DocumentType branches.
 * Used by the engine entrypoint (`ingest()`) to dispatch to the correct
 * handler. Detection is content-first (magic-byte sniff via file-type), with
 * filename-extension disambiguation only for ZIP-based Office formats which
 * share the same `application/zip` MIME.
 *
 * PDF disambiguation (text-pdf vs scanned-pdf): the buffer is fed to pdf-parse
 * and the extracted text is trimmed. Empty / whitespace-only text means the
 * PDF has no text layer (typically a scanned image embedded in PDF wrapping)
 * → 'scanned-pdf'. Pdf-parse v2 prepends each page with a `-- N of N --`
 * separator artifact; we strip those before the empty-check.
 */

import { fileTypeFromBuffer } from "file-type";
import type { DocumentType } from "./types.js";

/** Pattern matching pdf-parse v2 page separators (e.g. `-- 1 of 3 --`). */
const PAGE_SEPARATOR_RE = /--\s*\d+\s+of\s+\d+\s*--/g;

/**
 * Detect the DocumentType for a buffer.
 *
 * @param buf raw file content
 * @param filename used only to disambiguate .docx vs .xlsx (both are ZIP)
 * @returns one of the six DocumentType values
 */
export async function detectDocumentType(
  buf: Buffer,
  filename: string,
): Promise<DocumentType> {
  const ft = await fileTypeFromBuffer(buf);
  const mime = ft?.mime ?? "";
  const lowerName = filename.toLowerCase();

  // PDF: peek inside for a text layer.
  if (mime === "application/pdf" || lowerName.endsWith(".pdf")) {
    return (await pdfHasTextLayer(buf)) ? "text-pdf" : "scanned-pdf";
  }

  // ZIP-based Office formats — file-type reports either the specific OOXML
  // MIME or the generic application/zip. Either way, disambiguate by filename.
  if (
    mime ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    (mime === "application/zip" && lowerName.endsWith(".docx")) ||
    lowerName.endsWith(".docx")
  ) {
    return "docx";
  }
  if (
    mime ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    (mime === "application/zip" && lowerName.endsWith(".xlsx")) ||
    lowerName.endsWith(".xlsx")
  ) {
    return "xlsx";
  }

  if (mime.startsWith("image/")) return "image";

  return "text";
}

/**
 * Return true if `buf` is a PDF with a usable text layer. Strips pdf-parse v2
 * page-separator artifacts before deciding emptiness.
 */
async function pdfHasTextLayer(buf: Buffer): Promise<boolean> {
  try {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: buf });
    try {
      const result = await parser.getText();
      const cleaned = (result.text ?? "")
        .replace(PAGE_SEPARATOR_RE, "")
        .trim();
      return cleaned.length > 0;
    } finally {
      await parser.destroy();
    }
  } catch {
    // Unparseable PDF — treat as scanned (more conservative — pushes through
    // the OCR fallback chain rather than silently returning empty text).
    return false;
  }
}
