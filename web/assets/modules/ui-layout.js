(function () {
  const root = (window.ADBModules = window.ADBModules || {});

  function toggleSidebarLayout(opts) {
    const {
      sidebarCollapsed,
      layoutEl,
      buttonEl,
      onStatus,
      onAfterToggle,
    } = opts || {};
    const next = !sidebarCollapsed;
    if (layoutEl) {
      layoutEl.classList.toggle("sidebar-collapsed", next);
    }
    if (buttonEl) {
      buttonEl.innerHTML = next
        ? '<span class="btn-icon">&#9654;</span>显示节点库'
        : '<span class="btn-icon">&#9664;</span>收起节点库';
    }
    if (typeof onStatus === "function") {
      onStatus(next ? "节点库已收起" : "节点库已展开");
    }
    if (typeof onAfterToggle === "function") {
      onAfterToggle();
    }
    return next;
  }

  function toggleBottomLayout(opts) {
    const {
      bottomCollapsed,
      workspaceEl,
      logPanelEl,
      buttonEl,
      onStatus,
      onAfterToggle,
    } = opts || {};
    const next = !bottomCollapsed;
    if (workspaceEl) workspaceEl.classList.toggle("bottom-collapsed", next);
    if (logPanelEl) logPanelEl.classList.toggle("bottom-collapsed", next);
    if (buttonEl) {
      buttonEl.innerHTML = next
        ? '<span class="btn-icon">&#9650;</span>显示面板'
        : '<span class="btn-icon">&#9660;</span>收起面板';
    }
    if (typeof onStatus === "function") {
      onStatus(next ? "底部面板已收起" : "底部面板已显示");
    }
    if (typeof onAfterToggle === "function") {
      onAfterToggle();
    }
    return next;
  }

  function zoom(canvas, markDirty, setStatus, direction) {
    const curr = Number((canvas && canvas.ds && canvas.ds.scale) || 1);
    const next = direction === "in"
      ? Math.min(2.2, curr * 1.15)
      : Math.max(0.2, curr / 1.15);
    if (canvas && canvas.ds && typeof canvas.ds.changeScale === "function") {
      canvas.ds.changeScale(next, [canvas.canvas.width * 0.5, canvas.canvas.height * 0.5]);
    }
    if (typeof markDirty === "function") markDirty();
    if (typeof setStatus === "function") setStatus("缩放: " + Math.round(next * 100) + "%");
    return next;
  }

  function resetView(canvas, markDirty, setStatus) {
    if (!canvas || !canvas.ds) return;
    canvas.ds.scale = 1;
    canvas.ds.offset[0] = 0;
    canvas.ds.offset[1] = 0;
    if (typeof markDirty === "function") markDirty();
    if (typeof setStatus === "function") setStatus("视图已重置");
  }

  function arrangeNodes(graph, markDirty, fitToView, setStatus) {
    const nodes = ((graph && graph._nodes) || []).slice().sort((a, b) => a.id - b.id);
    const cols = 3;
    const gapX = 340;
    const gapY = 300;
    const startX = 70;
    const startY = 70;
    nodes.forEach((n, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      n.pos = [startX + col * gapX, startY + row * gapY];
    });
    if (typeof markDirty === "function") markDirty();
    if (typeof fitToView === "function") fitToView();
    if (typeof setStatus === "function") setStatus("已自动排布");
  }

  function fitToView(graph, canvas, markDirty, opts) {
    const options = opts || {};
    const nodes = (graph && graph._nodes) || [];
    if (!nodes.length) {
      if (typeof markDirty === "function") markDirty();
      return;
    }
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const n of nodes) {
      const w = (n.size && n.size[0]) || 220;
      const h = (n.size && n.size[1]) || 120;
      minX = Math.min(minX, n.pos[0]);
      minY = Math.min(minY, n.pos[1]);
      maxX = Math.max(maxX, n.pos[0] + w);
      maxY = Math.max(maxY, n.pos[1] + h);
    }
    const graphW = Math.max(1, maxX - minX);
    const graphH = Math.max(1, maxY - minY);
    const cW = Math.max(1, canvas.canvas.width);
    const cH = Math.max(1, canvas.canvas.height);
    const pad = 120;
    const scaleX = (cW - pad) / graphW;
    const scaleY = (cH - pad) / graphH;
    const scale = Math.max(0.25, Math.min(1.2, Math.min(scaleX, scaleY)));
    canvas.ds.scale = scale;
    canvas.ds.offset[0] = cW * 0.5 / scale - (minX + maxX) * 0.5;
    canvas.ds.offset[1] = cH * 0.5 / scale - (minY + maxY) * 0.5;
    if (typeof markDirty === "function") markDirty();
    if (!options.silent && typeof options.onStatus === "function") {
      options.onStatus("已适配视图");
    }
  }

  root.uiLayout = {
    toggleSidebarLayout,
    toggleBottomLayout,
    zoom,
    resetView,
    arrangeNodes,
    fitToView,
  };
})();
