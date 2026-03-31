(function () {
  const root = (window.ADBModules = window.ADBModules || {});

  function timelineItemStatusText(status) {
    return status === "error" ? "失败" : "成功";
  }

  function timelineBarWidth(durationMs, elapsedMs) {
    const d = Number(durationMs || 0);
    const e = Math.max(1, Number(elapsedMs || 1));
    return Math.max(1, Math.min(100, (d / e) * 100));
  }

  root.reportReplay = {
    timelineItemStatusText,
    timelineBarWidth,
  };
})();

