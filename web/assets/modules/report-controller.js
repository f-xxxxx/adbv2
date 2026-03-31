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

  const _thumbCache = new Map();
  async function readImageThumb(path, maxSide = 360) {
    const key = `${String(path || "").trim()}|${Number(maxSide)}`;
    if (_thumbCache.has(key)) return _thumbCache.get(key);
    const query = `path=${encodeURIComponent(String(path || ""))}&max_side=${encodeURIComponent(String(maxSide))}`;
    const res = await fetch(`/api/image/thumb?${query}`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "读取缩略图失败");
    const value = String(data.data_url || "");
    _thumbCache.set(key, value);
    return value;
  }

  root.reportController = {
    escapeHtml,
    readReport,
    readTimeline,
    readImageThumb,
  };
})();
