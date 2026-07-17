/* Sentinel DD — Human Review Layer (Phase 14)
 * Approve / reject / edit / comment on any AI finding, with full version history
 * and a reviewer action log. */
(function () {
  const DD = (window.DD = window.DD || {});

  const STATUS_BY_ACTION = {
    Approved: "Approved", Rejected: "Rejected", Edited: "Edited", Commented: "Commented", Reopened: "Needs Review"
  };

  function findFinding(project, findingId) {
    for (const [bucket, list] of Object.entries(project.findings || {})) {
      const found = list.find((f) => f.id === findingId);
      if (found) return { finding: found, bucket };
    }
    return { finding: null, bucket: null };
  }

  function snapshot(finding) {
    return { title: finding.title, summary: finding.summary, severity: finding.severity, confidence: finding.confidence, status: finding.status };
  }

  /* Record a reviewer action. `edits` optionally patches title/summary/severity. */
  function act(project, findingId, action, { user = "Reviewer", note = "", edits = null } = {}) {
    const { finding, bucket } = findFinding(project, findingId);
    if (!finding) return null;
    finding.versions = finding.versions || [];
    finding.reviews = finding.reviews || [];
    project.reviewLog = project.reviewLog || [];

    // version snapshot BEFORE mutation
    finding.versions.unshift({ at: new Date().toISOString(), by: user, action, before: snapshot(finding) });
    finding.versions = finding.versions.slice(0, 25);

    if (action === "Edited" && edits) {
      if (edits.title != null) finding.title = edits.title;
      if (edits.summary != null) finding.summary = edits.summary;
      if (edits.severity != null) finding.severity = edits.severity;
      if (edits.confidence != null) finding.confidence = Math.max(1, Math.min(99, Number(edits.confidence)));
    }
    finding.status = STATUS_BY_ACTION[action] || finding.status;
    finding.updatedAt = new Date().toISOString();

    const review = { at: finding.updatedAt, by: user, action, note: note || null };
    finding.reviews.unshift(review);
    project.reviewLog.unshift({ ...review, findingId, bucket, title: finding.title });
    project.reviewLog = project.reviewLog.slice(0, 200);
    return { finding, bucket, review };
  }

  function history(project, findingId) {
    const { finding } = findFinding(project, findingId);
    return finding ? { reviews: finding.reviews || [], versions: finding.versions || [] } : { reviews: [], versions: [] };
  }

  DD.review = { act, findFinding, history, STATUS_BY_ACTION };
})();
