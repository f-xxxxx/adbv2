(function () {
  const root = (window.ADBModules = window.ADBModules || {});

  function startProgress(state, totalCount) {
    state.active = true;
    state.total = Number.isFinite(Number(totalCount)) ? Math.max(0, Number(totalCount)) : 0;
    state.doneSet = new Set();
    state.currentNodeId = null;
  }

  function stopProgress(state) {
    state.active = false;
    state.total = 0;
    state.doneSet = new Set();
    state.currentNodeId = null;
  }

  function resetNodeHighlight(graph, markCanvasDirty) {
    const nodes = graph && graph._nodes ? graph._nodes : [];
    for (const node of nodes) {
      if (!node) continue;
      const backup = node.__progressBackup;
      if (backup) {
        node.color = backup.color;
        node.bgcolor = backup.bgcolor;
        node.boxcolor = backup.boxcolor;
        node.title_text_color = backup.title_text_color;
        node.textcolor = backup.textcolor;
        node.__progressBackup = null;
      }
      node.__progressState = "";
    }
    if (typeof markCanvasDirty === "function") markCanvasDirty();
  }

  function setNodeProgressState(graph, nodeId, state, markCanvasDirty) {
    const id = Number(nodeId);
    if (!Number.isFinite(id)) return;
    const node = graph.getNodeById(id);
    if (!node) return;

    if (!node.__progressBackup) {
      node.__progressBackup = {
        color: node.color,
        bgcolor: node.bgcolor,
        boxcolor: node.boxcolor,
        title_text_color: node.title_text_color,
        textcolor: node.textcolor,
      };
    }

    if (state === "running") {
      node.color = "#7e5618";
      node.bgcolor = "#3a2d1a";
      node.boxcolor = "#f2bc63";
    } else if (state === "done") {
      node.color = "#1f6f49";
      node.bgcolor = "#17372a";
      node.boxcolor = "#62d493";
    } else if (state === "error") {
      node.color = "#8a3030";
      node.bgcolor = "#412222";
      node.boxcolor = "#ff7474";
    }
    node.title_text_color = "#f7fbff";
    node.textcolor = "#f1f6ff";
    node.__progressState = state;
    if (typeof markCanvasDirty === "function") markCanvasDirty();
  }

  function handleRunEvent(state, graph, msg, hooks) {
    const onStatus = hooks && typeof hooks.onStatus === "function" ? hooks.onStatus : () => {};
    const onChange = hooks && typeof hooks.onChange === "function" ? hooks.onChange : () => {};
    const onScheduleRefresh = hooks && typeof hooks.onScheduleRefresh === "function" ? hooks.onScheduleRefresh : () => {};
    const markCanvasDirty = hooks && typeof hooks.markCanvasDirty === "function" ? hooks.markCanvasDirty : () => {};
    const isScheduleActive = hooks && typeof hooks.isScheduleActive === "function" ? hooks.isScheduleActive : () => false;

    const eventName = String(msg.event || "");
    const nodeId = msg.node_id;
    if (nodeId == null) return;
    const nodeText = `节点 ${nodeId}`;

    if (eventName === "node_start") {
      state.currentNodeId = Number.isFinite(Number(nodeId)) ? Number(nodeId) : nodeId;
      setNodeProgressState(graph, nodeId, "running", markCanvasDirty);
      onStatus(`执行中：${nodeText}`);
      onChange();
      if (isScheduleActive()) onScheduleRefresh();
    } else if (eventName === "node_done") {
      if (Number.isFinite(Number(nodeId))) state.doneSet.add(Number(nodeId));
      else state.doneSet.add(String(nodeId));
      setNodeProgressState(graph, nodeId, "done", markCanvasDirty);
      onStatus(`已完成：${nodeText}`);
      onChange();
      if (isScheduleActive()) onScheduleRefresh();
    } else if (eventName === "node_error") {
      state.currentNodeId = Number.isFinite(Number(nodeId)) ? Number(nodeId) : nodeId;
      setNodeProgressState(graph, nodeId, "error", markCanvasDirty);
      onStatus(`执行失败：${nodeText}`);
      onChange();
      if (isScheduleActive()) onScheduleRefresh();
    }
  }

  root.executionState = {
    startProgress,
    stopProgress,
    resetNodeHighlight,
    setNodeProgressState,
    handleRunEvent,
  };
})();
