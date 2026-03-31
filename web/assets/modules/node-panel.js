(function () {
  const root = (window.ADBModules = window.ADBModules || {});

  function updateTopbarActionsState(workflowRunning, schedulerRunning) {
    const bar = document.querySelector(".bar-actions");
    if (!bar) return;
    const locked = workflowRunning || schedulerRunning;
    const buttons = bar.querySelectorAll("button");
    buttons.forEach((btn) => {
      if (btn.id === "run-workflow-btn") btn.disabled = false;
      else btn.disabled = locked;
    });
  }

  function updateRunButtonState(opts) {
    const {
      workflowRunning,
      schedulerRunning,
      executionProgress,
      updateTopbarActions,
    } = opts || {};
    const btn = document.getElementById("run-workflow-btn");
    if (!btn) return;
    const hasProgress = executionProgress && executionProgress.active && executionProgress.total > 0;
    const doneCount = hasProgress ? executionProgress.doneSet.size : 0;
    const progressText = hasProgress
      ? `执行中 ${Math.min(doneCount, executionProgress.total)}/${executionProgress.total}`
      : "执行中...";
    if (workflowRunning || schedulerRunning) {
      btn.classList.remove("primary");
      btn.classList.add("warn");
      btn.innerHTML = `<span class="btn-icon">&#9209;</span>停止`;
      btn.title = progressText;
    } else {
      btn.classList.remove("warn");
      btn.classList.add("primary");
      btn.innerHTML = '<span class="btn-icon">&#9654;</span>执行工作流';
      btn.title = "执行工作流";
    }
    if (typeof updateTopbarActions === "function") updateTopbarActions();
  }

  function switchBottomTab(tab, activeBottomTab, hooks) {
    const onStatus = hooks && typeof hooks.onStatus === "function" ? hooks.onStatus : () => {};
    const onLogsVisible = hooks && typeof hooks.onLogsVisible === "function" ? hooks.onLogsVisible : () => {};
    let next = "logs";
    if (tab === "preview") next = "preview";
    else if (tab === "report") next = "report";
    else if (tab === "timeline") next = "timeline";
    else if (tab === "logs") next = "logs";

    const logs = document.getElementById("logs");
    const preview = document.getElementById("preview-panel");
    const report = document.getElementById("report-panel");
    const timeline = document.getElementById("timeline-panel");
    const tabLogBtn = document.getElementById("tab-log-btn");
    const tabPreviewBtn = document.getElementById("tab-preview-btn");
    const tabReportBtn = document.getElementById("tab-report-btn");
    const tabTimelineBtn = document.getElementById("tab-timeline-btn");
    const clearBtn = document.getElementById("clear-log-btn");

    const onLogs = next === "logs";
    const onPreview = next === "preview";
    const onReport = next === "report";
    const onTimeline = next === "timeline";
    if (logs) logs.classList.toggle("hidden", !onLogs);
    if (preview) preview.classList.toggle("hidden", !onPreview);
    if (report) report.classList.toggle("hidden", !onReport);
    if (timeline) timeline.classList.toggle("hidden", !onTimeline);
    if (tabLogBtn) tabLogBtn.classList.toggle("active", onLogs);
    if (tabPreviewBtn) tabPreviewBtn.classList.toggle("active", onPreview);
    if (tabReportBtn) tabReportBtn.classList.toggle("active", onReport);
    if (tabTimelineBtn) tabTimelineBtn.classList.toggle("active", onTimeline);
    if (clearBtn) clearBtn.classList.toggle("hidden", !onLogs);
    if (onLogs) onLogsVisible();

    if (onLogs) onStatus("已切换到执行日志");
    else if (onPreview) onStatus("已切换到结果预览");
    else if (onReport) onStatus("已切换到执行报告");
    else onStatus("已切换到运行回放");
    return next;
  }

  root.nodePanel = {
    updateTopbarActionsState,
    updateRunButtonState,
    switchBottomTab,
  };
})();
