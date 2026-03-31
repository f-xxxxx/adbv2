(function () {
  const root = (window.ADBModules = window.ADBModules || {});

  function buildTimelineControlsHtml(triggerText, escapeHtml) {
    const safeTrigger = escapeHtml(String(triggerText || "-"));
    return `
        <div class="timeline-controls">
          <button id="timeline-play-btn" onclick="toggleTimelinePlayback()">播放回放</button>
          <label>速度
            <select id="timeline-speed-select">
              <option value="1">1x</option>
              <option value="2">2x</option>
              <option value="4" selected>4x</option>
              <option value="8">8x</option>
            </select>
          </label>
          <span style="font-size:12px;color:#9eb0cb">触发来源: ${safeTrigger}</span>
        </div>
      `;
  }

  function buildTimelineItemHtml(item, index, opts) {
    const escapeHtml = opts.escapeHtml;
    const formatEpochTime = opts.formatEpochTime;
    const statusText = opts.statusText;
    const widthPct = opts.widthPct;

    const nodeId = String(item.node_id || "-");
    const classType = String(item.class_type || "-");
    const itemStatus = String(item.status || "ok");
    const duration = Number(item.duration_ms || 0);
    const errorText = String(item.error || "").trim();
    const statusCls = itemStatus === "error" ? "error" : "";
    const rangeText = `${formatEpochTime(Number(item.start_ts || 0))} -> ${formatEpochTime(
      Number(item.end_ts || 0)
    )}`;
    const errorHtml = errorText ? `<div class="timeline-error">${escapeHtml(errorText)}</div>` : "";

    return `
          <div class="timeline-item ${statusCls}" data-index="${index}">
            <div class="timeline-item-head">
              <span class="timeline-title">节点 ${escapeHtml(nodeId)} · ${escapeHtml(classType)}</span>
              <span class="timeline-status ${statusCls}">${statusText(itemStatus)}</span>
            </div>
            <div class="timeline-metrics">
              <span>耗时: ${duration.toFixed(1)} ms</span>
              <span>时间: ${escapeHtml(rangeText)}</span>
            </div>
            <div class="timeline-bar-wrap"><div class="timeline-bar" style="width:${widthPct(
              duration
            ).toFixed(2)}%"></div></div>
            ${errorHtml}
          </div>
        `;
  }

  function buildReportSummaryCard(title, value, status) {
    const cls = status ? `report-card ${status}` : "report-card";
    return `<div class="${cls}"><div class="k">${title}</div><div class="v">${value}</div></div>`;
  }

  root.reportView = {
    buildTimelineControlsHtml,
    buildTimelineItemHtml,
    buildReportSummaryCard,
  };
})();

