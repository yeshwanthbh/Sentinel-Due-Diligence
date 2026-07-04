/* Sentinel DD — Data Room ingestion (Phase 2 upload/storage + Phase 3 processing)
 * Upload -> extract text (OCR fallback) -> classify -> hash/dedup -> metadata -> inventory. */
(function () {
  const DD = (window.DD = window.DD || {});
  const { cryptoId } = DD.util;

  const ACCEPTED = ["pdf", "docx", "xlsx", "xls", "pptx", "csv", "tsv", "txt", "zip"];

  function accepted(name) {
    return ACCEPTED.includes(DD.extract.ext(name));
  }

  function trimPages(pages) {
    return (pages || []).slice(0, 80).map((p) => ({
      page: p.page, unit: p.unit || "page", text: (p.text || "").slice(0, 1500)
    }));
  }

  async function processOne(project, file, { onProgress } = {}) {
    const id = cryptoId();
    if (onProgress) onProgress({ id, name: file.name, stage: "reading", pct: 5 });
    const buffer = await file.arrayBuffer();
    const hash = await DD.db.sha256Hex(buffer);

    if (onProgress) onProgress({ id, name: file.name, stage: "extracting", pct: 30 });
    const extracted = await DD.extract.extract(file, {
      onProgress: (pct) => onProgress && onProgress({ id, name: file.name, stage: "extracting", pct: 30 + Math.round(pct * 0.4) })
    });

    if (onProgress) onProgress({ id, name: file.name, stage: "classifying", pct: 78 });
    const { category, docType, confidence } = DD.classify.classify(file.name, extracted);

    const duplicate = (project.documents || []).find((d) => d.hash === hash);
    const record = {
      id, name: file.name, ext: extracted.ext, size: file.size,
      category, docType, confidence: `${confidence}%`, classificationConfidence: confidence,
      status: duplicate ? "Duplicate" : (extracted.error ? "Error" : "Processed"),
      hash, duplicateOf: duplicate ? duplicate.id : null,
      duplicate: duplicate ? `Duplicate of ${duplicate.name}` : "No duplicate",
      pageCount: extracted.pageCount || 0, tableCount: extracted.tableCount || 0,
      wordCount: extracted.wordCount || 0, ocrUsed: Boolean(extracted.ocrUsed),
      uploadedAt: new Date().toISOString(),
      textPreview: (extracted.fullText || "").slice(0, 2600),
      pages: trimPages(extracted.pages),
      metadata: {
        sheets: extracted.sheetNames || null,
        paragraphs: extracted.paragraphCount || null,
        pdfMeta: extracted.meta?.info || null,
        error: extracted.error || null
      }
    };

    // persist the raw blob + full text separately (keeps the project record small)
    await DD.store.put("docblobs", { id, blob: file, fullText: extracted.fullText || "", uploadedAt: record.uploadedAt });
    if (onProgress) onProgress({ id, name: file.name, stage: "done", pct: 100, record });
    return record;
  }

  /* Ingest a FileList/array. ZIPs are expanded into their child documents. */
  async function ingest(project, files, { onProgress } = {}) {
    project.documents = project.documents || [];
    const list = [...files];
    const added = [];
    const skipped = [];
    for (const file of list) {
      if (!accepted(file.name)) { skipped.push(file.name); continue; }
      if (DD.extract.ext(file.name) === "zip") {
        let children = [];
        try { children = await DD.extract.expandZip(await file.arrayBuffer()); } // eslint-disable-line no-await-in-loop
        catch (error) { skipped.push(`${file.name} (${error.message})`); continue; }
        for (const child of children) {
          const record = await processOne(project, child, { onProgress }); // eslint-disable-line no-await-in-loop
          project.documents.unshift(record); added.push(record);
        }
      } else {
        const record = await processOne(project, file, { onProgress }); // eslint-disable-line no-await-in-loop
        project.documents.unshift(record); added.push(record);
      }
    }
    // refresh coverage snapshot for the Data Room panel
    project.coverage = DD.classify.coverage(project.documents, project.type || project.workflow)
      .map((c) => [`${c.category}`, c.pct, c.state]);
    return { added, skipped, missing: DD.classify.missingCategories(project.documents, project.type || project.workflow) };
  }

  function inventory(project, { search = "", category = "all" } = {}) {
    const q = search.trim().toLowerCase();
    return (project.documents || []).filter((doc) => {
      if (category !== "all" && doc.category !== category) return false;
      if (!q) return true;
      return [doc.name, doc.category, doc.docType, doc.status, doc.duplicate].join(" ").toLowerCase().includes(q);
    });
  }

  DD.dataroom = { ingest, inventory, accepted, ACCEPTED };
})();
