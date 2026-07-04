/* Sentinel DD — export engine (Phase 15)
 * PDF (jsPDF), Word (HTML .doc), Excel (SheetJS), PowerPoint (PptxGenJS).
 * Reports preserve findings, tables, risk register, citations, and appendices. */
(function () {
  const DD = (window.DD = window.DD || {});

  function allFindings(project) {
    const rows = [];
    Object.entries(project.findings || {}).forEach(([bucket, list]) =>
      list.forEach((f) => rows.push({ bucket, ...f })));
    return rows;
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  // ---------------- PDF ----------------
  function exportPdf(project) {
    if (!window.jspdf?.jsPDF) throw new Error("jsPDF not loaded");
    const doc = new window.jspdf.jsPDF({ unit: "pt", format: "a4" });
    const margin = 48;
    const width = doc.internal.pageSize.getWidth() - margin * 2;
    let y = margin;
    const line = (text, size = 11, bold = false, gap = 6) => {
      doc.setFont("helvetica", bold ? "bold" : "normal");
      doc.setFontSize(size);
      const wrapped = doc.splitTextToSize(text, width);
      wrapped.forEach((w) => {
        if (y > doc.internal.pageSize.getHeight() - margin) { doc.addPage(); y = margin; }
        doc.text(w, margin, y); y += size + gap;
      });
    };
    line(`${project.name} — Due Diligence Report`, 20, true, 10);
    line(`${project.industry} • ${project.type || project.workflow || ""} • Generated ${new Date().toLocaleString()}`, 10, false, 14);

    const rec = project.recommendation;
    line("Recommendation", 15, true, 8);
    line(rec ? `${rec.decision} (${rec.confidence}% confidence). ${rec.rationale || ""}` : "Not yet generated.", 11, false, 12);

    line("Findings", 15, true, 8);
    allFindings(project).forEach((f) => {
      line(`• [${f.bucket} / ${f.severity} / ${f.confidence}%] ${f.title}`, 11, true, 4);
      line(`${f.summary} (${f.evidenceCount || 0} evidence items, status: ${f.status})`, 10, false, 8);
    });

    line("Risk Register", 15, true, 8);
    (project.riskRegister?.risks || []).forEach((r) => line(`• [${r.severity}] ${r.title} — ${r.mitigation || ""}`, 10, false, 6));

    line("Evidence Appendix", 15, true, 8);
    (project.evidence || []).slice(0, 60).forEach((e) => {
      line(`• ${e.fact}`, 10, true, 3);
      line(`Source: ${e.docName}${e.page ? `, p.${e.page}` : ""} (${e.location}) — ${e.confidence}% — "${(e.excerpt || "").slice(0, 160)}"`, 9, false, 7);
    });
    download(doc.output("blob"), `${slug(project.name)}-diligence.pdf`);
  }

  // ---------------- Word (HTML .doc) ----------------
  function exportWord(project) {
    const esc = DD.util.escapeHtml;
    const findingsHtml = allFindings(project).map((f) =>
      `<tr><td>${esc(f.bucket)}</td><td>${esc(f.title)}</td><td>${esc(f.severity)}</td><td>${f.confidence}%</td><td>${esc(f.status)}</td></tr>`).join("");
    const risksHtml = (project.riskRegister?.risks || []).map((r) =>
      `<tr><td>${esc(r.severity)}</td><td>${esc(r.title)}</td><td>${esc(r.category)}</td><td>${esc(r.likelihood)}</td><td>${r.confidence}%</td></tr>`).join("");
    const evHtml = (project.evidence || []).slice(0, 80).map((e) =>
      `<tr><td>${esc(e.fact)}</td><td>${esc(e.docName)}${e.page ? `, p.${e.page}` : ""}</td><td>${e.confidence}%</td><td>${esc((e.excerpt || "").slice(0, 200))}</td></tr>`).join("");
    const rec = project.recommendation;
    const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="utf-8"><title>${esc(project.name)}</title>
      <style>body{font-family:Calibri,Arial,sans-serif;} table{border-collapse:collapse;width:100%;margin:8px 0;} td,th{border:1px solid #999;padding:6px;font-size:11pt;text-align:left;} h1{font-size:20pt;} h2{font-size:14pt;border-bottom:2px solid #333;}</style></head><body>
      <h1>${esc(project.name)} — Investment Committee Memorandum</h1>
      <p>${esc(project.industry)} • ${esc(project.type || project.workflow || "")} • ${new Date().toLocaleDateString()}</p>
      <h2>Recommendation</h2><p>${rec ? `<strong>${esc(rec.decision)}</strong> (${rec.confidence}% confidence). ${esc(rec.rationale || "")}` : "Not generated."}</p>
      <h2>Memo</h2>${project.memoHtml || "<p>No memo drafted.</p>"}
      <h2>Findings</h2><table><tr><th>Workstream</th><th>Finding</th><th>Severity</th><th>Confidence</th><th>Status</th></tr>${findingsHtml}</table>
      <h2>Risk Register</h2><table><tr><th>Severity</th><th>Risk</th><th>Category</th><th>Likelihood</th><th>Confidence</th></tr>${risksHtml}</table>
      <h2>Evidence Appendix</h2><table><tr><th>Fact</th><th>Source</th><th>Confidence</th><th>Excerpt</th></tr>${evHtml}</table>
      </body></html>`;
    download(new Blob([html], { type: "application/msword" }), `${slug(project.name)}-memo.doc`);
  }

  // ---------------- Excel ----------------
  function exportExcel(project) {
    if (!window.XLSX) throw new Error("SheetJS not loaded");
    const wb = window.XLSX.utils.book_new();
    const findings = allFindings(project).map((f) => ({
      Workstream: f.bucket, Finding: f.title, Summary: f.summary,
      Severity: f.severity, Confidence: f.confidence, Evidence: f.evidenceCount || 0, Status: f.status
    }));
    window.XLSX.utils.book_append_sheet(wb, window.XLSX.utils.json_to_sheet(findings.length ? findings : [{ Note: "No findings" }]), "Findings");

    const risks = (project.riskRegister?.risks || []).map((r) => ({
      Severity: r.severity, Risk: r.title, Category: r.category, Likelihood: r.likelihood, Confidence: r.confidence, Mitigation: r.mitigation
    }));
    window.XLSX.utils.book_append_sheet(wb, window.XLSX.utils.json_to_sheet(risks.length ? risks : [{ Note: "No risks" }]), "Risk Register");

    const evidence = (project.evidence || []).map((e) => ({
      Fact: e.fact, Document: e.docName, Page: e.page, Location: e.location, Confidence: e.confidence, Agent: e.agent, Excerpt: e.excerpt
    }));
    window.XLSX.utils.book_append_sheet(wb, window.XLSX.utils.json_to_sheet(evidence.length ? evidence : [{ Note: "No evidence" }]), "Evidence");

    const metrics = (project.financial?.metrics || []).map((m) => ({ Metric: m.label, Value: m.value, Basis: m.hint }));
    if (metrics.length) window.XLSX.utils.book_append_sheet(wb, window.XLSX.utils.json_to_sheet(metrics), "Financials");

    window.XLSX.writeFile(wb, `${slug(project.name)}-diligence.xlsx`);
  }

  // ---------------- PowerPoint ----------------
  function exportPptx(project) {
    if (!window.PptxGenJS) throw new Error("PptxGenJS not loaded");
    const pptx = new window.PptxGenJS();
    const rec = project.recommendation;

    let slide = pptx.addSlide();
    slide.addText(`${project.name}`, { x: 0.5, y: 1.6, w: 9, fontSize: 34, bold: true });
    slide.addText(`Due Diligence Summary • ${project.industry}`, { x: 0.5, y: 2.5, w: 9, fontSize: 18, color: "666666" });

    slide = pptx.addSlide();
    slide.addText("Recommendation", { x: 0.5, y: 0.4, fontSize: 24, bold: true });
    slide.addText(rec ? `${rec.decision} — ${rec.confidence}% confidence\n\n${rec.rationale || ""}` : "Not generated.", { x: 0.5, y: 1.4, w: 9, h: 4, fontSize: 16 });

    slide = pptx.addSlide();
    slide.addText("Key Findings", { x: 0.5, y: 0.4, fontSize: 24, bold: true });
    const rows = [[{ text: "Workstream", options: { bold: true } }, { text: "Finding", options: { bold: true } }, { text: "Severity", options: { bold: true } }, { text: "Conf.", options: { bold: true } }]];
    allFindings(project).slice(0, 12).forEach((f) => rows.push([f.bucket, f.title, f.severity, `${f.confidence}%`]));
    slide.addTable(rows, { x: 0.4, y: 1.2, w: 9.2, fontSize: 11, border: { pt: 0.5, color: "CCCCCC" } });

    slide = pptx.addSlide();
    slide.addText("Risk Register", { x: 0.5, y: 0.4, fontSize: 24, bold: true });
    const rrows = [[{ text: "Severity", options: { bold: true } }, { text: "Risk", options: { bold: true } }, { text: "Likelihood", options: { bold: true } }]];
    (project.riskRegister?.risks || []).slice(0, 12).forEach((r) => rrows.push([r.severity, r.title, r.likelihood]));
    slide.addTable(rrows.length > 1 ? rrows : [["—", "No risks generated", "—"]], { x: 0.4, y: 1.2, w: 9.2, fontSize: 11, border: { pt: 0.5, color: "CCCCCC" } });

    pptx.writeFile({ fileName: `${slug(project.name)}-diligence.pptx` });
  }

  function slug(name) {
    return String(name || "report").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }

  DD.exporter = { exportPdf, exportWord, exportExcel, exportPptx, download };
})();
