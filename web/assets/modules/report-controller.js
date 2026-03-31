(function () {
  const root = (window.ADBModules = window.ADBModules || {});

  function escapeHtml(text) {
    const raw = String(text == null ? "" : text);
    return raw
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  async function readReport(path) {
    const res = await fetch(`/api/report/read?path=${encodeURIComponent(path)}`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "读取报告失败");
    return data;
  }

  async function readTimeline(path, runId) {
    const rid = String(runId || "").trim();
    const query = rid
      ? `run_id=${encodeURIComponent(rid)}`
      : `report_path=${encodeURIComponent(path)}`;
    const res = await fetch(`/api/run/timeline?${query}`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "读取运行回放失败");
    return data;
  }

  root.reportController = {
    escapeHtml,
    readReport,
    readTimeline,
  };
})();
