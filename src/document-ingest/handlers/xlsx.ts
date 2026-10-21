/**
 * Phase 101 T04 — xlsx handler. One BatchedPage per worksheet; cells joined
 * by space within row, rows joined by newline.
 */

import ExcelJS from "exceljs";
import type { BatchedPage } from "../types.js";

export async function handleXlsx(
  buffer: Buffer,
): Promise<readonly BatchedPage[]> {
  const wb = new ExcelJS.Workbook();
  // exceljs types expect Buffer<ArrayBuffer> but Node's Buffer is
  // Buffer<ArrayBufferLike>. The runtime contract is identical — cast through
  // unknown to satisfy the type checker (ArrayBuffer is a subtype of
  // ArrayBufferLike so the cast is sound at runtime).
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);

  const pages: BatchedPage[] = [];
  let pageNumber = 1;
  wb.eachSheet((sheet) => {
    const rows: string[] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: false }, (cell) => {
        const v = cell.value;
        if (v === null || v === undefined) return;
        if (typeof v === "object" && "text" in (v as object)) {
          cells.push(String((v as { text: unknown }).text ?? ""));
        } else {
          cells.push(String(v));
        }
      });
      if (cells.length > 0) rows.push(cells.join(" "));
    });
    pages.push({
      pageNumber: pageNumber++,
      text: rows.join("\n"),
    });
  });

  return pages;
}
