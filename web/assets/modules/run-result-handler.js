(function () {
  const root = (window.ADBModules = window.ADBModules || {});

  function createRunResultHandler(deps) {
    const {
      log,
      setStatus,
      clearPreviewTable,
      clearReportPanel,
      clearTimelinePanel,
      applyOutputsToWorkspace,
      setRunInfo,
      getRunInfo,
      switchBottomTab,
      reportController,
      reportRuntime,
      reportView,
      reportReplay,
      renderReportSummaryCard,
      renderRunTimeline,
      setCurrentReportPath,
      getCurrentReportPath,
      formatEpochTime,
      escapeHtml,
    } = deps || {};

    function _escapeHtml(text) {
      if (typeof escapeHtml === "function") return escapeHtml(text);
      const raw = String(text == null ? "" : text);
      return raw
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
    }

    function handleManualRunStart(workflow) {
      if (typeof clearPreviewTable === "function") clearPreviewTable("结果预览：执行中...");
      if (typeof clearTimelinePanel === "function") clearTimelinePanel("执行回放：执行中...");
      if (typeof deps.clearPreviewImagesOnNodes === "function") deps.clearPreviewImagesOnNodes();
      if (typeof deps.resetNodeProgressHighlight === "function") deps.resetNodeProgressHighlight();
      if (typeof deps.startExecutionProgress === "function") deps.startExecutionProgress(workflow || {});
      if (typeof deps.updateRunButtonState === "function") deps.updateRunButtonState();
    }

    function handleScheduleRunStart(scheduleId, scheduleWorkflow) {
      if (typeof switchBottomTab === "function") switchBottomTab("report");
      if (typeof clearReportPanel === "function") clearReportPanel("执行报告：调度正在执行...");
      if (typeof clearTimelinePanel === "function") clearTimelinePanel("运行回放：调度正在执行...");
      if (typeof clearPreviewTable === "function") clearPreviewTable("结果预览：调度执行中...");
      if (typeof log === "function") log(`开始执行调度任务: ${String(scheduleId || "")}`);
      if (typeof deps.clearPreviewImagesOnNodes === "function") deps.clearPreviewImagesOnNodes();
      if (typeof deps.resetNodeProgressHighlight === "function") deps.resetNodeProgressHighlight();
      if (typeof deps.startExecutionProgress === "function") deps.startExecutionProgress(scheduleWorkflow || {});
      if (typeof deps.updateRunButtonState === "function") deps.updateRunButtonState();
    }

    async function handleManualRunSuccess(data, elapsedSecText) {
      const outputs = data && data.outputs ? data.outputs : {};
      if (typeof log === "function") {
        log("执行完成。输出节点: " + Object.keys(outputs || {}).join(", "));
        if (elapsedSecText) log(`执行耗时: ${elapsedSecText} 秒`);
      }

      if (data && data.report_path) {
        if (typeof log === "function") log(`执行报告: ${data.report_path}`);
        if (typeof setRunInfo === "function") {
          setRunInfo(String(data.run_id || ""), String(data.report_path || ""));
        }
        await openReportInBottomTab(String(data.report_path || ""), "手动执行报告", String(data.run_id || ""));
      }
      if (typeof applyOutputsToWorkspace === "function") {
        await applyOutputsToWorkspace(outputs || {});
      }
      if (typeof setStatus === "function") setStatus("执行完成");
    }

    function handleManualRunFailure(err, cancelRequestedByUser) {
      const msg = err && err.message ? String(err.message) : String(err || "");
      if (msg.includes("执行已取消")) {
        if (cancelRequestedByUser) {
          if (typeof log === "function") log("执行已停止：用户手动停止");
          if (typeof clearPreviewTable === "function") clearPreviewTable("结果预览：用户手动停止");
          if (typeof setStatus === "function") setStatus("已手动停止");
        } else {
          if (typeof log === "function") log("执行已取消");
          if (typeof clearPreviewTable === "function") clearPreviewTable("结果预览：执行已取消");
          if (typeof setStatus === "function") setStatus("执行已取消");
        }
      } else {
        if (typeof log === "function") log("执行失败: " + msg);
        if (typeof clearPreviewTable === "function") clearPreviewTable("结果预览：执行失败");
        if (typeof setStatus === "function") setStatus("执行失败");
      }
      if (typeof setRunInfo === "function") setRunInfo("", "");
      if (typeof clearReportPanel === "function") clearReportPanel("执行报告：执行失败（未加载历史报告）");
      if (typeof clearTimelinePanel === "function") clearTimelinePanel("运行回放：执行失败（未加载历史回放）");
    }

    async function handleScheduleRunSuccess(data) {
      const outputs = data && data.outputs ? data.outputs : {};
      if (typeof log === "function") {
        log("调度执行完成。输出节点: " + Object.keys(outputs || {}).join(", "));
      }
      if (data && data.report_path) {
        if (typeof log === "function") log(`调度执行报告: ${data.report_path}`);
        if (typeof setRunInfo === "function") {
          setRunInfo(String(data.run_id || ""), String(data.report_path || ""));
        }
        await openReportInBottomTab(String(data.report_path || ""), "调度执行报告", String(data.run_id || ""));
      }
      if (typeof applyOutputsToWorkspace === "function") {
        await applyOutputsToWorkspace(outputs || {});
      }
      if (typeof setStatus === "function") setStatus("调度执行完成");
    }

    function handleScheduleRunFailure(err, cancelRequestedByUser) {
      const msg = err && err.message ? String(err.message) : String(err || "");
      if (msg.includes("已取消") || cancelRequestedByUser) {
        if (typeof log === "function") log("调度任务已停止");
        if (typeof clearPreviewTable === "function") clearPreviewTable("结果预览：调度已停止");
        if (typeof setStatus === "function") setStatus("调度已停止");
      } else {
        if (typeof log === "function") log("调度执行失败: " + msg);
        if (typeof clearPreviewTable === "function") clearPreviewTable("结果预览：调度执行失败");
        if (typeof setStatus === "function") setStatus("调度执行失败");
      }
    }

    function renderExecutionReport(payload, reportPath = "", sourceText = "执行报告") {
      const meta = document.getElementById("report-meta-text");
      const body = document.getElementById("report-body");
      if (!meta || !body) return;

      if (reportRuntime && typeof reportRuntime.buildReportRenderPayload === "function") {
        const rendered = reportRuntime.buildReportRenderPayload(payload, reportPath, sourceText, {
          escapeHtml: _escapeHtml,
          reportView,
        });
        meta.textContent = String(rendered.metaText || `${sourceText}：-`);
        body.innerHTML = String(rendered.html || "");
        if (typeof setCurrentReportPath === "function") setCurrentReportPath(reportPath || "");
        return;
      }

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

      meta.textContent = `${sourceText}：${statusText} | 开始 ${startedAt} | 结束 ${endedAt}`;
      const card = typeof renderReportSummaryCard === "function"
        ? renderReportSummaryCard
        : (title, value, status = "") => {
            const cls = status ? `report-card ${status}` : "report-card";
            return `<div class="${cls}"><div class="k">${title}</div><div class="v">${value}</div></div>`;
          };
      const cardsHtml = [
        card("状态", statusText, ok ? "ok" : "error"),
        card("耗时", elapsed),
        card("工作流节点", String(nodeCount)),
        card("输出节点", String(outputCount)),
        card("日志条数", String(logCount)),
      ].join("");
      const errorHtml = errorText
        ? `<div class="report-error-box"><strong>错误信息：</strong><br />${_escapeHtml(errorText)}</div>`
        : "";
      const jsonText = JSON.stringify(report, null, 2);
      body.innerHTML = `
        <div class="report-summary-grid">${cardsHtml}</div>
        ${errorHtml}
        <div class="report-json-title">报告路径：${reportPath ? _escapeHtml(reportPath) : "-"}</div>
        <pre class="report-json">${_escapeHtml(jsonText)}</pre>
      `;
      if (typeof setCurrentReportPath === "function") setCurrentReportPath(reportPath || "");
    }

    async function openTimelineByReportPath(path, sourceText = "执行回放", runId = "") {
      if (!path) {
        if (typeof clearTimelinePanel === "function") clearTimelinePanel("执行回放：暂无");
        return;
      }
      try {
        let data;
        if (reportController && typeof reportController.readTimeline === "function") {
          data = await reportController.readTimeline(path, runId);
        } else {
          const rid = String(runId || "").trim();
          const query = rid
            ? `run_id=${encodeURIComponent(rid)}`
            : `report_path=${encodeURIComponent(path)}`;
          const res = await fetch(`/api/run/timeline?${query}`);
          data = await res.json();
          if (!data.ok) throw new Error(data.error || "读取运行回放失败");
        }
        if (typeof renderRunTimeline === "function") {
          renderRunTimeline(data.timeline || {}, sourceText);
        }
      } catch (err) {
        if (typeof clearTimelinePanel === "function") {
          clearTimelinePanel(`运行回放：${sourceText}读取失败`);
        }
        if (typeof log === "function") {
          log("读取运行回放失败: " + (err && err.message ? err.message : String(err)));
        }
      }
    }

    async function handleReportReadSuccess(data, sourceText, expectedRunId) {
      const payload = data && typeof data === "object" ? data : {};
      const report = payload.report || {};
      const reportRunId = String(report.run_id || "");
      const expect = String(expectedRunId || "").trim();
      if (expect && reportRunId && expect !== reportRunId) {
        throw new Error(`报告 run_id 不匹配（期望 ${expect}，实际 ${reportRunId}）`);
      }
      const finalRunId = reportRunId || expect;
      if (typeof setRunInfo === "function") {
        setRunInfo(finalRunId, String(payload.path || ""));
      }
      renderExecutionReport(report, String(payload.path || ""), sourceText);
      await openTimelineByReportPath(String(payload.path || ""), sourceText, finalRunId);
      if (report && typeof report === "object" && report.outputs && typeof report.outputs === "object") {
        if (typeof applyOutputsToWorkspace === "function") {
          await applyOutputsToWorkspace(report.outputs);
        }
      }
      if (typeof switchBottomTab === "function") switchBottomTab("report");
      return finalRunId;
    }

    async function openReportInBottomTab(path, sourceText = "执行报告", expectedRunId = "") {
      if (!path) {
        if (typeof clearReportPanel === "function") clearReportPanel("执行报告：暂无");
        if (typeof clearTimelinePanel === "function") clearTimelinePanel("运行回放：暂无");
        if (typeof switchBottomTab === "function") switchBottomTab("report");
        return;
      }
      try {
        let data;
        if (reportController && typeof reportController.readReport === "function") {
          data = await reportController.readReport(path);
        } else {
          const res = await fetch(`/api/report/read?path=${encodeURIComponent(path)}`);
          data = await res.json();
          if (!data.ok) throw new Error(data.error || "读取报告失败");
        }
        await handleReportReadSuccess(
          { ...data, path: String((data && data.path) || path) },
          sourceText,
          expectedRunId
        );
      } catch (err) {
        handleReportReadFailure(err);
      }
    }

    function handleReportReadFailure(err) {
      if (typeof log === "function") log("读取执行报告失败: " + (err && err.message ? err.message : String(err || "")));
      if (typeof clearReportPanel === "function") clearReportPanel("执行报告：读取失败");
      if (typeof clearTimelinePanel === "function") clearTimelinePanel("运行回放：读取失败");
      if (typeof switchBottomTab === "function") switchBottomTab("report");
    }

    return {
      handleManualRunStart,
      handleManualRunSuccess,
      handleManualRunFailure,
      handleScheduleRunStart,
      handleScheduleRunSuccess,
      handleScheduleRunFailure,
      renderExecutionReport,
      openTimelineByReportPath,
      openReportInBottomTab,
      handleReportReadSuccess,
      handleReportReadFailure,
    };
  }

  root.runResultHandler = {
    createRunResultHandler,
  };
})();
