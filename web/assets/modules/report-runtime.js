(function () {
  const root = (window.ADBModules = window.ADBModules || {});

  function stopPlayback(state) {
    if (!state) return;
    if (state.timelinePlayTimer) {
      clearTimeout(state.timelinePlayTimer);
      state.timelinePlayTimer = null;
    }
    const body = document.getElementById("timeline-body");
    if (body) {
      for (const el of body.querySelectorAll(".timeline-item.active")) {
        el.classList.remove("active");
      }
    }
    const btn = document.getElementById("timeline-play-btn");
    if (btn) btn.textContent = "播放回放";
  }

  function highlightItem(state, index) {
    const body = document.getElementById("timeline-body");
    if (!body) return;
    const rows = body.querySelectorAll(".timeline-item");
    rows.forEach((el) => el.classList.remove("active"));
    const target = body.querySelector(`.timeline-item[data-index="${index}"]`);
    if (!target) return;
    target.classList.add("active");
    target.scrollIntoView({ behavior: "smooth", block: "nearest" });
    if (state) state.timelinePlayIndex = index;
  }

  function playSequence(state, speed) {
    stopPlayback(state);
    if (!state || !Array.isArray(state.timelineItems) || !state.timelineItems.length) return;
    const safeSpeed = Math.max(0.2, Number(speed) || 1);
    const btn = document.getElementById("timeline-play-btn");
    if (btn) btn.textContent = "停止回放";
    const firstStart = Number(state.timelineItems[0].start_ts || 0);
    let idx = 0;

    const step = () => {
      if (!state || idx >= state.timelineItems.length) {
        stopPlayback(state);
        return;
      }
      highlightItem(state, idx);
      const curr = state.timelineItems[idx];
      const next = state.timelineItems[idx + 1];
      if (!next) {
        state.timelinePlayTimer = setTimeout(() => stopPlayback(state), 600);
        return;
      }
      const currStart = Number(curr.start_ts || firstStart);
      const nextStart = Number(next.start_ts || currStart);
      const deltaMs = Math.max(120, (nextStart - currStart) * 1000 / safeSpeed);
      idx += 1;
      state.timelinePlayTimer = setTimeout(step, deltaMs);
    };
    step();
  }

  function togglePlayback(state, speed) {
    if (!state) return;
    if (state.timelinePlayTimer) {
      stopPlayback(state);
      return;
    }
    playSequence(state, speed);
  }

  function buildTimelineRenderPayload(timeline, sourceText, opts) {
    const formatEpochTime = opts.formatEpochTime;
    const escapeHtml = opts.escapeHtml;
    const reportView = opts.reportView || {};
    const reportReplay = opts.reportReplay || {};
    const data = timeline && typeof timeline === "object" ? timeline : {};
    const runId = String(data.run_id || "");
    const status = String(data.status || "");
    const nodes = Array.isArray(data.nodes) ? data.nodes.slice() : [];
    if (!nodes.length) {
      return {
        runId,
        nodes,
        metaText: `${sourceText}：无节点数据`,
        html: '<div class="preview-empty">当前执行未记录节点级事件。</div>',
      };
    }
    const elapsedMs = Math.max(
      1,
      Number(data.elapsed_sec || 0) * 1000,
      Math.max(...nodes.map((x) => Number(x.duration_ms || 0)))
    );
    const startedAtText = formatEpochTime(Number(data.started_at || 0)) || "-";
    const triggerText = String(data.trigger || "-");
    const metaText = `${sourceText}：${status || "-"} | run_id=${runId || "-"} | 开始 ${startedAtText} | 节点 ${nodes.length}`;

    const controlsHtml = reportView.buildTimelineControlsHtml
      ? reportView.buildTimelineControlsHtml(triggerText, escapeHtml)
      : "";
    const listHtml = nodes.map((item, index) => {
      if (reportView.buildTimelineItemHtml) {
        return reportView.buildTimelineItemHtml(item, index, {
          escapeHtml,
          formatEpochTime,
          statusText: (s) => (reportReplay.timelineItemStatusText
            ? reportReplay.timelineItemStatusText(s)
            : (s === "error" ? "失败" : "成功")),
          widthPct: (duration) => (reportReplay.timelineBarWidth
            ? reportReplay.timelineBarWidth(duration, elapsedMs)
            : Math.max(1, Math.min(100, (duration / elapsedMs) * 100))),
        });
      }
      return "";
    }).join("");
    return {
      runId,
      nodes,
      metaText,
      html: `${controlsHtml}<div class="timeline-list">${listHtml}</div>`,
    };
  }

  function buildReportRenderPayload(payload, reportPath, sourceText, opts) {
    const escapeHtml = opts.escapeHtml;
    const reportView = opts.reportView || {};
    const report = payload && typeof payload === "object" ? payload : {};
    const ok = !!report.ok;
    const statusText = ok ? "成功" : "失败";
    const startedAt = String(report.started_at || "-");
    const endedAt = String(report.ended_at || "-");
    const elapsed = Number(report.elapsed_sec || 0).toFixed(3) + "s";
    const nodeCount = Number(report.workflow_node_count || 0);
    const outputCount = Number(report.output_node_count || 0);
    const logCount = Number(report.log_count || 0);
    const errorText = String(report.error || "").trim();
    const metaText = `${sourceText}：${statusText} | 开始 ${startedAt} | 结束 ${endedAt}`;
    const card = reportView.buildReportSummaryCard
      ? reportView.buildReportSummaryCard
      : (title, value, status) => `<div class="${status ? `report-card ${status}` : "report-card"}"><div class="k">${title}</div><div class="v">${value}</div></div>`;
    const cardsHtml = [
      card("状态", statusText, ok ? "ok" : "error"),
      card("耗时", elapsed),
      card("工作流节点", String(nodeCount)),
      card("输出节点", String(outputCount)),
      card("日志条数", String(logCount)),
    ].join("");
    const errorHtml = errorText
      ? `<div class="report-error-box"><strong>错误信息：</strong><br />${escapeHtml(errorText)}</div>`
      : "";
    const jsonText = JSON.stringify(report, null, 2);
    const html = `
        <div class="report-summary-grid">${cardsHtml}</div>
        ${errorHtml}
        <div class="report-json-title">报告路径：${reportPath ? escapeHtml(reportPath) : "-"}</div>
        <pre class="report-json">${escapeHtml(jsonText)}</pre>
      `;
    return { metaText, html };
  }

  root.reportRuntime = {
    stopPlayback,
    highlightItem,
    playSequence,
    togglePlayback,
    buildTimelineRenderPayload,
    buildReportRenderPayload,
  };
})();
