/* Sentinel DD — document text extraction (Phase 3)
 * Real client-side parsing via pdf.js / mammoth / SheetJS / JSZip, OCR via Tesseract. */
(function () {
  const DD = (window.DD = window.DD || {});

  function ext(name) {
    const match = /\.([a-z0-9]+)$/i.exec(name || "");
    return match ? match[1].toLowerCase() : "";
  }

  function wordCount(text) {
    const matched = String(text || "").match(/\b[\w'-]+\b/g);
    return matched ? matched.length : 0;
  }

  function libReady() {
    return {
      pdf: typeof window.pdfjsLib !== "undefined",
      docx: typeof window.mammoth !== "undefined",
      xlsx: typeof window.XLSX !== "undefined",
      zip: typeof window.JSZip !== "undefined",
      ocr: typeof window.Tesseract !== "undefined"
    };
  }

  async function readText(file) {
    return typeof file.text === "function" ? file.text() : new Response(file).text();
  }

  // Extraction runs on the main thread and OCR in particular can take multiple
  // seconds per page, so an unbounded document could freeze the tab's perceived
  // responsiveness for a very long time. Cap both the pages actually processed and,
  // separately, how many of those pages can trigger OCR (the truly expensive path).
  const MAX_PDF_PAGES = 300;
  const MAX_OCR_PAGES = 50;

  // ---- PDF ----
  async function extractPdf(arrayBuffer, { onProgress } = {}) {
    if (!libReady().pdf) throw new Error("pdf.js not loaded");
    const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer.slice(0) }).promise;
    const totalPages = pdf.numPages;
    const pagesToProcess = Math.min(totalPages, MAX_PDF_PAGES);
    const truncated = totalPages > MAX_PDF_PAGES;
    const pages = [];
    let ocrUsed = false;
    let ocrCount = 0;
    for (let p = 1; p <= pagesToProcess; p += 1) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      let text = content.items.map((item) => item.str).join(" ").replace(/\s+/g, " ").trim();
      if (text.length < 12 && libReady().ocr && ocrCount < MAX_OCR_PAGES) {
        try { text = await ocrPage(page); ocrUsed = true; ocrCount += 1; } catch { /* ignore ocr failure */ }
      }
      pages.push({ page: p, text });
      if (onProgress) onProgress(Math.round((p / pagesToProcess) * 100));
    }
    if (truncated) {
      pages.push({
        page: pagesToProcess + 1,
        text: `[Truncated: ${totalPages - MAX_PDF_PAGES} additional page(s) not processed — this document exceeds the ${MAX_PDF_PAGES}-page extraction limit. Split it or upload the relevant sections separately for full coverage.]`
      });
    }
    return {
      pages,
      fullText: pages.map((pg) => pg.text).join("\n\n"),
      pageCount: totalPages,
      tableCount: 0,
      ocrUsed,
      truncated,
      meta: await pdf.getMetadata().catch(() => null)
    };
  }

  async function ocrPage(page) {
    const viewport = page.getViewport({ scale: 1.6 });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    const result = await window.Tesseract.recognize(canvas, "eng");
    return (result?.data?.text || "").replace(/\s+/g, " ").trim();
  }

  // ---- DOCX ----
  async function extractDocx(arrayBuffer) {
    if (!libReady().docx) throw new Error("mammoth not loaded");
    const { value } = await window.mammoth.extractRawText({ arrayBuffer });
    const paragraphs = value.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
    const pages = paragraphs.map((text, index) => ({ page: index + 1, text, unit: "paragraph" }));
    return { pages, fullText: value.trim(), pageCount: 1, paragraphCount: paragraphs.length, tableCount: (value.match(/\t/g) || []).length ? 1 : 0 };
  }

  // ---- XLSX / CSV ----
  async function extractSheet(arrayBuffer, extension) {
    if (!libReady().xlsx) throw new Error("SheetJS not loaded");
    const workbook = window.XLSX.read(arrayBuffer, { type: "array" });
    const pages = workbook.SheetNames.map((name, index) => {
      const csv = window.XLSX.utils.sheet_to_csv(workbook.Sheets[name]);
      return { page: index + 1, text: `Sheet: ${name}\n${csv}`, unit: "table", sheet: name };
    });
    return {
      pages,
      fullText: pages.map((pg) => pg.text).join("\n\n"),
      pageCount: workbook.SheetNames.length,
      tableCount: workbook.SheetNames.length,
      sheetNames: workbook.SheetNames
    };
  }

  async function extractCsv(file) {
    const text = await readText(file);
    return { pages: [{ page: 1, text, unit: "table" }], fullText: text.trim(), pageCount: 1, tableCount: 1 };
  }

  // ---- PPTX (unzip slide XML, strip <a:t>) ----
  async function extractPptx(arrayBuffer) {
    if (!libReady().zip) throw new Error("JSZip not loaded");
    const zip = await window.JSZip.loadAsync(arrayBuffer);
    const slideNames = Object.keys(zip.files)
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => (parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10)));
    const pages = [];
    for (let i = 0; i < slideNames.length; i += 1) {
      const xml = await zip.files[slideNames[i]].async("string");
      const runs = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => m[1]);
      pages.push({ page: i + 1, text: runs.join(" ").replace(/\s+/g, " ").trim(), unit: "slide" });
    }
    return { pages, fullText: pages.map((pg) => pg.text).join("\n\n"), pageCount: pages.length, tableCount: 0 };
  }

  // ---- ZIP (returns child files for the data room to expand) ----
  async function expandZip(arrayBuffer) {
    if (!libReady().zip) throw new Error("JSZip not loaded");
    const zip = await window.JSZip.loadAsync(arrayBuffer);
    const supported = ["pdf", "docx", "xlsx", "xls", "pptx", "csv", "tsv", "txt"];
    const children = [];
    const entries = Object.values(zip.files).filter((f) => !f.dir && supported.includes(ext(f.name)) && !f.name.startsWith("__MACOSX"));
    for (const entry of entries) {
      const blob = await entry.async("blob");
      const cleanName = entry.name.split("/").pop();
      children.push(new File([blob], cleanName, { type: blob.type }));
    }
    return children;
  }

  async function extract(file, options = {}) {
    const extension = ext(file.name);
    const buffer = await file.arrayBuffer();
    let result;
    try {
      if (extension === "pdf") result = await extractPdf(buffer, options);
      else if (extension === "docx") result = await extractDocx(buffer);
      else if (extension === "xlsx" || extension === "xls") result = await extractSheet(buffer, extension);
      else if (extension === "csv" || extension === "tsv" || extension === "txt") result = await extractCsv(file);
      else if (extension === "pptx") result = await extractPptx(buffer);
      else result = { pages: [], fullText: "", pageCount: 0, tableCount: 0, unsupported: true };
    } catch (error) {
      result = { pages: [], fullText: "", pageCount: 0, tableCount: 0, error: error.message };
    }
    result.ext = extension;
    result.wordCount = wordCount(result.fullText);
    return result;
  }

  DD.extract = { extract, expandZip, ext, wordCount, libReady };
})();
