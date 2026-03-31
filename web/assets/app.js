const graph = new LGraph();
    const canvas = new LGraphCanvas("#graphcanvas", graph);
    canvas.background_image = null;
    canvas.allow_dragcanvas = true;
    canvas.allow_interaction = true;
    canvas.onShowNodePanel = () => false;
    graph.start();
    window.addEventListener("resize", () => {
      canvas.resize();
      fitToView();
    });
    window.addEventListener("beforeunload", () => {
      saveWorkflowSnapshot();
    });

    let deviceOptions = [""];
    let sidebarCollapsed = true;
    let bottomCollapsed = true;
    let activeBottomTab = "logs";
    let currentEditingOcrNode = null;
    let currentEditingExportNode = null;
    let regionHelperReady = false;
    let tapPickerReady = false;
    let swipePickerReady = false;
    let workflowRunning = false;
    let cancelRequestedByUser = false;
    let schedulerRunning = false;
    let runtimeStatusTimer = null;
    let activeScheduleRunId = "";
    let manualRunStreamAbortController = null;
    let scheduleRunStreamAbortController = null;
    let allowAutoLoadScheduleOutcome = false;
    const executionProgress = {
      active: false,
      total: 0,
      doneSet: new Set(),
      currentNodeId: null
    };
    const scheduleListState = {
      items: [],
      page: 1,
      pageSize: 6,
      autoRefreshTimer: null
    };
    let currentScheduleReportPath = "";
    let lastAutoLoadedScheduleReportPath = "";
    let lastAutoLoadedScheduleOutcomeKey = "";
    let currentReportPath = "";
    let currentRunId = "";
    let currentTimelineRunId = "";
    let timelineItems = [];
    let timelinePlayIndex = -1;
    let timelinePlayTimer = null;
    const regionHelper = {
      image: null,
      imageName: "",
      scale: 1,
      offsetX: 0,
      offsetY: 0,
      drawing: false,
      startX: 0,
      startY: 0,
      tempRect: null,
      rects: [],
      activeIndex: -1
    };
    const imageLightboxState = {
      nodeId: null
    };
    const tapPicker = {
      node: null,
      image: null,
      imageName: "",
      tempCaptureToken: "",
      scale: 1,
      offsetX: 0,
      offsetY: 0,
      selectedX: null,
      selectedY: null
    };
    const swipePicker = {
      node: null,
      image: null,
      imageName: "",
      tempCaptureToken: "",
      scale: 1,
      offsetX: 0,
      offsetY: 0,
      startX: null,
      startY: null,
      endX: null,
      endY: null
    };

    const _modules = window.ADBModules || {};
    const _nodeFactory = _modules.nodeFactory || {};
    if (typeof _nodeFactory.createMappings !== "function") {
      throw new Error("node-factory 模块未加载：window.ADBModules.nodeFactory.createMappings 缺失");
    }
    const _nodeMappings = _nodeFactory.createMappings();
    const CLASS_MAP = _nodeMappings.CLASS_MAP || {};
    const CLASS_TO_NODE_MAP =
      _nodeMappings.CLASS_TO_NODE_MAP && Object.keys(_nodeMappings.CLASS_TO_NODE_MAP).length
        ? _nodeMappings.CLASS_TO_NODE_MAP
        : Object.fromEntries(Object.entries(CLASS_MAP).map(([nodeType, classType]) => [classType, nodeType]));
    const WORKFLOW_SNAPSHOT_KEY = "adbflow:last_workflow:v1";

    const _nodeEditor = _modules.nodeEditor || {};
    const _nodePanel = _modules.nodePanel || {};
    const _modalUtils = _modules.modalUtils || {};
    const _modalControllerModule = _modules.modalController || {};
    const _ocrRegionEditorModule = _modules.ocrRegionEditor || {};
    const _dedupKeysEditorModule = _modules.dedupKeysEditor || {};
    const _pickerEditorModule = _modules.pickerEditor || {};
    const _runControl = _modules.runControl || {};
    const _executionState = _modules.executionState || {};
    const _uiLayout = _modules.uiLayout || {};
    const _reportReplay = _modules.reportReplay || {};
    const _reportRuntime = _modules.reportRuntime || {};
    const _reportController = _modules.reportController || {};
    const _runResultHandlerModule = _modules.runResultHandler || {};
    const _previewRendererModule = _modules.previewRenderer || {};
    const _workflowService = _modules.workflowService || {};
    const _workflowSchema = _modules.workflowSchema || {};
    const _reportView = _modules.reportView || {};
    const _modalController = _modalControllerModule.createController
      ? _modalControllerModule.createController(_modalUtils)
      : null;
    let _ocrRegionEditorController = null;
    let _dedupKeysEditorController = null;
    let _pickerEditorController = null;
    let _runResultHandler = null;
    let _previewRenderer = null;
    let workflowSchemaMap = {};

    function ensureRunResultHandler() {
      if (_runResultHandler || !_runResultHandlerModule.createRunResultHandler) return;
      _runResultHandler = _runResultHandlerModule.createRunResultHandler({
        log,
        setStatus,
        clearPreviewTable,
        clearReportPanel,
        clearTimelinePanel,
        applyOutputsToWorkspace,
        setRunInfo: (runId, reportPath) => {
          currentRunId = String(runId || "");
          currentReportPath = String(reportPath || "");
        },
        getRunInfo: () => ({ runId: currentRunId, reportPath: currentReportPath }),
        switchBottomTab,
        reportController: _reportController,
        reportRuntime: _reportRuntime,
        reportView: _reportView,
        reportReplay: _reportReplay,
        renderReportSummaryCard,
        renderRunTimeline,
        setCurrentReportPath: (path) => {
          currentReportPath = String(path || "");
        },
        getCurrentReportPath: () => currentReportPath,
        formatEpochTime,
        escapeHtml,
        clearPreviewImagesOnNodes,
        resetNodeProgressHighlight,
        startExecutionProgress,
        updateRunButtonState,
      });
    }

    function ensurePreviewRenderer() {
      if (_previewRenderer || !_previewRendererModule.createPreviewRenderer) return;
      _previewRenderer = _previewRendererModule.createPreviewRenderer({
        clearPreviewTable,
        getMetaElement: () => document.getElementById("preview-meta-text"),
        getBodyElement: () => document.getElementById("preview-body"),
      });
    }

    function makeIO(node, withInput = true) {
      if (withInput) node.addInput("输入", "数据");
      node.addOutput("输出", "数据");
    }

    function directionValueToLabel(value) {
      return value === "down" ? "下滑" : "上滑";
    }

    function directionLabelToValue(value) {
      return value === "下滑" ? "down" : "up";
    }


    function inputChannelValueToLabel(value) {
      if (value === "adb_keyboard") return "ADB Keyboard";
      if (value === "clipboard") return "剪贴板";
      if (value === "input_text") return "InputText";
      return "自动";
    }

    function inputChannelLabelToValue(value) {
      if (value === "ADB Keyboard") return "adb_keyboard";
      if (value === "剪贴板") return "clipboard";
      if (value === "InputText") return "input_text";
      return "auto";
    }
    if (typeof _nodeFactory.registerBuiltinNodes !== "function") {
      throw new Error("node-factory 模块未加载：window.ADBModules.nodeFactory.registerBuiltinNodes 缺失");
    }
    _nodeFactory.registerBuiltinNodes({
      LiteGraph,
      makeIO,
      directionValueToLabel,
      directionLabelToValue,
      inputChannelValueToLabel,
      inputChannelLabelToValue,
      getDeviceOptions: () => deviceOptions,
      refreshDevices,
      openTapPicker,
      openSwipePicker,
      setStatus,
      openOcrImageLocation,
      openRegionsEditor,
      buildRegionsPreview,
      openDedupKeysEditor,
      buildDedupKeysPreview,
      openInvalidDataKeyEditor,
      buildInvalidDataKeyPreview,
      openExcelOutputLocation,
      syncImageLightboxFromNode,
      openImageLightbox,
    });

    function addNodeByType(type, pos = null) {
      const node = LiteGraph.createNode(type);
      if (!node) return;
      node.pos = Array.isArray(pos) ? pos : [120 + Math.random() * 420, 80 + Math.random() * 240];
      graph.add(node);
      setStatus("已添加节点: " + node.title);
      markCanvasDirty();
      return node;
    }

    function clearGraph() {
      graph.clear();
      closeImageLightbox();
      log("画布已清空");
      setStatus("画布已清空");
      clearWorkflowSnapshot();
      clearPreviewTable();
      markCanvasDirty();
    }

    async function loadDefaultWorkflow() {
      try {
        if (await restoreWorkflowSnapshot()) {
          setStatus("已恢复上次工作流");
          return;
        }
        setStatus("正在加载默认工作流...");
        await loadWorkflowByApi("/api/workflow/default", "example_workflow.json", false);
        setStatus("默认工作流已加载");
      } catch (err) {
        log("加载默认工作流失败: " + err.message);
        setStatus("默认工作流加载失败");
      }
    }

    async function openWorkflowPicker() {
      if (_modalController) _modalController.open("workflow-picker-modal");
      else if (_modalUtils.openModal) _modalUtils.openModal("workflow-picker-modal");
      else document.getElementById("workflow-picker-modal").classList.remove("hidden");
      setStatus("正在读取 workflows 目录...");
      await refreshWorkflowList();
    }

    function closeWorkflowPicker() {
      if (_modalController) _modalController.close("workflow-picker-modal");
      else if (_modalUtils.closeModal) _modalUtils.closeModal("workflow-picker-modal");
      else document.getElementById("workflow-picker-modal").classList.add("hidden");
    }

    async function refreshWorkflowList() {
      const list = document.getElementById("workflow-list");
      const dirText = document.getElementById("workflow-dir-text");
      list.innerHTML = '<div class="workflow-empty">正在读取工作流列表...</div>';
      try {
        if (_workflowService.listWorkflows) {
          const data = await _workflowService.listWorkflows();
          dirText.textContent = `目录：${data.dir || "workflows"}`;
          renderWorkflowList(Array.isArray(data.files) ? data.files : []);
        } else {
          const res = await fetch("/api/workflows");
          const data = await res.json();
          if (!data.ok) throw new Error(data.error || "读取工作流列表失败");
          dirText.textContent = `目录：${data.dir || "workflows"}`;
          renderWorkflowList(Array.isArray(data.files) ? data.files : []);
        }
      } catch (err) {
        list.innerHTML = `<div class="workflow-empty">读取失败：${String(err.message || err)}</div>`;
      }
    }

    function renderWorkflowList(files) {
      const list = document.getElementById("workflow-list");
      list.innerHTML = "";
      if (!files.length) {
        list.innerHTML = '<div class="workflow-empty">未找到工作流文件（*.json）。</div>';
        return;
      }
      for (const name of files) {
        const row = document.createElement("div");
        row.className = "workflow-item";
        const nameEl = document.createElement("div");
        nameEl.className = "workflow-item-name";
        nameEl.textContent = name;
        row.appendChild(nameEl);
        const btn = document.createElement("button");
        btn.textContent = "加载";
        btn.style.height = "24px";
        btn.style.padding = "0 10px";
        btn.addEventListener("click", async () => {
          await loadWorkflowByName(name, true);
        });
        row.appendChild(btn);
        list.appendChild(row);
      }
    }

    async function loadWorkflowByName(name, closePicker = true) {
      const queryName = encodeURIComponent(name);
      await loadWorkflowByApi(`/api/workflow/load?name=${queryName}`, name, closePicker);
    }

    async function loadWorkflowByApi(apiUrl, displayName, closePicker) {
      let data = null;
      if (_workflowService.loadWorkflowByUrl) {
        data = await _workflowService.loadWorkflowByUrl(apiUrl);
      } else {
        const res = await fetch(apiUrl);
        data = await res.json();
        if (!data.ok) throw new Error(data.error || "加载工作流失败");
      }
      importWorkflowToCanvas(data.workflow || {});
      notifyWorkflowMigrationWarnings(data.migration_warnings, displayName);
      log(`已加载工作流: ${displayName}`);
      setStatus(`已加载工作流: ${displayName}`);
      if (closePicker) closeWorkflowPicker();
    }

    function chooseLocalWorkflowFile() {
      const input = document.getElementById("workflow-local-file");
      if (!input) return;
      input.value = "";
      input.click();
    }

    function handleLocalWorkflowFileChange(event) {
      const file = event.target && event.target.files ? event.target.files[0] : null;
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const text = String(reader.result || "");
          const workflow = JSON.parse(text);
          if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) {
            throw new Error("工作流内容必须是对象格式");
          }
          const normalized = await normalizeWorkflowByApi(workflow);
          importWorkflowToCanvas(normalized.workflow || workflow);
          notifyWorkflowMigrationWarnings(normalized.migration_warnings, file.name);
          log(`已从本地加载工作流: ${file.name}`);
          setStatus(`已加载本地工作流: ${file.name}`);
          closeWorkflowPicker();
        } catch (err) {
          const msg = err && err.message ? err.message : String(err);
          log("本地工作流加载失败: " + msg);
          setStatus("本地工作流加载失败");
        }
      };
      reader.onerror = () => {
        log("本地工作流读取失败");
        setStatus("本地工作流读取失败");
      };
      reader.readAsText(file, "utf-8");
    }

    function importWorkflowToCanvas(workflow, persistSnapshot = true) {
      graph.clear();
      clearReportPanel("执行报告：暂无");
      clearTimelinePanel("运行回放：暂无");
      clearPreviewTable("结果预览：暂无");
      if (persistSnapshot) {
        allowAutoLoadScheduleOutcome = false;
      }
      const idToNode = new Map();
      const entries = Object.entries(workflow || {}).sort((a, b) => Number(a[0]) - Number(b[0]));

      for (let i = 0; i < entries.length; i++) {
        const [nodeId, config] = entries[i];
        const classType = config && config.class_type ? String(config.class_type) : "";
        const nodeType = CLASS_TO_NODE_MAP[classType];
        if (!nodeType) {
          log(`跳过不支持的节点类型: ${classType}（节点 ${nodeId}）`);
          continue;
        }
        const col = i % 4;
        const row = Math.floor(i / 4);
        const node = addNodeByType(nodeType, [80 + col * 340, 80 + row * 300]);
        if (!node) continue;
        node.__classType = classType;

        const rawInputs = (config && config.inputs && typeof config.inputs === "object") ? config.inputs : {};
        const props = {};
        for (const [key, value] of Object.entries(rawInputs)) {
          if (isLinkRef(value)) continue;
          props[key] = value;
        }
        applyNodeProperties(node, props);
        idToNode.set(String(nodeId), node);
      }

      for (const [nodeId, config] of entries) {
        const currentNode = idToNode.get(String(nodeId));
        if (!currentNode) continue;
        const rawInputs = (config && config.inputs && typeof config.inputs === "object") ? config.inputs : {};
        const ref = rawInputs.input;
        if (!isLinkRef(ref)) continue;
        const srcNode = idToNode.get(String(ref[0]));
        if (!srcNode) continue;
        srcNode.connect(Number(ref[1] || 0), currentNode, 0);
      }

      fitToView();
      markCanvasDirty();
      if (persistSnapshot) {
        saveWorkflowSnapshot(workflow);
      }
    }

    function saveWorkflowSnapshot(workflow = null) {
      try {
        const payload = workflow && typeof workflow === "object" && !Array.isArray(workflow)
          ? workflow
          : serializeWorkflow();
        if (!payload || !Object.keys(payload).length) return;
        localStorage.setItem(WORKFLOW_SNAPSHOT_KEY, JSON.stringify(payload));
      } catch (_err) {
      }
    }

    async function restoreWorkflowSnapshot() {
      try {
        const text = localStorage.getItem(WORKFLOW_SNAPSHOT_KEY);
        if (!text) return false;
        const payload = JSON.parse(text);
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
        if (!Object.keys(payload).length) return false;
        const normalized = await normalizeWorkflowByApi(payload);
        importWorkflowToCanvas(normalized.workflow || payload, false);
        notifyWorkflowMigrationWarnings(normalized.migration_warnings, "本地快照");
        log("已恢复上次工作流快照");
        return true;
      } catch (_err) {
        return false;
      }
    }

    async function normalizeWorkflowByApi(workflow) {
      if (_workflowService.normalizeWorkflow) {
        return await _workflowService.normalizeWorkflow(workflow);
      }
      const res = await fetch("/api/workflow/normalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow })
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "工作流校验失败");
      return {
        workflow: data.workflow || workflow,
        migration_warnings: Array.isArray(data.migration_warnings) ? data.migration_warnings : []
      };
    }

    async function loadWorkflowSchema() {
      try {
        if (_workflowService.fetchJson) {
          const data = await _workflowService.fetchJson("/api/workflow/schema");
          workflowSchemaMap = data && data.schema && typeof data.schema === "object" ? data.schema : {};
          return;
        }
        const res = await fetch("/api/workflow/schema");
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || "读取工作流 schema 失败");
        workflowSchemaMap = data && data.schema && typeof data.schema === "object" ? data.schema : {};
      } catch (err) {
        workflowSchemaMap = {};
        log("读取工作流 schema 失败，已回退后端校验: " + (err && err.message ? err.message : String(err)));
      }
    }

    function validateWorkflowBeforeSubmit(workflow) {
      if (!_workflowSchema.validateAndNormalize || !workflowSchemaMap || !Object.keys(workflowSchemaMap).length) {
        return { workflow, warnings: [] };
      }
      const res = _workflowSchema.validateAndNormalize(workflow, workflowSchemaMap);
      if (!res.ok) {
        const msg = Array.isArray(res.errors) && res.errors.length
          ? res.errors.join("；")
          : "工作流前端校验失败";
        throw new Error(msg);
      }
      return {
        workflow: res.workflow || workflow,
        warnings: Array.isArray(res.warnings) ? res.warnings : [],
      };
    }

    function notifyWorkflowMigrationWarnings(warnings, label = "") {
      const list = Array.isArray(warnings) ? warnings : [];
      if (!list.length) return;
      const head = label ? `[${label}] ` : "";
      log(`${head}工作流已自动迁移 ${list.length} 项`);
      for (const w of list.slice(0, 12)) {
        log(`- ${String(w)}`);
      }
      if (list.length > 12) {
        log(`- 其余 ${list.length - 12} 项已省略`);
      }
      setStatus(`已自动迁移工作流字段（${list.length}项）`);
    }

    function ensureNodeEditorControllers() {
      if (!_ocrRegionEditorController && _ocrRegionEditorModule.createOcrRegionEditor) {
        _ocrRegionEditorController = _ocrRegionEditorModule.createOcrRegionEditor({
          regionHelper,
          markCanvasDirty,
          setStatus,
          modalController: _modalController,
          getCurrentNode: () => currentEditingOcrNode,
          setCurrentNode: (node) => {
            currentEditingOcrNode = node;
          },
        });
      }
      if (!_dedupKeysEditorController && _dedupKeysEditorModule.createDedupKeysEditor) {
        _dedupKeysEditorController = _dedupKeysEditorModule.createDedupKeysEditor({
          graph,
          classMap: CLASS_MAP,
          markCanvasDirty,
          setStatus,
          modalController: _modalController,
          getCurrentNode: () => currentEditingExportNode,
          setCurrentNode: (node) => {
            currentEditingExportNode = node;
          },
          parseRegionNamesFromRaw: (raw) => {
            if (_ocrRegionEditorController && _ocrRegionEditorController.parseRegionNamesFromRaw) {
              return _ocrRegionEditorController.parseRegionNamesFromRaw(raw);
            }
            return [];
          },
        });
      }
      if (!_pickerEditorController && _pickerEditorModule.createPickerEditor) {
        _pickerEditorController = _pickerEditorModule.createPickerEditor({
          graph,
          classMap: CLASS_MAP,
          tapPicker,
          swipePicker,
          markCanvasDirty,
          setStatus,
          log,
          directionValueToLabel,
          modalController: _modalController,
        });
      }
    }

    function clearWorkflowSnapshot() {
      try {
        localStorage.removeItem(WORKFLOW_SNAPSHOT_KEY);
      } catch (_err) {
      }
    }

    function isLinkRef(value) {
      if (_nodeEditor.isLinkRef) return _nodeEditor.isLinkRef(value);
      return (
        Array.isArray(value) &&
        value.length === 2 &&
        (typeof value[0] === "string" || typeof value[0] === "number") &&
        Number.isInteger(value[1])
      );
    }

    function applyNodeProperties(node, props) {
      node.properties = { ...(node.properties || {}), ...(props || {}) };
      const ct = node.__classType || "";
      const widgets = node.widgets || [];
      const setWidgetByName = (name, value) => {
        const w = widgets.find((it) => String(it && it.name || "") === String(name));
        if (w) w.value = value;
        return !!w;
      };

      if (ct === "StartDevice") {
        if (widgets[0]) widgets[0].value = node.properties.device_id || "";
      } else if (ct === "InputFill") {
        if (widgets[0]) widgets[0].value = inputChannelValueToLabel(node.properties.text_channel || "clipboard");
        if (widgets[1]) widgets[1].value = node.properties.text || "";
      } else if (ct === "Tap") {
        if (!setWidgetByName("横坐标", Number(node.properties.x ?? 540)) && widgets[0]) widgets[0].value = Number(node.properties.x ?? 540);
        if (!setWidgetByName("纵坐标", Number(node.properties.y ?? 1600)) && widgets[1]) widgets[1].value = Number(node.properties.y ?? 1600);
        setWidgetByName("动作后等待(秒)", Number(node.properties.post_wait_sec ?? 0));
      } else if (ct === "Swipe") {
        setWidgetByName("滑动方向", directionValueToLabel(node.properties.direction || "up"));
        setWidgetByName("滑动时长(毫秒)", Number(node.properties.duration_ms ?? 350));
        setWidgetByName("滑动像素", Number(node.properties.distance_px ?? 420));
        setWidgetByName("动作后等待(秒)", Number(node.properties.post_wait_sec ?? 0));
        setWidgetByName("起点X(可选)", node.properties.x == null ? "" : String(node.properties.x));
        setWidgetByName("起点Y(可选)", node.properties.y == null ? "" : String(node.properties.y));
      } else if (ct === "Wait") {
        if (widgets[0]) widgets[0].value = Number(node.properties.duration_sec ?? 0.8);
      } else if (ct === "Screenshot") {
        setWidgetByName("手机目录", node.properties.remote_dir || "/sdcard/adbflow");
        setWidgetByName("文件名前缀", node.properties.prefix || "capture");
        setWidgetByName("动作后等待(秒)", Number(node.properties.post_wait_sec ?? 0));
      } else if (ct === "LoopStart") {
        if (widgets[0]) widgets[0].value = Number(node.properties.loop_count ?? 5);
        if (widgets[1]) widgets[1].value = Number(node.properties.loop_start_wait_sec ?? 0.6);
      } else if (ct === "PullToPC") {
        if (widgets[0]) widgets[0].value = node.properties.save_dir || "outputs/screenshots";
        if (widgets[1]) widgets[1].value = !!node.properties.clear_save_dir;
        if (widgets[2]) widgets[2].value = node.properties.cleanup_remote !== false;
      } else if (ct === "EasyOCR") {
        if (widgets[0]) widgets[0].value = node.properties.languages || "ch_sim,en";
        if (widgets[1]) widgets[1].value = !!node.properties.gpu;
        if (widgets[2]) widgets[2].value = node.properties.image_dir || "";
        syncOcrRegionsPreview(node);
      } else if (ct === "ExportExcel") {
        if (widgets[0]) widgets[0].value = node.properties.output_path || "outputs/docs/ocr_result.xlsx";
        if (widgets[1]) widgets[1].value = !!node.properties.append_mode;
        syncExportDedupPreview(node);
        syncExportInvalidDataKeyPreview(node);
      } else if (ct === "PreviewExcel") {
        if (widgets[0]) widgets[0].value = Number(node.properties.max_rows ?? 10);
      } else if (ct === "PreviewImages") {
        if (widgets[0]) widgets[0].value = node.properties.folder_dir || "";
        if (widgets[1]) widgets[1].value = Number(node.properties.max_images ?? 12);
        if (typeof node.syncFolderDirReadonly === "function") {
          node.syncFolderDirReadonly();
        }
      }
    }

    function serializeWorkflow() {
      const data = graph.serialize();
      const links = new Map();
      for (const item of (data.links || [])) {
        links.set(item[0], item);
      }

      const nodes = (data.nodes || []).slice().sort((a, b) => a.id - b.id);
      const workflow = {};
      for (const node of nodes) {
        const classType = CLASS_MAP[node.type];
        if (!classType) continue;
        const rawInputs = { ...(node.properties || {}) };
        const inputs = _nodeEditor.normalizeInputsForSerialize
          ? _nodeEditor.normalizeInputsForSerialize(classType, rawInputs)
          : rawInputs;
        const inputPort = node.inputs && node.inputs[0];
        if (inputPort && inputPort.link != null) {
          const lk = links.get(inputPort.link);
          if (lk) {
            inputs.input = [String(lk[1]), Number(lk[2] || 0)];
          }
        }
        workflow[String(node.id)] = { class_type: classType, inputs };
      }
      return workflow;
    }

    async function refreshDevices() {
      try {
        setStatus("正在刷新设备...");
        const res = await fetch("/api/devices");
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || "设备读取失败");
        deviceOptions = ["", ...data.devices];
        log("设备列表: " + (data.devices.length ? data.devices.join(", ") : "无在线设备"));
        setStatus("设备刷新完成");
      } catch (err) {
        log("刷新设备失败: " + err.message);
        setStatus("设备刷新失败");
      }
    }

    async function openExcelOutputLocation(node) {
      const outputPath = String((node && node.properties && node.properties.output_path) || "outputs/docs/ocr_result.xlsx").trim();
      if (!outputPath) {
        setStatus("请先配置导出文件路径");
        return;
      }
      try {
        setStatus("正在打开文件所在位置...");
        const res = await fetch("/api/open-location", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: outputPath })
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || "打开失败");
        const openedDir = String(data.opened_dir || "");
        const selectedFile = String(data.selected_file || "");
        if (selectedFile) {
          log(`已打开目录：${openedDir}（已定位文件）`);
        } else {
          log(`已打开目录：${openedDir}`);
        }
        setStatus("已打开文件所在位置");
      } catch (err) {
        log("打开文件所在位置失败: " + err.message);
        setStatus("打开文件所在位置失败");
      }
    }

    async function openOcrImageLocation(node) {
      let imageDir = String((node && node.properties && node.properties.image_dir) || "").trim();
      if (!imageDir) {
        imageDir = "outputs/screenshots";
        log("文字识别节点未设置图片文件夹，尝试打开默认目录：outputs/screenshots");
      }
      try {
        setStatus("正在打开图片文件位置...");
        const res = await fetch("/api/open-location", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: imageDir })
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || "打开失败");
        const openedDir = String(data.opened_dir || "");
        log(`已打开图片目录：${openedDir}`);
        setStatus("已打开图片文件位置");
      } catch (err) {
        log("打开图片文件位置失败: " + err.message);
        setStatus("打开图片文件位置失败");
      }
    }

    function updateTopbarActionsState() {
      if (_nodePanel.updateTopbarActionsState) {
        _nodePanel.updateTopbarActionsState(workflowRunning, schedulerRunning);
        return;
      }
      const bar = document.querySelector(".bar-actions");
      if (!bar) return;
      const locked = workflowRunning || schedulerRunning;
      const buttons = bar.querySelectorAll("button");
      buttons.forEach((btn) => {
        if (btn.id === "run-workflow-btn") {
          btn.disabled = false;
        } else {
          btn.disabled = locked;
        }
      });
    }

    function updateRunButtonState() {
      if (_nodePanel.updateRunButtonState) {
        _nodePanel.updateRunButtonState({
          workflowRunning,
          schedulerRunning,
          executionProgress,
          updateTopbarActions: updateTopbarActionsState,
        });
        return;
      }
      const btn = document.getElementById("run-workflow-btn");
      if (!btn) return;
      const hasProgress = executionProgress.active && executionProgress.total > 0;
      const doneCount = executionProgress.doneSet.size;
      const progressText = hasProgress
        ? `执行中 ${Math.min(doneCount, executionProgress.total)}/${executionProgress.total}`
        : "执行中...";
      if (workflowRunning || schedulerRunning) {
        btn.classList.remove("primary");
        btn.classList.add("warn");
        btn.innerHTML = `<span class="btn-icon">&#9209;</span>停止`;
        updateTopbarActionsState();
        return;
      }
      btn.classList.remove("warn");
      btn.classList.add("primary");
      btn.innerHTML = '<span class="btn-icon">&#9654;</span>执行工作流';
      updateTopbarActionsState();
    }

    function startExecutionProgress(workflow) {
      const total = workflow && typeof workflow === "object" ? Object.keys(workflow).length : 0;
      if (_executionState.startProgress) _executionState.startProgress(executionProgress, total);
      else {
        executionProgress.active = true;
        executionProgress.total = Number.isFinite(total) ? Math.max(0, total) : 0;
        executionProgress.doneSet = new Set();
        executionProgress.currentNodeId = null;
      }
      updateRunButtonState();
    }

    function stopExecutionProgress() {
      if (_executionState.stopProgress) _executionState.stopProgress(executionProgress);
      else {
        executionProgress.active = false;
        executionProgress.total = 0;
        executionProgress.doneSet = new Set();
        executionProgress.currentNodeId = null;
      }
      updateRunButtonState();
    }

    async function refreshRuntimeStatus(silent = true) {
      try {
        const res = await fetch("/api/runtime-status");
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || "状态读取失败");
        schedulerRunning = !!data.scheduler_running;
        if (schedulerRunning) {
          allowAutoLoadScheduleOutcome = true;
        }
        updateRunButtonState();
      } catch (err) {
        if (!silent) {
          log("读取运行状态失败: " + err.message);
        }
      }
    }

    async function cancelRunningWorkflow() {
      try {
        abortActiveRunStreams();
        setStatus("正在发送停止信号...");
        const res = await fetch("/api/run-cancel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({})
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || "停止失败");
        cancelRequestedByUser = true;
        log("已发送停止信号，等待当前节点收尾...");
        setStatus("已发送停止信号");
      } catch (err) {
        log("停止执行失败: " + err.message);
        setStatus("停止执行失败");
      }
    }

    function abortActiveRunStreams() {
      const ctrls = [manualRunStreamAbortController, scheduleRunStreamAbortController];
      for (const ctrl of ctrls) {
        if (!ctrl) continue;
        try {
          ctrl.abort();
        } catch (_err) {
        }
      }
      manualRunStreamAbortController = null;
      scheduleRunStreamAbortController = null;
    }

    function resetNodeProgressHighlight() {
      if (_executionState.resetNodeHighlight) {
        _executionState.resetNodeHighlight(graph, markCanvasDirty);
        return;
      }
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
      markCanvasDirty();
    }

    function setNodeProgressState(nodeId, state) {
      if (_executionState.setNodeProgressState) {
        _executionState.setNodeProgressState(graph, nodeId, state, markCanvasDirty);
        return;
      }
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
          textcolor: node.textcolor
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
      markCanvasDirty();
    }

    function handleRunEventMessage(msg) {
      if (_executionState.handleRunEvent) {
        _executionState.handleRunEvent(executionProgress, graph, msg, {
          onStatus: setStatus,
          onChange: updateRunButtonState,
          onScheduleRefresh: renderScheduleList,
          markCanvasDirty,
          isScheduleActive: () => !!activeScheduleRunId,
        });
        return;
      }
      const eventName = String(msg.event || "");
      const nodeId = msg.node_id;
      if (nodeId == null) return;
      const nodeText = `节点 ${nodeId}`;

      if (eventName === "node_start") {
        executionProgress.currentNodeId = Number.isFinite(Number(nodeId)) ? Number(nodeId) : nodeId;
        setNodeProgressState(nodeId, "running");
        setStatus(`执行中：${nodeText}`);
        updateRunButtonState();
        if (activeScheduleRunId) renderScheduleList();
      } else if (eventName === "node_done") {
        if (Number.isFinite(Number(nodeId))) executionProgress.doneSet.add(Number(nodeId));
        else executionProgress.doneSet.add(String(nodeId));
        setNodeProgressState(nodeId, "done");
        setStatus(`已完成：${nodeText}`);
        updateRunButtonState();
        if (activeScheduleRunId) renderScheduleList();
      } else if (eventName === "node_error") {
        executionProgress.currentNodeId = Number.isFinite(Number(nodeId)) ? Number(nodeId) : nodeId;
        setNodeProgressState(nodeId, "error");
        setStatus(`执行失败：${nodeText}`);
        updateRunButtonState();
        if (activeScheduleRunId) renderScheduleList();
      }
    }

    async function runWorkflowStream(workflow) {
      const controller = new AbortController();
      manualRunStreamAbortController = controller;
      try {
        try {
          var res = await fetch("/api/run-stream", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ workflow }),
            signal: controller.signal,
          });
        } catch (err) {
          if (err && err.name === "AbortError") throw new Error("执行已取消");
          throw err;
        }

        if (!res.ok) {
          try {
            const data = await res.json();
            const msg = data && data.error ? String(data.error) : "";
            if (msg) throw new Error(msg);
          } catch (err) {
            if (err && err.message) throw err;
            throw new Error(`执行失败（HTTP ${res.status}）`);
          }
        }

        if (!res.body || typeof res.body.getReader !== "function") {
          const fallbackRes = await fetch("/api/run", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ workflow }),
            signal: controller.signal,
          });
          const fallbackData = await fallbackRes.json();
          if (!fallbackData.ok) throw new Error(fallbackData.error || "执行失败");
          for (const line of (fallbackData.logs || [])) log(line);
          return {
            outputs: fallbackData.outputs || {},
            logs: fallbackData.logs || [],
            report_path: fallbackData.report_path || "",
            run_id: fallbackData.run_id || "",
            migration_warnings: Array.isArray(fallbackData.migration_warnings) ? fallbackData.migration_warnings : []
          };
        }
        if (_runControl.parseNdjsonStream) {
          try {
            return await _runControl.parseNdjsonStream(res, {
              onLog: (line) => log(line),
              onEvent: (evt) => handleRunEventMessage(evt),
            });
          } catch (err) {
            if (controller.signal.aborted || (err && err.name === "AbortError")) {
              throw new Error("执行已取消");
            }
            throw err;
          }
        }
        throw new Error("运行模块未加载");
      } finally {
        if (manualRunStreamAbortController === controller) {
          manualRunStreamAbortController = null;
        }
      }
    }

    async function runWorkflow() {
      if (workflowRunning) {
        await cancelRunningWorkflow();
        return;
      }
      if (schedulerRunning) {
        await cancelRunningWorkflow();
        return;
      }
      const runStartedAt = performance.now();
      const workflowRaw = serializeWorkflow();
      if (!Object.keys(workflowRaw).length) {
        log("没有可执行节点");
        setStatus("没有可执行节点");
        return;
      }
      let workflow = workflowRaw;
      try {
        const check = validateWorkflowBeforeSubmit(workflowRaw);
        workflow = check.workflow || workflowRaw;
        notifyWorkflowMigrationWarnings(check.warnings, "前端校验");
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        log("执行前校验失败: " + msg);
        setStatus("执行前校验失败");
        return;
      }
      log("开始执行工作流...");
      setStatus("工作流执行中...");
      // 手动执行时禁用调度结果自动覆盖，避免节点预览被历史调度报告串改。
      allowAutoLoadScheduleOutcome = false;
      cancelRequestedByUser = false;
      workflowRunning = true;
      ensureRunResultHandler();
      if (_runResultHandler && _runResultHandler.handleManualRunStart) {
        _runResultHandler.handleManualRunStart(workflow);
      } else {
        updateRunButtonState();
        clearPreviewTable("结果预览：执行中...");
        clearTimelinePanel("执行回放：执行中...");
        clearPreviewImagesOnNodes();
        resetNodeProgressHighlight();
        startExecutionProgress(workflow);
      }
      try {
        const data = await runWorkflowStream(workflow);
        notifyWorkflowMigrationWarnings(data.migration_warnings, "执行前校验");
        const elapsedSec = ((performance.now() - runStartedAt) / 1000).toFixed(2);
        ensureRunResultHandler();
        if (_runResultHandler && _runResultHandler.handleManualRunSuccess) {
          await _runResultHandler.handleManualRunSuccess(data, elapsedSec);
        } else {
          log("执行完成。输出节点: " + Object.keys(data.outputs || {}).join(", "));
          log(`执行耗时: ${elapsedSec} 秒`);
          if (data.report_path) {
            log(`执行报告: ${data.report_path}`);
            currentRunId = String(data.run_id || "");
            currentReportPath = String(data.report_path || "");
            await openReportInBottomTab(currentReportPath, "手动执行报告", currentRunId);
          }
          await applyOutputsToWorkspace(data.outputs || {});
          setStatus("执行完成");
        }
      } catch (err) {
        ensureRunResultHandler();
        if (_runResultHandler && _runResultHandler.handleManualRunFailure) {
          _runResultHandler.handleManualRunFailure(err, cancelRequestedByUser);
        } else {
          const msg = err && err.message ? String(err.message) : String(err);
          if (msg.includes("执行已取消")) {
            if (cancelRequestedByUser) {
              log("执行已停止：用户手动停止");
              clearPreviewTable("结果预览：用户手动停止");
              setStatus("已手动停止");
            } else {
              log("执行已取消");
              clearPreviewTable("结果预览：执行已取消");
              setStatus("执行已取消");
            }
          } else {
            log("执行失败: " + msg);
            clearPreviewTable("结果预览：执行失败");
            setStatus("执行失败");
          }
          currentRunId = "";
          currentReportPath = "";
          clearReportPanel("执行报告：执行失败（未加载历史报告）");
          clearTimelinePanel("运行回放：执行失败（未加载历史回放）");
        }
      } finally {
        cancelRequestedByUser = false;
        workflowRunning = false;
        allowAutoLoadScheduleOutcome = false;
        stopExecutionProgress();
        resetNodeProgressHighlight();
        await refreshRuntimeStatus(true);
        updateRunButtonState();
      }
    }

    function exportWorkflow() {
      const workflow = serializeWorkflow();
      const text = JSON.stringify(workflow, null, 2);
      const filename = `workflow_${formatNowForFileName()}.json`;
      try {
        downloadTextAsFile(text, filename, "application/json;charset=utf-8");
        log(`工作流配置已保存: ${filename}`);
        setStatus("配置已保存到本地");
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        log("保存配置失败: " + msg);
        setStatus("配置保存失败");
      }
    }

    function openScheduleModal() {
      const workflowRaw = serializeWorkflow();
      if (!Object.keys(workflowRaw).length) {
        setStatus("画布为空，无法创建调度");
        return;
      }
      let workflow = workflowRaw;
      try {
        const check = validateWorkflowBeforeSubmit(workflowRaw);
        workflow = check.workflow || workflowRaw;
        notifyWorkflowMigrationWarnings(check.warnings, "前端校验");
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        setStatus("创建调度前校验失败");
        log("创建调度前校验失败: " + msg);
        return;
      }
      const nameInput = document.getElementById("schedule-name-input");
      const intervalInput = document.getElementById("schedule-interval-input");
      const maxRunsInput = document.getElementById("schedule-max-runs-input");
      const runNowInput = document.getElementById("schedule-run-now-input");
      if (nameInput) nameInput.value = "";
      if (intervalInput) intervalInput.value = "300";
      if (maxRunsInput) maxRunsInput.value = "0";
      if (runNowInput) runNowInput.checked = false;
      if (_modalController) _modalController.open("schedule-modal");
      else {
        const modal = document.getElementById("schedule-modal");
        if (modal) modal.classList.remove("hidden");
      }
      setStatus("请设置调度间隔和执行批次");
    }

    function closeScheduleModal() {
      if (_modalController) _modalController.close("schedule-modal");
      else {
        const modal = document.getElementById("schedule-modal");
        if (modal) modal.classList.add("hidden");
      }
    }

    function createScheduleTask() {
      openScheduleModal();
    }

    async function submitScheduleTask() {
      const workflow = serializeWorkflow();
      if (!Object.keys(workflow).length) {
        setStatus("画布为空，无法创建调度");
        return;
      }
      const nameInput = document.getElementById("schedule-name-input");
      const intervalInput = document.getElementById("schedule-interval-input");
      const maxRunsInput = document.getElementById("schedule-max-runs-input");
      const runNowInput = document.getElementById("schedule-run-now-input");
      const taskName = String(nameInput ? nameInput.value : "").trim();
      const intervalSec = Number(intervalInput ? intervalInput.value : "");
      const maxRuns = Number(maxRunsInput ? maxRunsInput.value : "");
      const runNow = !!(runNowInput && runNowInput.checked);
      if (!taskName) {
        setStatus("任务名称不能为空");
        return;
      }
      if (!Number.isFinite(intervalSec) || intervalSec < 10) {
        setStatus("间隔秒数无效，必须 >= 10");
        return;
      }
      if (!Number.isFinite(maxRuns) || maxRuns < 0) {
        setStatus("执行批次无效，必须 >= 0");
        return;
      }
      try {
        const res = await fetch("/api/schedules", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            task_name: taskName,
            workflow,
            interval_sec: Math.trunc(intervalSec),
            max_runs: Math.trunc(maxRuns),
            run_now: runNow
          })
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || "创建调度失败");
        notifyWorkflowMigrationWarnings(data.migration_warnings, "创建调度");
        const planText = Number(data.item.max_runs || 0) > 0 ? `${data.item.max_runs} 批` : "无限次";
        log(`调度已创建: ${data.item.task_name || data.item.id} (${data.item.workflow_name || "工作区工作流"}) 每 ${data.item.interval_sec}s，批次=${planText}${runNow ? "，立即执行=是" : ""}`);
        setStatus(runNow ? "任务调度已创建并立即执行" : "任务调度已创建");
        if (runNow) {
          schedulerRunning = true;
          updateRunButtonState();
          switchBottomTab("report");
          clearReportPanel("执行报告：调度正在执行...");
          clearPreviewTable("结果预览：调度执行中...");
        }
        closeScheduleModal();
        await refreshRuntimeStatus(true);
      } catch (err) {
        log("创建调度失败: " + err.message);
        setStatus("创建调度失败");
      }
    }

    function showScheduleList() {
      openScheduleListModal();
      refreshScheduleList(true);
    }

    function openScheduleListModal() {
      if (_modalController) _modalController.open("schedule-list-modal");
      else {
        const modal = document.getElementById("schedule-list-modal");
        if (modal) modal.classList.remove("hidden");
      }
      if (scheduleListState.autoRefreshTimer) clearInterval(scheduleListState.autoRefreshTimer);
      scheduleListState.autoRefreshTimer = setInterval(() => {
        const listModal = document.getElementById("schedule-list-modal");
        if (!listModal || listModal.classList.contains("hidden")) return;
        refreshScheduleList(false);
      }, 5000);
      setStatus("已打开调度列表");
    }

    function closeScheduleListModal() {
      if (_modalController) _modalController.close("schedule-list-modal");
      else {
        const modal = document.getElementById("schedule-list-modal");
        if (modal) modal.classList.add("hidden");
      }
      if (scheduleListState.autoRefreshTimer) {
        clearInterval(scheduleListState.autoRefreshTimer);
        scheduleListState.autoRefreshTimer = null;
      }
    }

    function schedulePrevPage() {
      if (scheduleListState.page <= 1) return;
      scheduleListState.page -= 1;
      renderScheduleList();
    }

    function scheduleNextPage() {
      const total = scheduleListState.items.length;
      const maxPage = Math.max(1, Math.ceil(total / scheduleListState.pageSize));
      if (scheduleListState.page >= maxPage) return;
      scheduleListState.page += 1;
      renderScheduleList();
    }

    function formatEpochTime(value) {
      const num = Number(value || 0);
      if (!Number.isFinite(num) || num <= 0) return "-";
      const d = new Date(num * 1000);
      if (Number.isNaN(d.getTime())) return "-";
      const p2 = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
    }

    function getScheduleExportDirs(item) {
      const list = Array.isArray(item && item.export_dirs) ? item.export_dirs : [];
      const dirs = list.map((x) => String(x || "").trim()).filter(Boolean);
      if (dirs.length) return dirs;
      const id = String(item && item.id ? item.id : "").trim();
      if (id) return [`outputs/docs/${id}`];
      return [];
    }

    function buildScheduleOutcomeKey(item) {
      if (!item) return "";
      const scheduleId = String(item.id || "").trim();
      const reportPath = String(item.last_report_path || "").trim();
      const runId = String(item.last_run_id || "").trim();
      const lastRunAt = Number(item.last_run_at || 0);
      if (!scheduleId || !reportPath || !Number.isFinite(lastRunAt) || lastRunAt <= 0) return "";
      if (runId) return `${scheduleId}|${runId}`;
      return `${scheduleId}|${lastRunAt}|${reportPath}`;
    }

    function statusTextFromSchedule(item) {
      if (!item) return "未知";
      const sameSchedule = String(item.id || "") === String(activeScheduleRunId || "");
      if (sameSchedule && executionProgress.active) {
        if (executionProgress.total > 0) {
          const done = Math.min(executionProgress.doneSet.size, executionProgress.total);
          return `执行中 ${done}/${executionProgress.total}`;
        }
        return "执行中";
      }
      const raw = String(item.last_status || "").toLowerCase();
      if (raw === "running") return "执行中";
      if (raw === "ok") return "成功";
      if (raw === "error") return "失败";
      if (raw === "done") return "已完成";
      if (raw === "busy") return "排队中";
      if (item.enabled) return "待执行";
      return "已停止";
    }

    function statusClassFromSchedule(item) {
      const sameSchedule = String(item && item.id ? item.id : "") === String(activeScheduleRunId || "");
      if (sameSchedule && executionProgress.active) return "running";
      const raw = String(item && item.last_status ? item.last_status : "").toLowerCase();
      if (raw === "running") return "running";
      if (raw === "ok") return "ok";
      if (raw === "error") return "error";
      if (raw === "done") return "done";
      if (raw === "busy") return "running";
      return "";
    }

    async function refreshScheduleList(resetPage = false) {
      try {
        const res = await fetch("/api/schedules");
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || "读取调度失败");
        const items = Array.isArray(data.items) ? data.items : [];
        items.sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0));
        scheduleListState.items = items;
        if (resetPage) scheduleListState.page = 1;
        const total = scheduleListState.items.length;
        const maxPage = Math.max(1, Math.ceil(total / scheduleListState.pageSize));
        if (scheduleListState.page > maxPage) scheduleListState.page = maxPage;
        renderScheduleList();
        if (schedulerRunning) {
          await refreshRuntimeStatus(true);
          return;
        }
        const latestDone = items.find((x) => {
          if (!x) return false;
          const latestPath = String(x.last_report_path || "").trim();
          if (!latestPath) return false;
          if (Number(x.last_run_at || 0) <= 0) return false;
          const st = String(x.last_status || "").toLowerCase();
          return st !== "running";
        });
        if (latestDone && allowAutoLoadScheduleOutcome) {
          const latestPath = String(latestDone.last_report_path || "").trim();
          const latestRunId = String(latestDone.last_run_id || "").trim();
          const latestKey = buildScheduleOutcomeKey(latestDone);
          if (latestPath && latestKey && latestKey !== lastAutoLoadedScheduleOutcomeKey) {
            lastAutoLoadedScheduleOutcomeKey = latestKey;
            lastAutoLoadedScheduleReportPath = latestPath;
            await openReportInBottomTab(latestPath, "调度执行报告", latestRunId);
          }
        }
        await refreshRuntimeStatus(true);
      } catch (err) {
        log("读取调度失败: " + err.message);
        setStatus("读取调度失败");
      }
    }

    async function refreshLatestScheduleOutcome(silent = true) {
      try {
        if (!allowAutoLoadScheduleOutcome) return;
        const res = await fetch("/api/schedules");
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || "读取调度失败");
        if (schedulerRunning) return;
        const items = Array.isArray(data.items) ? data.items.slice() : [];
        items.sort((a, b) => Number(b.last_run_at || 0) - Number(a.last_run_at || 0));
        const latest = items.find((x) => {
          if (!x) return false;
          const p = String(x.last_report_path || "").trim();
          if (!p) return false;
          if (Number(x.last_run_at || 0) <= 0) return false;
          const st = String(x.last_status || "").toLowerCase();
          return st !== "running";
        });
        if (!latest) return;
        const latestPath = String(latest.last_report_path || "").trim();
        const latestRunId = String(latest.last_run_id || "").trim();
        const latestKey = buildScheduleOutcomeKey(latest);
        if (!latestPath || !latestKey || latestKey === lastAutoLoadedScheduleOutcomeKey) return;
        lastAutoLoadedScheduleOutcomeKey = latestKey;
        lastAutoLoadedScheduleReportPath = latestPath;
        await openReportInBottomTab(latestPath, "调度执行报告", latestRunId);
      } catch (err) {
        if (!silent) {
          log("刷新调度执行结果失败: " + err.message);
        }
      }
    }

    function renderScheduleList() {
      const body = document.getElementById("schedule-list-body");
      const summary = document.getElementById("schedule-list-summary");
      const pageInfo = document.getElementById("schedule-list-page-info");
      const prevBtn = document.getElementById("schedule-page-prev-btn");
      const nextBtn = document.getElementById("schedule-page-next-btn");
      if (!body || !summary || !pageInfo || !prevBtn || !nextBtn) return;

      const total = scheduleListState.items.length;
      const maxPage = Math.max(1, Math.ceil(total / scheduleListState.pageSize));
      const page = Math.max(1, Math.min(maxPage, scheduleListState.page));
      scheduleListState.page = page;
      summary.textContent = `共 ${total} 条调度任务`;
      pageInfo.textContent = `${page} / ${maxPage}`;
      prevBtn.disabled = page <= 1;
      nextBtn.disabled = page >= maxPage;

      body.innerHTML = "";
      if (!total) {
        body.innerHTML = '<div class="workflow-empty">当前没有调度任务</div>';
        return;
      }

      const startIdx = (page - 1) * scheduleListState.pageSize;
      const pageItems = scheduleListState.items.slice(startIdx, startIdx + scheduleListState.pageSize);
      for (const item of pageItems) {
        const wrap = document.createElement("div");
        wrap.className = "schedule-item";
        const isActiveSchedule = String(item.id || "") === String(activeScheduleRunId || "");
        if (isActiveSchedule && schedulerRunning) {
          wrap.classList.add("running-active");
        }

        const top = document.createElement("div");
        top.className = "schedule-item-top";
        const idEl = document.createElement("div");
        idEl.className = "schedule-item-id";
        const taskName = String(item.task_name || "").trim() || `调度任务-${String(item.id || "-")}`;
        idEl.textContent = `${taskName}  (ID: ${String(item.id || "-")})`;
        top.appendChild(idEl);
        const st = document.createElement("span");
        st.className = "schedule-status " + statusClassFromSchedule(item);
        st.textContent = statusTextFromSchedule(item);
        top.appendChild(st);
        wrap.appendChild(top);

        const grid = document.createElement("div");
        grid.className = "schedule-item-grid";
        const source = String(item.workflow_name || "工作区工作流");
        const maxRuns = Number(item.max_runs || 0);
        const runCount = Number(item.run_count || 0);
        const batchText = maxRuns > 0 ? `${runCount}/${maxRuns}` : `${runCount}/无限`;
        const exportDirs = getScheduleExportDirs(item);
        const exportDirText = exportDirs.length > 1 ? `${exportDirs[0]}（另有 ${exportDirs.length - 1} 个）` : (exportDirs[0] || "-");
        const details = [
          ["工作流", source],
          ["间隔", `${Number(item.interval_sec || 0)} 秒`],
          ["批次", batchText],
          ["导出目录", exportDirText],
          ["下次执行", formatEpochTime(item.next_run_at)],
          ["上次执行", formatEpochTime(item.last_run_at)]
        ];
        for (const [k, v] of details) {
          const row = document.createElement("div");
          const key = document.createElement("span");
          key.className = "k";
          key.textContent = `${k}:`;
          const val = document.createElement("span");
          val.textContent = String(v);
          row.appendChild(key);
          row.appendChild(val);
          grid.appendChild(row);
        }
        wrap.appendChild(grid);

        if (item.last_error) {
          const err = document.createElement("div");
          err.style.color = "#ffbcbc";
          err.style.fontSize = "12px";
          err.textContent = `错误: ${String(item.last_error)}`;
          wrap.appendChild(err);
        }

        const actions = document.createElement("div");
        actions.className = "schedule-item-actions";
        const isRunning =
          String(item.id || "") === String(activeScheduleRunId || "") ||
          String(item.last_status || "").toLowerCase() === "running";
        const startBtn = document.createElement("button");
        startBtn.textContent = isRunning ? "执行中..." : "开始";
        startBtn.disabled = isRunning || schedulerRunning;
        startBtn.addEventListener("click", async () => {
          await runScheduleNow(String(item.id || ""));
        });
        actions.appendChild(startBtn);

        const reportBtn = document.createElement("button");
        reportBtn.textContent = "执行报告";
        reportBtn.disabled = !item.last_report_path;
        reportBtn.addEventListener("click", async () => {
          await openScheduleReport(
            String(item.last_report_path || ""),
            String(item.last_run_id || "")
          );
        });
        actions.appendChild(reportBtn);

        const openPathBtn = document.createElement("button");
        openPathBtn.textContent = "打开报告位置";
        openPathBtn.disabled = !item.last_report_path;
        openPathBtn.addEventListener("click", async () => {
          await openPathInFileManager(String(item.last_report_path || ""));
        });
        actions.appendChild(openPathBtn);

        const openExportBtn = document.createElement("button");
        openExportBtn.textContent = "打开导出文件夹";
        openExportBtn.disabled = !exportDirs.length;
        openExportBtn.addEventListener("click", async () => {
          if (!exportDirs.length) return;
          await openPathInFileManager(exportDirs[0]);
          if (exportDirs.length > 1) {
            setStatus(`已打开第 1 个导出目录，共 ${exportDirs.length} 个`);
          } else {
            setStatus("已打开导出目录");
          }
        });
        actions.appendChild(openExportBtn);

        const deleteBtn = document.createElement("button");
        deleteBtn.textContent = "删除";
        deleteBtn.className = "warn";
        deleteBtn.addEventListener("click", async () => {
          await deleteScheduleItem(String(item.id || ""));
        });
        actions.appendChild(deleteBtn);

        wrap.appendChild(actions);
        body.appendChild(wrap);
      }
    }

    async function runScheduleNow(scheduleId) {
      if (!scheduleId) return;
      if (activeScheduleRunId && String(activeScheduleRunId) !== String(scheduleId)) {
        setStatus("已有调度任务执行中，请等待当前任务完成");
        return;
      }
      const scheduleItem = (scheduleListState.items || []).find((x) => String((x && x.id) || "") === String(scheduleId));
      const scheduleWorkflow = scheduleItem && scheduleItem.workflow_data && typeof scheduleItem.workflow_data === "object"
        ? scheduleItem.workflow_data
        : null;
      if (!scheduleWorkflow || Array.isArray(scheduleWorkflow) || !Object.keys(scheduleWorkflow).length) {
        setStatus("调度工作流为空，无法执行");
        return;
      }
      try {
        allowAutoLoadScheduleOutcome = true;
        importWorkflowToCanvas(scheduleWorkflow, false);
        log(`已加载调度工作流到画布: ${String(scheduleId)}`);
        activeScheduleRunId = String(scheduleId);
        if (scheduleItem) {
          scheduleItem.run_count = 0;
          scheduleItem.last_run_at = 0;
          scheduleItem.last_status = "running";
          scheduleItem.last_error = "";
          scheduleItem.last_report_path = "";
          scheduleItem.last_run_id = "";
          renderScheduleList();
        }
        schedulerRunning = true;
        ensureRunResultHandler();
        if (_runResultHandler && _runResultHandler.handleScheduleRunStart) {
          _runResultHandler.handleScheduleRunStart(scheduleId, scheduleWorkflow);
        } else {
          updateRunButtonState();
          switchBottomTab("report");
          clearReportPanel("执行报告：调度正在执行...");
          clearTimelinePanel("运行回放：调度正在执行...");
          clearPreviewTable("结果预览：调度执行中...");
          log(`开始执行调度任务: ${String(scheduleId)}`);
          clearPreviewImagesOnNodes();
          resetNodeProgressHighlight();
          startExecutionProgress(scheduleWorkflow);
        }
        const data = await runScheduleWorkflowStream(scheduleId);
        ensureRunResultHandler();
        if (_runResultHandler && _runResultHandler.handleScheduleRunSuccess) {
          await _runResultHandler.handleScheduleRunSuccess(data);
        } else {
          log("调度执行完成。输出节点: " + Object.keys(data.outputs || {}).join(", "));
          if (data.report_path) {
            log(`调度执行报告: ${data.report_path}`);
            currentRunId = String(data.run_id || "");
            currentReportPath = String(data.report_path || "");
            await openReportInBottomTab(currentReportPath, "调度执行报告", currentRunId);
          }
          await applyOutputsToWorkspace(data.outputs || {});
          setStatus("调度执行完成");
        }
        await refreshScheduleList(false);
        await refreshRuntimeStatus(true);
      } catch (err) {
        ensureRunResultHandler();
        if (_runResultHandler && _runResultHandler.handleScheduleRunFailure) {
          _runResultHandler.handleScheduleRunFailure(err, cancelRequestedByUser);
        } else {
          const msg = err && err.message ? String(err.message) : String(err);
          if (msg.includes("已取消") || cancelRequestedByUser) {
            log("调度任务已停止");
            clearPreviewTable("结果预览：调度已停止");
            setStatus("调度已停止");
          } else {
            log("调度执行失败: " + msg);
            clearPreviewTable("结果预览：调度执行失败");
            setStatus("调度执行失败");
          }
        }
        cancelRequestedByUser = false;
        await refreshScheduleList(false);
        await refreshRuntimeStatus(true);
      } finally {
        activeScheduleRunId = "";
        stopExecutionProgress();
        resetNodeProgressHighlight();
      }
    }

    async function runScheduleWorkflowStream(scheduleId) {
      const controller = new AbortController();
      scheduleRunStreamAbortController = controller;
      try {
        let res;
        try {
          res = await fetch("/api/schedules/run-now-stream", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: scheduleId }),
            signal: controller.signal,
          });
        } catch (err) {
          if (err && err.name === "AbortError") throw new Error("执行已取消");
          throw err;
        }

        if (!res.ok) {
          try {
            const data = await res.json();
            const msg = data && data.error ? String(data.error) : "";
            if (msg) throw new Error(msg);
          } catch (err) {
            if (err && err.message) throw err;
            throw new Error(`执行失败（HTTP ${res.status}）`);
          }
        }

        if (!res.body || typeof res.body.getReader !== "function") {
          throw new Error("浏览器不支持流式执行");
        }

        if (_runControl.parseNdjsonStream) {
          try {
            return await _runControl.parseNdjsonStream(res, {
              onLog: (line) => log(line),
              onEvent: (evt) => handleRunEventMessage(evt),
            });
          } catch (err) {
            if (controller.signal.aborted || (err && err.name === "AbortError")) {
              throw new Error("执行已取消");
            }
            throw err;
          }
        }
        throw new Error("运行模块未加载");
      } finally {
        if (scheduleRunStreamAbortController === controller) {
          scheduleRunStreamAbortController = null;
        }
      }
    }

    async function deleteScheduleItem(scheduleId) {
      if (!scheduleId) return;
      const yes = window.confirm("确认删除该调度任务吗？");
      if (!yes) return;
      try {
        const res = await fetch(`/api/schedules/${encodeURIComponent(scheduleId)}`, { method: "DELETE" });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || "删除失败");
        setStatus("调度任务已删除");
        await refreshScheduleList(false);
      } catch (err) {
        log("删除调度任务失败: " + err.message);
        setStatus("删除调度任务失败");
      }
    }

    async function openPathInFileManager(path) {
      if (!path) return;
      try {
        const res = await fetch("/api/open-location", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path })
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || "打开失败");
      } catch (err) {
        log("打开路径失败: " + err.message);
        setStatus("打开路径失败");
      }
    }

    async function openScheduleReport(path, runId = "") {
      if (!path) return;
      currentScheduleReportPath = String(path || "");
      await openReportInBottomTab(path, "调度执行报告", String(runId || ""));
      setStatus("已打开调度执行报告");
    }

    function closeScheduleReportModal() {
      currentScheduleReportPath = "";
      if (_modalController) _modalController.close("schedule-report-modal");
      else {
        const modal = document.getElementById("schedule-report-modal");
        if (modal) modal.classList.add("hidden");
      }
    }

    async function openCurrentScheduleReportLocation() {
      if (!currentScheduleReportPath) {
        setStatus("当前没有可打开的报告路径");
        return;
      }
      await openPathInFileManager(currentScheduleReportPath);
    }

    function showReportTab() {
      if (currentReportPath) {
        openReportInBottomTab(currentReportPath, "执行报告", currentRunId);
      } else {
        openReportInBottomTab("outputs/reports/manual_latest.json", "执行报告");
      }
    }

    function downloadTextAsFile(text, filename, mimeType) {
      const blob = new Blob([text], { type: mimeType || "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename || "workflow.json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 500);
    }

    function formatNowForFileName() {
      const d = new Date();
      const p2 = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
    }

    function clearLogs() {
      const box = document.getElementById("logs");
      box.textContent = "";
      scrollLogsToLatest(true);
      setStatus("日志已清空");
    }

    function toggleSidebar() {
      if (_uiLayout.toggleSidebarLayout) {
        sidebarCollapsed = _uiLayout.toggleSidebarLayout({
          sidebarCollapsed,
          layoutEl: document.getElementById("layout"),
          buttonEl: document.getElementById("toggle-sidebar-btn"),
          onStatus: setStatus,
          onAfterToggle: () => {
            setTimeout(() => {
              canvas.resize();
              fitToView(true);
            }, 50);
          },
        });
        return;
      }
      sidebarCollapsed = !sidebarCollapsed;
      const layout = document.getElementById("layout");
      const btn = document.getElementById("toggle-sidebar-btn");
      layout.classList.toggle("sidebar-collapsed", sidebarCollapsed);
      btn.innerHTML = sidebarCollapsed
        ? '<span class="btn-icon">&#9654;</span>显示节点库'
        : '<span class="btn-icon">&#9664;</span>收起节点库';
      setStatus(sidebarCollapsed ? "节点库已收起" : "节点库已展开");
      setTimeout(() => {
        canvas.resize();
        fitToView(true);
      }, 50);
    }

    function toggleBottomPanel() {
      if (_uiLayout.toggleBottomLayout) {
        bottomCollapsed = _uiLayout.toggleBottomLayout({
          bottomCollapsed,
          workspaceEl: document.getElementById("workspace"),
          logPanelEl: document.getElementById("log-panel"),
          buttonEl: document.getElementById("toggle-bottom-btn"),
          onStatus: setStatus,
          onAfterToggle: () => {
            setTimeout(() => {
              canvas.resize();
              fitToView(true);
              if (!bottomCollapsed && activeBottomTab === "logs") {
                scrollLogsToLatest(true);
              }
            }, 50);
          },
        });
        return;
      }
      bottomCollapsed = !bottomCollapsed;
      const workspace = document.getElementById("workspace");
      const logPanel = document.getElementById("log-panel");
      const btn = document.getElementById("toggle-bottom-btn");
      workspace.classList.toggle("bottom-collapsed", bottomCollapsed);
      logPanel.classList.toggle("bottom-collapsed", bottomCollapsed);
      btn.innerHTML = bottomCollapsed
        ? '<span class="btn-icon">&#9650;</span>显示面板'
        : '<span class="btn-icon">&#9660;</span>收起面板';
      setStatus(bottomCollapsed ? "底部面板已收起" : "底部面板已显示");
      setTimeout(() => {
        canvas.resize();
        fitToView(true);
        if (!bottomCollapsed && activeBottomTab === "logs") {
          scrollLogsToLatest(true);
        }
      }, 50);
    }

    function switchBottomTab(tab) {
      if (_nodePanel.switchBottomTab) {
        activeBottomTab = _nodePanel.switchBottomTab(tab, activeBottomTab, {
          onStatus: setStatus,
          onLogsVisible: () => scrollLogsToLatest(true),
        });
        return;
      }
      if (tab === "preview") activeBottomTab = "preview";
      else if (tab === "report") activeBottomTab = "report";
      else if (tab === "timeline") activeBottomTab = "timeline";
      else activeBottomTab = "logs";
      const logs = document.getElementById("logs");
      const preview = document.getElementById("preview-panel");
      const report = document.getElementById("report-panel");
      const timeline = document.getElementById("timeline-panel");
      const tabLogBtn = document.getElementById("tab-log-btn");
      const tabPreviewBtn = document.getElementById("tab-preview-btn");
      const tabReportBtn = document.getElementById("tab-report-btn");
      const tabTimelineBtn = document.getElementById("tab-timeline-btn");
      const clearBtn = document.getElementById("clear-log-btn");

      const onLogs = activeBottomTab === "logs";
      const onPreview = activeBottomTab === "preview";
      const onReport = activeBottomTab === "report";
      const onTimeline = activeBottomTab === "timeline";
      logs.classList.toggle("hidden", !onLogs);
      preview.classList.toggle("hidden", !onPreview);
      if (report) report.classList.toggle("hidden", !onReport);
      if (timeline) timeline.classList.toggle("hidden", !onTimeline);
      tabLogBtn.classList.toggle("active", onLogs);
      tabPreviewBtn.classList.toggle("active", onPreview);
      if (tabReportBtn) tabReportBtn.classList.toggle("active", onReport);
      if (tabTimelineBtn) tabTimelineBtn.classList.toggle("active", onTimeline);
      clearBtn.classList.toggle("hidden", !onLogs);
      if (onLogs) {
        scrollLogsToLatest(true);
      }
      if (onLogs) setStatus("已切换到执行日志");
      else if (onPreview) setStatus("已切换到结果预览");
      else if (onReport) setStatus("已切换到执行报告");
      else setStatus("已切换到运行回放");
    }

    function normalizeRegionsText(value) {
      ensureNodeEditorControllers();
      if (_ocrRegionEditorController && _ocrRegionEditorController.normalizeRegionsText) {
        return _ocrRegionEditorController.normalizeRegionsText(value);
      }
      if (typeof value === "string") return value;
      try {
        return JSON.stringify(value || [], null, 2);
      } catch (_err) {
        return "";
      }
    }

    function parseFlexibleRegionsJson(text) {
      const raw = String(text || "").trim();
      if (!raw) return [];
      try {
        return JSON.parse(raw);
      } catch (_jsonErr) {
        const normalized = raw
          .replace(/，/g, ",")
          .replace(/：/g, ":")
          .replace(/'/g, "\"")
          .replace(/,\s*([}\]])/g, "$1");
        return JSON.parse(normalized);
      }
    }

    function buildRegionsPreview(value) {
      ensureNodeEditorControllers();
      if (_ocrRegionEditorController && _ocrRegionEditorController.buildRegionsPreview) {
        return _ocrRegionEditorController.buildRegionsPreview(value);
      }
      const raw = normalizeRegionsText(value).trim();
      if (!raw) return "未配置";
      const lines = raw.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
      if (!lines.length) return "未配置";
      if (lines.length === 1) return lines[0].slice(0, 24);
      return `${lines[0].slice(0, 20)} ... (${lines.length} 行)`;
    }

    function syncOcrRegionsPreview(node) {
      ensureNodeEditorControllers();
      if (_ocrRegionEditorController && _ocrRegionEditorController.syncOcrRegionsPreview) {
        _ocrRegionEditorController.syncOcrRegionsPreview(node);
        return;
      }
      if (!node || !node.__regionsPreviewWidget) return;
      node.__regionsPreviewWidget.value = buildRegionsPreview(node.properties.regions);
      markCanvasDirty();
    }

    function normalizeDedupKeysValue(value) {
      ensureNodeEditorControllers();
      if (_dedupKeysEditorController && _dedupKeysEditorController.normalizeDedupKeysValue) {
        return _dedupKeysEditorController.normalizeDedupKeysValue(value);
      }
      if (Array.isArray(value)) {
        const arr = value.map((x) => String(x || "").trim()).filter(Boolean);
        return arr.length ? Array.from(new Set(arr)) : ["图片"];
      }
      if (typeof value === "string") {
        const arr = value.split(",").map((x) => x.trim()).filter(Boolean);
        return arr.length ? Array.from(new Set(arr)) : ["图片"];
      }
      return ["图片"];
    }

    function buildDedupKeysPreview(value) {
      ensureNodeEditorControllers();
      if (_dedupKeysEditorController && _dedupKeysEditorController.buildDedupKeysPreview) {
        return _dedupKeysEditorController.buildDedupKeysPreview(value);
      }
      const keys = normalizeDedupKeysValue(value);
      const text = keys.join(", ");
      if (text.length <= 30) return text;
      return text.slice(0, 30) + "...";
    }

    function normalizeInvalidDataKeyValue(value) {
      ensureNodeEditorControllers();
      if (_dedupKeysEditorController && _dedupKeysEditorController.normalizeInvalidDataKeyValue) {
        return _dedupKeysEditorController.normalizeInvalidDataKeyValue(value);
      }
      return String(value || "").trim();
    }

    function buildInvalidDataKeyPreview(value) {
      ensureNodeEditorControllers();
      if (_dedupKeysEditorController && _dedupKeysEditorController.buildInvalidDataKeyPreview) {
        return _dedupKeysEditorController.buildInvalidDataKeyPreview(value);
      }
      const key = normalizeInvalidDataKeyValue(value);
      return key || "未设置";
    }

    function syncExportDedupPreview(node) {
      ensureNodeEditorControllers();
      if (_dedupKeysEditorController && _dedupKeysEditorController.syncExportDedupPreview) {
        _dedupKeysEditorController.syncExportDedupPreview(node);
        return;
      }
      if (!node) return;
      node.properties.dedup_keys = normalizeDedupKeysValue(node.properties.dedup_keys);
      if (!node.__dedupPreviewWidget) return;
      node.__dedupPreviewWidget.value = buildDedupKeysPreview(node.properties.dedup_keys);
      markCanvasDirty();
    }

    function syncExportInvalidDataKeyPreview(node) {
      ensureNodeEditorControllers();
      if (_dedupKeysEditorController && _dedupKeysEditorController.syncExportInvalidDataKeyPreview) {
        _dedupKeysEditorController.syncExportInvalidDataKeyPreview(node);
        return;
      }
      if (!node) return;
      node.properties.invalid_data_key = normalizeInvalidDataKeyValue(node.properties.invalid_data_key);
      if (!node.__invalidDataKeyPreviewWidget) return;
      node.__invalidDataKeyPreviewWidget.value = buildInvalidDataKeyPreview(node.properties.invalid_data_key);
      markCanvasDirty();
    }

    function parseRegionNamesFromNode(node) {
      if (!node || CLASS_MAP[node.type] !== "EasyOCR") return [];
      ensureNodeEditorControllers();
      if (_ocrRegionEditorController && _ocrRegionEditorController.parseRegionNamesFromRaw) {
        return _ocrRegionEditorController.parseRegionNamesFromRaw(node.properties ? node.properties.regions : "");
      }
      const raw = node.properties ? node.properties.regions : "";
      let parsed = [];
      if (Array.isArray(raw)) {
        parsed = raw;
      } else if (typeof raw === "string" && raw.trim()) {
        try {
          const x = JSON.parse(raw);
          if (Array.isArray(x)) parsed = x;
        } catch (_err) {
          parsed = [];
        }
      }
      const names = [];
      const used = new Set();
      for (const item of parsed) {
        if (!item || typeof item !== "object") continue;
        const name = String(item.name || "").trim();
        if (!name || used.has(name)) continue;
        used.add(name);
        names.push(name);
      }
      return names;
    }

    function getInputNodeSafe(node, slot = 0) {
      if (!node) return null;
      if (typeof node.getInputNode === "function") {
        const inputNode = node.getInputNode(slot);
        if (inputNode) return inputNode;
      }
      const inputs = node.inputs || [];
      const linkId = inputs[slot] ? inputs[slot].link : null;
      if (linkId == null) return null;
      const links = graph && graph.links ? graph.links : null;
      if (!links) return null;
      const lk = links[linkId];
      if (!lk) return null;
      const originId = Array.isArray(lk) ? lk[1] : (lk.origin_id != null ? lk.origin_id : lk[1]);
      if (!Number.isFinite(Number(originId))) return null;
      return graph.getNodeById(Number(originId));
    }

    function findUpstreamOcrNode(startNode) {
      if (!startNode) return null;
      const visited = new Set();
      const queue = [startNode];
      while (queue.length) {
        const node = queue.shift();
        if (!node) continue;
        const nid = Number(node.id);
        if (visited.has(nid)) continue;
        visited.add(nid);
        if (CLASS_MAP[node.type] === "EasyOCR") return node;
        const prev = getInputNodeSafe(node, 0);
        if (prev) queue.push(prev);
      }
      return null;
    }

    function collectDedupCandidateKeys(exportNode) {
      const base = ["图片"];
      const ocrNode = findUpstreamOcrNode(exportNode);
      const regionNames = parseRegionNamesFromNode(ocrNode);
      const selected = normalizeDedupKeysValue(exportNode && exportNode.properties ? exportNode.properties.dedup_keys : []);
      const all = [...base, ...regionNames, ...selected];
      const used = new Set();
      const result = [];
      for (const k of all) {
        const key = String(k || "").trim();
        if (!key || used.has(key)) continue;
        used.add(key);
        result.push(key);
      }
      return result;
    }

    function openDedupKeysEditor(node) {
      ensureNodeEditorControllers();
      if (_dedupKeysEditorController && _dedupKeysEditorController.openEditor) {
        _dedupKeysEditorController.openEditor(node);
        return;
      }
      currentEditingExportNode = node;
      const modal = document.getElementById("dedup-keys-modal");
      const listEl = document.getElementById("dedup-keys-list");
      if (!modal || !listEl) return;
      const candidates = collectDedupCandidateKeys(node);
      const selected = new Set(normalizeDedupKeysValue(node && node.properties ? node.properties.dedup_keys : []));
      listEl.innerHTML = "";
      for (const key of candidates) {
        const row = document.createElement("label");
        row.className = "dedup-key-row";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.value = key;
        cb.checked = selected.has(key);
        const span = document.createElement("span");
        span.textContent = key;
        row.appendChild(cb);
        row.appendChild(span);
        listEl.appendChild(row);
      }
      modal.classList.remove("hidden");
    }

    function closeDedupKeysEditor() {
      ensureNodeEditorControllers();
      if (_dedupKeysEditorController && _dedupKeysEditorController.closeEditor) {
        _dedupKeysEditorController.closeEditor();
        return;
      }
      currentEditingExportNode = null;
      const modal = document.getElementById("dedup-keys-modal");
      if (modal) modal.classList.add("hidden");
    }

    function selectAllDedupKeys() {
      ensureNodeEditorControllers();
      if (_dedupKeysEditorController && _dedupKeysEditorController.selectAll) {
        _dedupKeysEditorController.selectAll();
        return;
      }
      const listEl = document.getElementById("dedup-keys-list");
      if (!listEl) return;
      listEl.querySelectorAll("input[type=checkbox]").forEach((el) => {
        el.checked = true;
      });
    }

    function clearDedupKeysSelection() {
      ensureNodeEditorControllers();
      if (_dedupKeysEditorController && _dedupKeysEditorController.clearSelection) {
        _dedupKeysEditorController.clearSelection();
        return;
      }
      const listEl = document.getElementById("dedup-keys-list");
      if (!listEl) return;
      listEl.querySelectorAll("input[type=checkbox]").forEach((el) => {
        el.checked = false;
      });
    }

    function saveDedupKeysEditor() {
      ensureNodeEditorControllers();
      if (_dedupKeysEditorController && _dedupKeysEditorController.saveEditor) {
        _dedupKeysEditorController.saveEditor();
        return;
      }
      if (!currentEditingExportNode) {
        closeDedupKeysEditor();
        return;
      }
      const listEl = document.getElementById("dedup-keys-list");
      if (!listEl) {
        closeDedupKeysEditor();
        return;
      }
      const keys = [];
      listEl.querySelectorAll("input[type=checkbox]").forEach((el) => {
        if (el.checked) keys.push(String(el.value || "").trim());
      });
      currentEditingExportNode.properties.dedup_keys = keys.length ? keys : ["图片"];
      syncExportDedupPreview(currentEditingExportNode);
      setStatus(`去重键已更新: ${currentEditingExportNode.properties.dedup_keys.join(", ")}`);
      closeDedupKeysEditor();
    }

    function openInvalidDataKeyEditor(node) {
      ensureNodeEditorControllers();
      if (_dedupKeysEditorController && _dedupKeysEditorController.openInvalidDataKeyEditor) {
        _dedupKeysEditorController.openInvalidDataKeyEditor(node);
        return;
      }
      currentEditingExportNode = node;
      const modal = document.getElementById("invalid-data-key-modal");
      const listEl = document.getElementById("invalid-data-key-list");
      if (!modal || !listEl) return;
      const ocrNode = findUpstreamOcrNode(node);
      const candidates = parseRegionNamesFromNode(ocrNode);
      const selected = normalizeInvalidDataKeyValue(node && node.properties ? node.properties.invalid_data_key : "");
      listEl.innerHTML = "";
      if (!candidates.length) {
        listEl.innerHTML = '<div class="workflow-empty">未找到可选 OCR 区域名，请先连接并配置文字识别节点区域。</div>';
      } else {
        for (const key of candidates) {
          const row = document.createElement("label");
          row.className = "dedup-key-row";
          const rb = document.createElement("input");
          rb.type = "radio";
          rb.name = "invalid-data-key-radio";
          rb.value = key;
          rb.checked = selected === key;
          const span = document.createElement("span");
          span.textContent = key;
          row.appendChild(rb);
          row.appendChild(span);
          listEl.appendChild(row);
        }
      }
      modal.classList.remove("hidden");
    }

    function closeInvalidDataKeyEditor() {
      ensureNodeEditorControllers();
      if (_dedupKeysEditorController && _dedupKeysEditorController.closeInvalidDataKeyEditor) {
        _dedupKeysEditorController.closeInvalidDataKeyEditor();
        return;
      }
      currentEditingExportNode = null;
      const modal = document.getElementById("invalid-data-key-modal");
      if (modal) modal.classList.add("hidden");
    }

    function clearInvalidDataKeySelection() {
      ensureNodeEditorControllers();
      if (_dedupKeysEditorController && _dedupKeysEditorController.clearInvalidDataKeySelection) {
        _dedupKeysEditorController.clearInvalidDataKeySelection();
        return;
      }
      const listEl = document.getElementById("invalid-data-key-list");
      if (!listEl) return;
      listEl.querySelectorAll("input[type=radio]").forEach((el) => {
        el.checked = false;
      });
    }

    function saveInvalidDataKeyEditor() {
      ensureNodeEditorControllers();
      if (_dedupKeysEditorController && _dedupKeysEditorController.saveInvalidDataKeyEditor) {
        _dedupKeysEditorController.saveInvalidDataKeyEditor();
        return;
      }
      if (!currentEditingExportNode) {
        closeInvalidDataKeyEditor();
        return;
      }
      const listEl = document.getElementById("invalid-data-key-list");
      if (!listEl) {
        closeInvalidDataKeyEditor();
        return;
      }
      const selected = listEl.querySelector("input[type=radio]:checked");
      currentEditingExportNode.properties.invalid_data_key = selected ? String(selected.value || "").trim() : "";
      syncExportInvalidDataKeyPreview(currentEditingExportNode);
      setStatus(
        currentEditingExportNode.properties.invalid_data_key
          ? `无效数据主键已设置: ${currentEditingExportNode.properties.invalid_data_key}`
          : "无效数据主键已清空"
      );
      closeInvalidDataKeyEditor();
    }

    function openRegionsEditor(node) {
      ensureNodeEditorControllers();
      if (_ocrRegionEditorController && _ocrRegionEditorController.openEditor) {
        _ocrRegionEditorController.openEditor(node);
        return;
      }
      currentEditingOcrNode = node;
      const modal = document.getElementById("regions-modal");
      const textarea = document.getElementById("regions-textarea");
      textarea.value = normalizeRegionsText(node && node.properties ? node.properties.regions : "");
      modal.classList.remove("hidden");
      setTimeout(() => textarea.focus(), 0);
    }

    function closeRegionsEditor() {
      ensureNodeEditorControllers();
      if (_ocrRegionEditorController && _ocrRegionEditorController.closeEditor) {
        _ocrRegionEditorController.closeEditor();
        return;
      }
      closeRegionHelper();
      currentEditingOcrNode = null;
      const modal = document.getElementById("regions-modal");
      modal.classList.add("hidden");
    }

    function formatRegionsEditor() {
      ensureNodeEditorControllers();
      if (_ocrRegionEditorController && _ocrRegionEditorController.formatEditor) {
        _ocrRegionEditorController.formatEditor();
        return;
      }
      const textarea = document.getElementById("regions-textarea");
      const text = String(textarea.value || "").trim();
      if (!text) {
        textarea.value = "[]";
        return;
      }
      try {
        const parsed = parseFlexibleRegionsJson(text);
        textarea.value = JSON.stringify(parsed, null, 2);
        setStatus("识别区域配置已格式化");
      } catch (_err) {
        setStatus("识别区域配置不是合法 JSON，无法格式化");
      }
    }

    function saveRegionsEditor() {
      ensureNodeEditorControllers();
      if (_ocrRegionEditorController && _ocrRegionEditorController.saveEditor) {
        _ocrRegionEditorController.saveEditor();
        return;
      }
      if (!currentEditingOcrNode) {
        closeRegionsEditor();
        return;
      }
      const textarea = document.getElementById("regions-textarea");
      currentEditingOcrNode.properties.regions = String(textarea.value || "");
      syncOcrRegionsPreview(currentEditingOcrNode);
      setStatus("识别区域配置已保存");
      closeRegionsEditor();
    }

    function ensureRegionHelperReady() {
      if (regionHelperReady) return;
      regionHelperReady = true;
      const fileInput = document.getElementById("region-helper-file");
      const canvasEl = document.getElementById("region-helper-canvas");
      fileInput.addEventListener("change", onRegionHelperFileChange);
      canvasEl.addEventListener("mousedown", onRegionHelperMouseDown);
      canvasEl.addEventListener("mousemove", onRegionHelperMouseMove);
      window.addEventListener("mouseup", onRegionHelperMouseUp);
      window.addEventListener("resize", () => {
        const modal = document.getElementById("region-helper-modal");
        if (!modal.classList.contains("hidden")) {
          resizeRegionHelperCanvas();
          drawRegionHelperCanvas();
        }
      });
    }

    function openRegionHelper() {
      ensureNodeEditorControllers();
      if (_ocrRegionEditorController && _ocrRegionEditorController.openHelper) {
        _ocrRegionEditorController.openHelper();
        return;
      }
      ensureRegionHelperReady();
      const modal = document.getElementById("region-helper-modal");
      const textarea = document.getElementById("regions-textarea");
      modal.classList.remove("hidden");
      regionHelper.rects = parseRegionsFromText(String(textarea.value || ""));
      regionHelper.activeIndex = regionHelper.rects.length ? 0 : -1;
      updateRegionHelperImageInfo();
      renderRegionHelperList();
      resizeRegionHelperCanvas();
      drawRegionHelperCanvas();
    }

    function closeRegionHelper() {
      ensureNodeEditorControllers();
      if (_ocrRegionEditorController && _ocrRegionEditorController.closeHelper) {
        _ocrRegionEditorController.closeHelper();
        return;
      }
      const modal = document.getElementById("region-helper-modal");
      modal.classList.add("hidden");
      regionHelper.drawing = false;
      regionHelper.tempRect = null;
      drawRegionHelperCanvas();
    }

    function onRegionHelperFileChange(event) {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          regionHelper.image = img;
          regionHelper.imageName = file.name || "";
          resizeRegionHelperCanvas();
          drawRegionHelperCanvas();
          updateRegionHelperImageInfo();
          setStatus("截图已加载，可开始框选区域");
        };
        img.src = String(reader.result || "");
      };
      reader.readAsDataURL(file);
    }

    function resizeRegionHelperCanvas() {
      const canvasEl = document.getElementById("region-helper-canvas");
      if (!canvasEl) return;
      const rect = canvasEl.getBoundingClientRect();
      const nextW = Math.max(360, Math.floor(rect.width));
      const nextH = Math.max(320, Math.floor(rect.height));
      if (canvasEl.width !== nextW) canvasEl.width = nextW;
      if (canvasEl.height !== nextH) canvasEl.height = nextH;
      computeRegionHelperImageLayout();
    }

    function computeRegionHelperImageLayout() {
      const canvasEl = document.getElementById("region-helper-canvas");
      if (!canvasEl || !regionHelper.image) return;
      const pad = 12;
      const drawW = Math.max(1, canvasEl.width - pad * 2);
      const drawH = Math.max(1, canvasEl.height - pad * 2);
      const scale = Math.min(drawW / regionHelper.image.width, drawH / regionHelper.image.height);
      regionHelper.scale = Math.max(scale, 0.01);
      regionHelper.offsetX = (canvasEl.width - regionHelper.image.width * regionHelper.scale) * 0.5;
      regionHelper.offsetY = (canvasEl.height - regionHelper.image.height * regionHelper.scale) * 0.5;
    }

    function drawRegionHelperCanvas() {
      const canvasEl = document.getElementById("region-helper-canvas");
      if (!canvasEl) return;
      const ctx = canvasEl.getContext("2d");
      if (!ctx) return;

      ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
      ctx.fillStyle = "#111318";
      ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);

      if (!regionHelper.image) {
        ctx.fillStyle = "#7f8796";
        ctx.font = "13px Segoe UI";
        ctx.fillText("请先上传截图", 16, 26);
        return;
      }

      computeRegionHelperImageLayout();
      ctx.drawImage(
        regionHelper.image,
        regionHelper.offsetX,
        regionHelper.offsetY,
        regionHelper.image.width * regionHelper.scale,
        regionHelper.image.height * regionHelper.scale
      );

      for (let i = 0; i < regionHelper.rects.length; i++) {
        drawHelperRect(ctx, regionHelper.rects[i], i === regionHelper.activeIndex, i + 1);
      }
      if (regionHelper.tempRect) {
        drawHelperRect(ctx, regionHelper.tempRect, true, regionHelper.rects.length + 1, true);
      }
    }

    function drawHelperRect(ctx, rect, active, index, isTemp = false) {
      const s = regionHelper.scale;
      const dx = regionHelper.offsetX + rect.x * s;
      const dy = regionHelper.offsetY + rect.y * s;
      const dw = rect.w * s;
      const dh = rect.h * s;

      ctx.save();
      ctx.strokeStyle = active ? "#44b2ff" : "#ffc857";
      ctx.lineWidth = active ? 2 : 1.5;
      if (isTemp) ctx.setLineDash([6, 4]);
      ctx.strokeRect(dx, dy, dw, dh);
      ctx.fillStyle = active ? "rgba(68,178,255,0.16)" : "rgba(255,200,87,0.14)";
      ctx.fillRect(dx, dy, dw, dh);
      ctx.setLineDash([]);
      ctx.fillStyle = active ? "#8dd0ff" : "#ffd78a";
      ctx.font = "12px Segoe UI";
      const label = `${rect.name || "区域" + index} (${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.w)},${Math.round(rect.h)})`;
      ctx.fillText(label, dx + 4, Math.max(12, dy - 6));
      ctx.restore();
    }

    function onRegionHelperMouseDown(event) {
      if (!regionHelper.image) return;
      const p = helperCanvasToImagePoint(event);
      if (!p) return;
      regionHelper.drawing = true;
      regionHelper.startX = p.x;
      regionHelper.startY = p.y;
      regionHelper.tempRect = { name: `区域${regionHelper.rects.length + 1}`, x: p.x, y: p.y, w: 0, h: 0 };
      drawRegionHelperCanvas();
    }

    function onRegionHelperMouseMove(event) {
      if (!regionHelper.image || !regionHelper.drawing) return;
      const p = helperCanvasToImagePoint(event);
      if (!p) return;
      const x = Math.min(regionHelper.startX, p.x);
      const y = Math.min(regionHelper.startY, p.y);
      const w = Math.abs(p.x - regionHelper.startX);
      const h = Math.abs(p.y - regionHelper.startY);
      regionHelper.tempRect = {
        name: `区域${regionHelper.rects.length + 1}`,
        x: Math.round(x),
        y: Math.round(y),
        w: Math.round(w),
        h: Math.round(h)
      };
      drawRegionHelperCanvas();
    }

    function onRegionHelperMouseUp() {
      if (!regionHelper.drawing) return;
      regionHelper.drawing = false;
      const rect = regionHelper.tempRect;
      regionHelper.tempRect = null;
      if (rect && rect.w >= 2 && rect.h >= 2) {
        regionHelper.rects.push(rect);
        regionHelper.activeIndex = regionHelper.rects.length - 1;
        renderRegionHelperList();
      }
      drawRegionHelperCanvas();
    }

    function helperCanvasToImagePoint(event) {
      const canvasEl = document.getElementById("region-helper-canvas");
      if (!canvasEl || !regionHelper.image) return null;
      const rect = canvasEl.getBoundingClientRect();
      const cx = event.clientX - rect.left;
      const cy = event.clientY - rect.top;
      const x = (cx - regionHelper.offsetX) / regionHelper.scale;
      const y = (cy - regionHelper.offsetY) / regionHelper.scale;
      if (x < 0 || y < 0 || x > regionHelper.image.width || y > regionHelper.image.height) {
        return null;
      }
      return {
        x: Math.max(0, Math.min(regionHelper.image.width, x)),
        y: Math.max(0, Math.min(regionHelper.image.height, y))
      };
    }

    function renderRegionHelperList() {
      const list = document.getElementById("region-helper-list");
      if (!list) return;
      list.innerHTML = "";
      if (!regionHelper.rects.length) {
        list.innerHTML = '<div class="helper-empty">暂无区域，请先在左侧拖拽创建。</div>';
        return;
      }

      regionHelper.rects.forEach((rect, index) => {
        const item = document.createElement("div");
        item.className = "helper-item" + (index === regionHelper.activeIndex ? " active" : "");
        item.addEventListener("click", () => {
          regionHelper.activeIndex = index;
          renderRegionHelperList();
          drawRegionHelperCanvas();
        });

        const rowTop = document.createElement("div");
        rowTop.className = "helper-item-row";
        const label = document.createElement("span");
        label.textContent = `#${index + 1}`;
        rowTop.appendChild(label);
        const delBtn = document.createElement("button");
        delBtn.textContent = "删除";
        delBtn.style.height = "22px";
        delBtn.style.padding = "0 8px";
        delBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          regionHelper.rects.splice(index, 1);
          if (regionHelper.activeIndex >= regionHelper.rects.length) {
            regionHelper.activeIndex = regionHelper.rects.length - 1;
          }
          renderRegionHelperList();
          drawRegionHelperCanvas();
        });
        rowTop.appendChild(delBtn);
        item.appendChild(rowTop);

        const nameInput = document.createElement("input");
        nameInput.value = rect.name || `区域${index + 1}`;
        nameInput.addEventListener("input", () => {
          rect.name = nameInput.value;
          drawRegionHelperCanvas();
        });
        item.appendChild(nameInput);

        const info = document.createElement("div");
        info.textContent = `x:${Math.round(rect.x)} y:${Math.round(rect.y)} w:${Math.round(rect.w)} h:${Math.round(rect.h)}`;
        info.style.color = "#b7c0cf";
        item.appendChild(info);

        list.appendChild(item);
      });
    }

    function clearRegionHelperRects() {
      ensureNodeEditorControllers();
      if (_ocrRegionEditorController && _ocrRegionEditorController.clearHelperRects) {
        _ocrRegionEditorController.clearHelperRects();
        return;
      }
      regionHelper.rects = [];
      regionHelper.activeIndex = -1;
      renderRegionHelperList();
      drawRegionHelperCanvas();
      setStatus("已清空选区");
    }

    function applyRegionHelperToEditor() {
      ensureNodeEditorControllers();
      if (_ocrRegionEditorController && _ocrRegionEditorController.applyHelperToEditor) {
        _ocrRegionEditorController.applyHelperToEditor();
        return;
      }
      const textarea = document.getElementById("regions-textarea");
      if (!textarea) return;
      const payload = regionHelper.rects.map((rect, idx) => ({
        name: String(rect.name || `区域${idx + 1}`),
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.w),
        h: Math.round(rect.h)
      }));
      textarea.value = JSON.stringify(payload, null, 2);
      setStatus(`已写入 ${payload.length} 个识别区域`);
      closeRegionHelper();
    }

    function parseRegionsFromText(text) {
      if (!text || !String(text).trim()) return [];
      try {
        const parsed = parseFlexibleRegionsJson(String(text));
        if (!Array.isArray(parsed)) return [];
        const result = [];
        for (let i = 0; i < parsed.length; i++) {
          const item = parsed[i];
          if (!item || typeof item !== "object") continue;
          const x = Number(item.x);
          const y = Number(item.y);
          const w = Number(item.w);
          const h = Number(item.h);
          if (![x, y, w, h].every(Number.isFinite)) continue;
          if (w <= 0 || h <= 0) continue;
          result.push({
            name: String(item.name || `区域${i + 1}`),
            x: Math.round(x),
            y: Math.round(y),
            w: Math.round(w),
            h: Math.round(h)
          });
        }
        return result;
      } catch (_err) {
        return [];
      }
    }

    function updateRegionHelperImageInfo() {
      const el = document.getElementById("helper-image-info");
      if (!el) return;
      if (!regionHelper.image) {
        el.textContent = "请先上传截图，然后在图上拖拽框选";
        return;
      }
      el.textContent = `${regionHelper.imageName || "已上传图片"} (${regionHelper.image.width} x ${regionHelper.image.height})`;
    }

    function ensureTapPickerReady() {
      if (tapPickerReady) return;
      tapPickerReady = true;
      const fileInput = document.getElementById("tap-picker-file");
      const canvasEl = document.getElementById("tap-picker-canvas");
      if (fileInput) fileInput.addEventListener("change", onTapPickerFileChange);
      if (canvasEl) canvasEl.addEventListener("click", onTapPickerCanvasClick);
      window.addEventListener("resize", () => {
        const modal = document.getElementById("tap-picker-modal");
        if (!modal || modal.classList.contains("hidden")) return;
        resizeTapPickerCanvas();
        drawTapPickerCanvas();
      });
    }

    function openTapPicker(node) {
      ensureNodeEditorControllers();
      if (_pickerEditorController && _pickerEditorController.openTapPicker) {
        _pickerEditorController.openTapPicker(node);
        return;
      }
      ensureTapPickerReady();
      tapPicker.node = node || null;
      tapPicker.image = null;
      tapPicker.imageName = "";
      tapPicker.tempCaptureToken = "";
      tapPicker.scale = 1;
      tapPicker.offsetX = 0;
      tapPicker.offsetY = 0;
      tapPicker.selectedX = Number.isFinite(Number(node && node.properties ? node.properties.x : NaN))
        ? Math.round(Number(node.properties.x))
        : null;
      tapPicker.selectedY = Number.isFinite(Number(node && node.properties ? node.properties.y : NaN))
        ? Math.round(Number(node.properties.y))
        : null;

      const fileInput = document.getElementById("tap-picker-file");
      if (fileInput) fileInput.value = "";

      updateTapPickerImageInfo();
      updateTapPickerPointInfo();
      const modal = document.getElementById("tap-picker-modal");
      if (modal) modal.classList.remove("hidden");
      resizeTapPickerCanvas();
      drawTapPickerCanvas();
      setStatus("请上传图片或捕捉手机屏幕，然后点击目标位置获取 x,y 坐标");
    }

    async function closeTapPicker() {
      ensureNodeEditorControllers();
      if (_pickerEditorController && _pickerEditorController.closeTapPicker) {
        await _pickerEditorController.closeTapPicker();
        return;
      }
      await cleanupTapPickerCapturedImage();
      tapPicker.image = null;
      tapPicker.imageName = "";
      const modal = document.getElementById("tap-picker-modal");
      if (modal) modal.classList.add("hidden");
    }

    async function onTapPickerFileChange(event) {
      await cleanupTapPickerCapturedImage();
      const file = event.target && event.target.files ? event.target.files[0] : null;
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          tapPicker.image = img;
          tapPicker.imageName = file.name || "";
          resizeTapPickerCanvas();
          drawTapPickerCanvas();
          updateTapPickerImageInfo();
          setStatus("图片已加载，点击图片选择坐标");
        };
        img.src = String(reader.result || "");
      };
      reader.readAsDataURL(file);
    }

    function findPreferredTapPickerDeviceId() {
      const nodes = graph && graph._nodes ? graph._nodes : [];
      const startNodes = nodes.filter((n) => n && CLASS_MAP[n.type] === "StartDevice");
      for (const node of startNodes) {
        const deviceId = String((node.properties && node.properties.device_id) || "").trim();
        if (deviceId) return deviceId;
      }
      return "";
    }

    async function cleanupTapPickerCapturedImage() {
      const token = String(tapPicker.tempCaptureToken || "").trim();
      tapPicker.tempCaptureToken = "";
      if (!token) return;
      try {
        await fetch("/api/tap-picker/cleanup-screen", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token })
        });
      } catch (_err) {
      }
    }

    async function captureTapPickerScreen() {
      ensureNodeEditorControllers();
      if (_pickerEditorController && _pickerEditorController.captureTapPickerScreen) {
        await _pickerEditorController.captureTapPickerScreen();
        return;
      }
      try {
        setStatus("正在捕捉手机屏幕...");
        const deviceId = findPreferredTapPickerDeviceId();
        const res = await fetch("/api/tap-picker/capture-screen", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ device_id: deviceId })
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || "捕捉失败");

        await cleanupTapPickerCapturedImage();
        tapPicker.tempCaptureToken = String(data.token || "");

        const src = String(data.image_data_url || "");
        if (!src) throw new Error("截图数据为空");

        await new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => {
            tapPicker.image = img;
            tapPicker.imageName = String(data.image_name || "手机截图");
            resizeTapPickerCanvas();
            drawTapPickerCanvas();
            updateTapPickerImageInfo();
            resolve();
          };
          img.onerror = () => reject(new Error("截图加载失败"));
          img.src = src;
        });
        setStatus("已捕捉手机屏幕，请点击图片选择坐标");
      } catch (err) {
        log("捕捉手机屏幕失败: " + err.message);
        setStatus("捕捉手机屏幕失败");
      }
    }

    function resizeTapPickerCanvas() {
      const canvasEl = document.getElementById("tap-picker-canvas");
      if (!canvasEl) return;
      const rect = canvasEl.getBoundingClientRect();
      const nextW = Math.max(360, Math.floor(rect.width));
      const nextH = Math.max(300, Math.floor(rect.height));
      if (canvasEl.width !== nextW) canvasEl.width = nextW;
      if (canvasEl.height !== nextH) canvasEl.height = nextH;
      computeTapPickerImageLayout();
    }

    function computeTapPickerImageLayout() {
      const canvasEl = document.getElementById("tap-picker-canvas");
      if (!canvasEl || !tapPicker.image) return;
      const pad = 12;
      const drawW = Math.max(1, canvasEl.width - pad * 2);
      const drawH = Math.max(1, canvasEl.height - pad * 2);
      const scale = Math.min(drawW / tapPicker.image.width, drawH / tapPicker.image.height);
      tapPicker.scale = Math.max(scale, 0.01);
      tapPicker.offsetX = (canvasEl.width - tapPicker.image.width * tapPicker.scale) * 0.5;
      tapPicker.offsetY = (canvasEl.height - tapPicker.image.height * tapPicker.scale) * 0.5;
    }

    function drawTapPickerCanvas() {
      const canvasEl = document.getElementById("tap-picker-canvas");
      if (!canvasEl) return;
      const ctx = canvasEl.getContext("2d");
      if (!ctx) return;

      ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
      ctx.fillStyle = "#111318";
      ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);

      if (!tapPicker.image) {
        ctx.fillStyle = "#7f8796";
        ctx.font = "13px Segoe UI";
        ctx.fillText("请先上传图片", 16, 26);
        return;
      }

      computeTapPickerImageLayout();
      const drawW = tapPicker.image.width * tapPicker.scale;
      const drawH = tapPicker.image.height * tapPicker.scale;
      ctx.drawImage(tapPicker.image, tapPicker.offsetX, tapPicker.offsetY, drawW, drawH);

      if (Number.isFinite(tapPicker.selectedX) && Number.isFinite(tapPicker.selectedY)) {
        const px = tapPicker.offsetX + tapPicker.selectedX * tapPicker.scale;
        const py = tapPicker.offsetY + tapPicker.selectedY * tapPicker.scale;
        ctx.save();
        ctx.strokeStyle = "#44b2ff";
        ctx.fillStyle = "#44b2ff";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(px - 12, py);
        ctx.lineTo(px + 12, py);
        ctx.moveTo(px, py - 12);
        ctx.lineTo(px, py + 12);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(px, py, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#8dd0ff";
        ctx.font = "12px Segoe UI";
        ctx.fillText(`(${tapPicker.selectedX}, ${tapPicker.selectedY})`, px + 8, py - 8);
        ctx.restore();
      }
    }

    function tapPickerCanvasToImagePoint(event) {
      const canvasEl = document.getElementById("tap-picker-canvas");
      if (!canvasEl || !tapPicker.image) return null;
      const rect = canvasEl.getBoundingClientRect();
      const cx = event.clientX - rect.left;
      const cy = event.clientY - rect.top;
      const x = (cx - tapPicker.offsetX) / tapPicker.scale;
      const y = (cy - tapPicker.offsetY) / tapPicker.scale;
      if (x < 0 || y < 0 || x > tapPicker.image.width || y > tapPicker.image.height) {
        return null;
      }
      return {
        x: Math.max(0, Math.min(tapPicker.image.width, x)),
        y: Math.max(0, Math.min(tapPicker.image.height, y))
      };
    }

    function onTapPickerCanvasClick(event) {
      if (!tapPicker.image) return;
      const p = tapPickerCanvasToImagePoint(event);
      if (!p) {
        setStatus("请点击图片内容区域");
        return;
      }
      tapPicker.selectedX = Math.round(p.x);
      tapPicker.selectedY = Math.round(p.y);
      updateTapPickerPointInfo();
      drawTapPickerCanvas();
      setStatus(`已选取坐标 (${tapPicker.selectedX}, ${tapPicker.selectedY})`);
    }

    function updateTapPickerImageInfo() {
      const el = document.getElementById("tap-picker-image-info");
      if (!el) return;
      if (!tapPicker.image) {
        el.textContent = "请先上传本地图片";
        return;
      }
      el.textContent = `${tapPicker.imageName || "已上传图片"} (${tapPicker.image.width} x ${tapPicker.image.height})`;
    }

    function updateTapPickerPointInfo() {
      const el = document.getElementById("tap-picker-point-value");
      if (!el) return;
      if (!Number.isFinite(tapPicker.selectedX) || !Number.isFinite(tapPicker.selectedY)) {
        el.textContent = "未选择";
        return;
      }
      el.textContent = `${tapPicker.selectedX}, ${tapPicker.selectedY}`;
    }

    function applyTapPickerPoint() {
      ensureNodeEditorControllers();
      if (_pickerEditorController && _pickerEditorController.applyTapPickerPoint) {
        _pickerEditorController.applyTapPickerPoint();
        return;
      }
      if (!tapPicker.node) {
        closeTapPicker();
        return;
      }
      if (!Number.isFinite(tapPicker.selectedX) || !Number.isFinite(tapPicker.selectedY)) {
        setStatus("请先在图片上点击选点");
        return;
      }
      tapPicker.node.properties.x = Math.round(tapPicker.selectedX);
      tapPicker.node.properties.y = Math.round(tapPicker.selectedY);
      const widgets = tapPicker.node.widgets || [];
      const wx = widgets.find((w) => String(w && w.name || "") === "横坐标");
      const wy = widgets.find((w) => String(w && w.name || "") === "纵坐标");
      if (wx) wx.value = tapPicker.node.properties.x;
      else if (widgets[0]) widgets[0].value = tapPicker.node.properties.x;
      if (wy) wy.value = tapPicker.node.properties.y;
      else if (widgets[1]) widgets[1].value = tapPicker.node.properties.y;
      markCanvasDirty();
      setStatus(`已写入点击坐标 (${tapPicker.node.properties.x}, ${tapPicker.node.properties.y})`);
      closeTapPicker();
    }

    function ensureSwipePickerReady() {
      if (swipePickerReady) return;
      swipePickerReady = true;
      const fileInput = document.getElementById("swipe-picker-file");
      const canvasEl = document.getElementById("swipe-picker-canvas");
      if (fileInput) fileInput.addEventListener("change", onSwipePickerFileChange);
      if (canvasEl) canvasEl.addEventListener("click", onSwipePickerCanvasClick);
      window.addEventListener("resize", () => {
        const modal = document.getElementById("swipe-picker-modal");
        if (!modal || modal.classList.contains("hidden")) return;
        resizeSwipePickerCanvas();
        drawSwipePickerCanvas();
      });
    }

    function openSwipePicker(node) {
      ensureNodeEditorControllers();
      if (_pickerEditorController && _pickerEditorController.openSwipePicker) {
        _pickerEditorController.openSwipePicker(node);
        return;
      }
      ensureSwipePickerReady();
      swipePicker.node = node || null;
      swipePicker.image = null;
      swipePicker.imageName = "";
      swipePicker.tempCaptureToken = "";
      swipePicker.scale = 1;
      swipePicker.offsetX = 0;
      swipePicker.offsetY = 0;
      swipePicker.startX = null;
      swipePicker.startY = null;
      swipePicker.endX = null;
      swipePicker.endY = null;
      const fileInput = document.getElementById("swipe-picker-file");
      if (fileInput) fileInput.value = "";
      const modal = document.getElementById("swipe-picker-modal");
      if (modal) modal.classList.remove("hidden");
      updateSwipePickerInfo();
      resizeSwipePickerCanvas();
      drawSwipePickerCanvas();
      setStatus("请上传截图或捕捉手机屏幕，依次点击起点和终点");
    }

    async function closeSwipePicker() {
      ensureNodeEditorControllers();
      if (_pickerEditorController && _pickerEditorController.closeSwipePicker) {
        await _pickerEditorController.closeSwipePicker();
        return;
      }
      await cleanupSwipePickerCapturedImage();
      swipePicker.image = null;
      swipePicker.imageName = "";
      const modal = document.getElementById("swipe-picker-modal");
      if (modal) modal.classList.add("hidden");
    }

    async function onSwipePickerFileChange(event) {
      await cleanupSwipePickerCapturedImage();
      const file = event.target && event.target.files ? event.target.files[0] : null;
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          swipePicker.image = img;
          swipePicker.imageName = file.name || "";
          swipePicker.startX = null;
          swipePicker.startY = null;
          swipePicker.endX = null;
          swipePicker.endY = null;
          resizeSwipePickerCanvas();
          drawSwipePickerCanvas();
          updateSwipePickerInfo();
        };
        img.src = String(reader.result || "");
      };
      reader.readAsDataURL(file);
    }

    async function cleanupSwipePickerCapturedImage() {
      const token = String(swipePicker.tempCaptureToken || "").trim();
      swipePicker.tempCaptureToken = "";
      if (!token) return;
      try {
        await fetch("/api/tap-picker/cleanup-screen", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token })
        });
      } catch (_err) {
      }
    }

    async function captureSwipePickerScreen() {
      ensureNodeEditorControllers();
      if (_pickerEditorController && _pickerEditorController.captureSwipePickerScreen) {
        await _pickerEditorController.captureSwipePickerScreen();
        return;
      }
      try {
        setStatus("正在捕捉手机屏幕...");
        const deviceId = findPreferredTapPickerDeviceId();
        const res = await fetch("/api/tap-picker/capture-screen", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ device_id: deviceId })
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || "捕捉失败");

        await cleanupSwipePickerCapturedImage();
        swipePicker.tempCaptureToken = String(data.token || "");

        const src = String(data.image_data_url || "");
        if (!src) throw new Error("截图数据为空");

        await new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => {
            swipePicker.image = img;
            swipePicker.imageName = String(data.image_name || "手机截图");
            swipePicker.startX = null;
            swipePicker.startY = null;
            swipePicker.endX = null;
            swipePicker.endY = null;
            resizeSwipePickerCanvas();
            drawSwipePickerCanvas();
            updateSwipePickerInfo();
            resolve();
          };
          img.onerror = () => reject(new Error("截图加载失败"));
          img.src = src;
        });
        setStatus("已捕捉手机屏幕，请依次点击起点和终点");
      } catch (err) {
        log("捕捉手机屏幕失败: " + err.message);
        setStatus("捕捉手机屏幕失败");
      }
    }

    function resizeSwipePickerCanvas() {
      const canvasEl = document.getElementById("swipe-picker-canvas");
      if (!canvasEl) return;
      const rect = canvasEl.getBoundingClientRect();
      const nextW = Math.max(360, Math.floor(rect.width));
      const nextH = Math.max(300, Math.floor(rect.height));
      if (canvasEl.width !== nextW) canvasEl.width = nextW;
      if (canvasEl.height !== nextH) canvasEl.height = nextH;
      computeSwipePickerImageLayout();
    }

    function computeSwipePickerImageLayout() {
      const canvasEl = document.getElementById("swipe-picker-canvas");
      if (!canvasEl || !swipePicker.image) return;
      const pad = 12;
      const drawW = Math.max(1, canvasEl.width - pad * 2);
      const drawH = Math.max(1, canvasEl.height - pad * 2);
      const scale = Math.min(drawW / swipePicker.image.width, drawH / swipePicker.image.height);
      swipePicker.scale = Math.max(scale, 0.01);
      swipePicker.offsetX = (canvasEl.width - swipePicker.image.width * swipePicker.scale) * 0.5;
      swipePicker.offsetY = (canvasEl.height - swipePicker.image.height * swipePicker.scale) * 0.5;
    }

    function drawSwipePickerCanvas() {
      const canvasEl = document.getElementById("swipe-picker-canvas");
      if (!canvasEl) return;
      const ctx = canvasEl.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
      ctx.fillStyle = "#111318";
      ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);
      if (!swipePicker.image) {
        ctx.fillStyle = "#7f8796";
        ctx.font = "13px Segoe UI";
        ctx.fillText("请先上传截图", 16, 26);
        return;
      }
      computeSwipePickerImageLayout();
      const drawW = swipePicker.image.width * swipePicker.scale;
      const drawH = swipePicker.image.height * swipePicker.scale;
      ctx.drawImage(swipePicker.image, swipePicker.offsetX, swipePicker.offsetY, drawW, drawH);

      const drawPoint = (x, y, color, label) => {
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        const px = swipePicker.offsetX + x * swipePicker.scale;
        const py = swipePicker.offsetY + y * swipePicker.scale;
        ctx.save();
        ctx.fillStyle = color;
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.arc(px, py, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.font = "12px Segoe UI";
        ctx.fillText(label, px + 8, py - 8);
        ctx.restore();
      };

      if (Number.isFinite(swipePicker.startX) && Number.isFinite(swipePicker.startY) &&
          Number.isFinite(swipePicker.endX) && Number.isFinite(swipePicker.endY)) {
        const sx = swipePicker.offsetX + swipePicker.startX * swipePicker.scale;
        const sy = swipePicker.offsetY + swipePicker.startY * swipePicker.scale;
        const ex = swipePicker.offsetX + swipePicker.endX * swipePicker.scale;
        const ey = swipePicker.offsetY + swipePicker.endY * swipePicker.scale;
        ctx.save();
        ctx.strokeStyle = "#ffd166";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(ex, ey);
        ctx.stroke();
        ctx.restore();
      }
      drawPoint(swipePicker.startX, swipePicker.startY, "#44b2ff", "起点");
      drawPoint(swipePicker.endX, swipePicker.endY, "#ff8a65", "终点");
    }

    function swipePickerCanvasToImagePoint(event) {
      const canvasEl = document.getElementById("swipe-picker-canvas");
      if (!canvasEl || !swipePicker.image) return null;
      const rect = canvasEl.getBoundingClientRect();
      const cx = event.clientX - rect.left;
      const cy = event.clientY - rect.top;
      const x = (cx - swipePicker.offsetX) / swipePicker.scale;
      const y = (cy - swipePicker.offsetY) / swipePicker.scale;
      if (x < 0 || y < 0 || x > swipePicker.image.width || y > swipePicker.image.height) return null;
      return { x: Math.round(x), y: Math.round(y) };
    }

    function onSwipePickerCanvasClick(event) {
      const p = swipePickerCanvasToImagePoint(event);
      if (!p) return;
      if (!Number.isFinite(swipePicker.startX) || !Number.isFinite(swipePicker.startY)) {
        swipePicker.startX = p.x;
        swipePicker.startY = p.y;
      } else {
        swipePicker.endX = p.x;
        swipePicker.endY = p.y;
      }
      updateSwipePickerInfo();
      drawSwipePickerCanvas();
    }

    function resetSwipePickerPoints() {
      ensureNodeEditorControllers();
      if (_pickerEditorController && _pickerEditorController.resetSwipePickerPoints) {
        _pickerEditorController.resetSwipePickerPoints();
        return;
      }
      swipePicker.startX = null;
      swipePicker.startY = null;
      swipePicker.endX = null;
      swipePicker.endY = null;
      updateSwipePickerInfo();
      drawSwipePickerCanvas();
    }

    function updateSwipePickerInfo() {
      const info = document.getElementById("swipe-picker-info");
      if (!info) return;
      const s = Number.isFinite(swipePicker.startX) ? `${swipePicker.startX},${swipePicker.startY}` : "未设置";
      const e = Number.isFinite(swipePicker.endX) ? `${swipePicker.endX},${swipePicker.endY}` : "未设置";
      info.textContent = `起点: ${s} | 终点: ${e}`;
    }

    function applySwipePickerPoints() {
      ensureNodeEditorControllers();
      if (_pickerEditorController && _pickerEditorController.applySwipePickerPoints) {
        _pickerEditorController.applySwipePickerPoints();
        return;
      }
      if (!swipePicker.node) return;
      if (!Number.isFinite(swipePicker.startX) || !Number.isFinite(swipePicker.startY) ||
          !Number.isFinite(swipePicker.endX) || !Number.isFinite(swipePicker.endY)) {
        setStatus("请先选择起点和终点");
        return;
      }
      const dx = swipePicker.endX - swipePicker.startX;
      const dy = swipePicker.endY - swipePicker.startY;
      const direction = dy >= 0 ? "down" : "up";
      const distancePx = Math.max(1, Math.round(Math.abs(dy)));
      const widgets = swipePicker.node.widgets || [];
      swipePicker.node.properties.direction = direction;
      swipePicker.node.properties.distance_px = distancePx;
      swipePicker.node.properties.x = swipePicker.startX;
      swipePicker.node.properties.y = swipePicker.startY;
      const wDirection = widgets.find((w) => String(w && w.name || "") === "滑动方向");
      const wDistance = widgets.find((w) => String(w && w.name || "") === "滑动像素");
      const wX = widgets.find((w) => String(w && w.name || "") === "起点X(可选)");
      const wY = widgets.find((w) => String(w && w.name || "") === "起点Y(可选)");
      if (wDirection) wDirection.value = directionValueToLabel(direction);
      else if (widgets[0]) widgets[0].value = directionValueToLabel(direction);
      if (wDistance) wDistance.value = distancePx;
      else if (widgets[2]) widgets[2].value = distancePx;
      if (wX) wX.value = String(swipePicker.startX);
      if (wY) wY.value = String(swipePicker.startY);
      markCanvasDirty();
      setStatus(`已写入滑动配置：方向=${directionValueToLabel(direction)}，像素=${distancePx}`);
      closeSwipePicker();
    }

    function isTypingInTextField(target) {
      if (!target) return false;
      const tag = String(target.tagName || "").toUpperCase();
      if (target.isContentEditable) return true;
      if (tag === "TEXTAREA") return true;
      if (tag !== "INPUT") return false;
      const type = String(target.type || "text").toLowerCase();
      return type !== "checkbox" && type !== "radio" && type !== "button" && type !== "submit";
    }

    function getSelectedPreviewImageNode() {
      const selectedMap = canvas && canvas.selected_nodes ? canvas.selected_nodes : null;
      if (!selectedMap) return null;
      for (const node of Object.values(selectedMap)) {
        if (node && CLASS_MAP[node.type] === "PreviewImages") return node;
      }
      return null;
    }

    function getPreviewImageNodeById(nodeId) {
      if (!Number.isFinite(Number(nodeId))) return null;
      const node = graph.getNodeById(Number(nodeId));
      if (!node || CLASS_MAP[node.type] !== "PreviewImages") return null;
      return node;
    }

    function updateImageLightbox(node) {
      const modal = document.getElementById("image-lightbox-modal");
      const meta = document.getElementById("image-lightbox-meta");
      const imageEl = document.getElementById("image-lightbox-image");
      if (!modal || !meta || !imageEl) return;

      if (!node || !node._previewImages || !node._previewImages.length || node._previewIndex < 0) {
        closeImageLightbox();
        return;
      }

      const idx = Number(node._previewIndex);
      const item = node._previewImages[idx] || {};
      const name = String(item.name || node._previewName || "");
      const total = node._previewImages.length;
      const overall = Number(node._previewTotal || total);
      meta.textContent = `图片预览 ${idx + 1}/${total}（总数 ${overall}） ${name ? "- " + name : ""}`;
      imageEl.src = String(item.data_url || "");
      imageEl.alt = name || "图片预览";
    }

    function syncImageLightboxFromNode(node) {
      if (!node) return;
      if (Number(imageLightboxState.nodeId) !== Number(node.id)) return;
      const modal = document.getElementById("image-lightbox-modal");
      if (!modal || modal.classList.contains("hidden")) return;
      updateImageLightbox(node);
    }

    function openImageLightbox(node) {
      if (!node || CLASS_MAP[node.type] !== "PreviewImages") return;
      if (!node._previewImages || !node._previewImages.length || node._previewIndex < 0) return;
      imageLightboxState.nodeId = Number(node.id);
      const modal = document.getElementById("image-lightbox-modal");
      if (!modal) return;
      modal.classList.remove("hidden");
      updateImageLightbox(node);
    }

    function closeImageLightbox() {
      const modal = document.getElementById("image-lightbox-modal");
      const imageEl = document.getElementById("image-lightbox-image");
      if (modal) modal.classList.add("hidden");
      if (imageEl) imageEl.src = "";
      imageLightboxState.nodeId = null;
    }

    function clearPreviewImagesOnNodes() {
      const nodes = graph._nodes || [];
      for (const node of nodes) {
        if (!node || CLASS_MAP[node.type] !== "PreviewImages") continue;
        const inputLinked = !!(node.inputs && node.inputs[0] && node.inputs[0].link != null);
        if (inputLinked) {
          node.properties = node.properties || {};
          node.properties.folder_dir = "";
          const widgets = node.widgets || [];
          if (widgets[0]) widgets[0].value = "";
        }
        if (typeof node.clearPreview === "function") node.clearPreview();
      }
      markCanvasDirty();
    }

    async function applyPreviewImagesToNodes(outputs) {
      const entries = Object.entries(outputs || {});
      for (const [nodeId, payload] of entries) {
        if (!payload || typeof payload !== "object" || !Array.isArray(payload.preview_images)) continue;
        const node = graph.getNodeById(Number(nodeId));
        if (!node) continue;
        if (CLASS_MAP[node.type] !== "PreviewImages") continue;
        const images = Array.isArray(payload.preview_images) ? payload.preview_images : [];
        const shouldHydrateThumb = images.some((it) => it && typeof it === "object" && !it.data_url && it.path);
        if (shouldHydrateThumb && _reportController.readImageThumb) {
          const side = Number(payload.thumb_max_px || (node.properties && node.properties.thumb_max_px) || 360) || 360;
          await Promise.all(
            images.map(async (it) => {
              if (!it || typeof it !== "object" || it.data_url || !it.path) return;
              try {
                it.data_url = await _reportController.readImageThumb(String(it.path), side);
              } catch (_err) {
                it.data_url = "";
              }
            })
          );
        }
        const previewDir = String(payload.preview_image_dir || "").trim();
        if (previewDir) {
          node.properties = node.properties || {};
          node.properties.folder_dir = previewDir;
          const widgets = node.widgets || [];
          if (widgets[0]) widgets[0].value = previewDir;
        }
        if (typeof node.setPreviewPayload === "function") {
          node.setPreviewPayload(payload);
        }
      }
      markCanvasDirty();
    }

    async function applyOutputsToWorkspace(outputs) {
      await applyPreviewImagesToNodes(outputs);
      renderPreviewTable(outputs);
    }

    function clearPreviewTable(metaText = "结果预览：暂无") {
      const meta = document.getElementById("preview-meta-text");
      const body = document.getElementById("preview-body");
      meta.textContent = metaText;
      body.innerHTML = '<div class="preview-empty">请在工作流中连接“展示结果节点”，执行后将在这里显示前 10 条记录。</div>';
    }

    function clearReportPanel(metaText = "执行报告：暂无") {
      const meta = document.getElementById("report-meta-text");
      const body = document.getElementById("report-body");
      if (!meta || !body) return;
      meta.textContent = metaText;
      body.innerHTML = '<div class="preview-empty">执行后会在这里展示执行报告。</div>';
      currentReportPath = "";
      currentRunId = "";
    }

    function clearTimelinePanel(metaText = "运行回放：暂无") {
      stopTimelinePlayback();
      timelineItems = [];
      timelinePlayIndex = -1;
      currentTimelineRunId = "";
      const meta = document.getElementById("timeline-meta-text");
      const body = document.getElementById("timeline-body");
      if (!meta || !body) return;
      meta.textContent = metaText;
      body.innerHTML = '<div class="preview-empty">执行后会在这里展示节点级回放时间线。</div>';
    }

    function stopTimelinePlayback() {
      const state = {
        timelinePlayTimer,
        timelinePlayIndex,
        timelineItems,
      };
      if (_reportRuntime.stopPlayback) _reportRuntime.stopPlayback(state);
      else if (timelinePlayTimer) clearTimeout(timelinePlayTimer);
      timelinePlayTimer = state.timelinePlayTimer || null;
      timelinePlayIndex = Number.isFinite(Number(state.timelinePlayIndex))
        ? Number(state.timelinePlayIndex)
        : timelinePlayIndex;
    }

    function highlightTimelineItem(index) {
      const state = { timelinePlayIndex };
      if (_reportRuntime.highlightItem) _reportRuntime.highlightItem(state, index);
      timelinePlayIndex = Number.isFinite(Number(state.timelinePlayIndex))
        ? Number(state.timelinePlayIndex)
        : Number(index);
    }

    function playTimelineSequence(speed = 1) {
      const state = {
        timelinePlayTimer,
        timelinePlayIndex,
        timelineItems,
      };
      if (_reportRuntime.playSequence) _reportRuntime.playSequence(state, speed);
      timelinePlayTimer = state.timelinePlayTimer || null;
      timelinePlayIndex = Number.isFinite(Number(state.timelinePlayIndex))
        ? Number(state.timelinePlayIndex)
        : timelinePlayIndex;
    }

    function renderRunTimeline(timeline, sourceText = "执行回放") {
      const meta = document.getElementById("timeline-meta-text");
      const body = document.getElementById("timeline-body");
      if (!meta || !body) return;
      stopTimelinePlayback();

      if (_reportRuntime.buildTimelineRenderPayload) {
        const payload = _reportRuntime.buildTimelineRenderPayload(timeline, sourceText, {
          formatEpochTime,
          escapeHtml,
          reportView: _reportView,
          reportReplay: _reportReplay,
        });
        currentTimelineRunId = String(payload.runId || "");
        timelineItems = Array.isArray(payload.nodes) ? payload.nodes : [];
        timelinePlayIndex = -1;
        meta.textContent = String(payload.metaText || `${sourceText}：无节点数据`);
        body.innerHTML = String(payload.html || "");
        return;
      }

      const data = timeline && typeof timeline === "object" ? timeline : {};
      const runId = String(data.run_id || "");
      const status = String(data.status || "");
      const nodes = Array.isArray(data.nodes) ? data.nodes.slice() : [];
      currentTimelineRunId = runId;
      timelineItems = nodes;
      timelinePlayIndex = -1;

      if (!nodes.length) {
        meta.textContent = `${sourceText}：无节点数据`;
        body.innerHTML = '<div class="preview-empty">当前执行未记录节点级事件。</div>';
        return;
      }

      const elapsedMs = Math.max(
        1,
        Number(data.elapsed_sec || 0) * 1000,
        Math.max(...nodes.map((x) => Number(x.duration_ms || 0)))
      );
      const startedAtText = formatEpochTime(Number(data.started_at || 0)) || "-";
      const triggerText = String(data.trigger || "-");
      meta.textContent = `${sourceText}：${status || "-"} | run_id=${runId || "-"} | 开始 ${startedAtText} | 节点 ${nodes.length}`;

      const controlsHtml = _reportView.buildTimelineControlsHtml
        ? _reportView.buildTimelineControlsHtml(triggerText, escapeHtml)
        : `
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
          <span style="font-size:12px;color:#9eb0cb">触发来源: ${escapeHtml(triggerText)}</span>
        </div>
      `;

      const listHtml = nodes.map((item, index) => {
        if (_reportView.buildTimelineItemHtml) {
          return _reportView.buildTimelineItemHtml(item, index, {
            escapeHtml,
            formatEpochTime,
            statusText: (s) => (_reportReplay.timelineItemStatusText
              ? _reportReplay.timelineItemStatusText(s)
              : (s === "error" ? "失败" : "成功")),
            widthPct: (duration) => (_reportReplay.timelineBarWidth
              ? _reportReplay.timelineBarWidth(duration, elapsedMs)
              : Math.max(1, Math.min(100, (duration / elapsedMs) * 100))),
          });
        }
        const nodeId = String(item.node_id || "-");
        const classType = String(item.class_type || "-");
        const itemStatus = String(item.status || "ok");
        const duration = Number(item.duration_ms || 0);
        const width = _reportReplay.timelineBarWidth
          ? _reportReplay.timelineBarWidth(duration, elapsedMs)
          : Math.max(1, Math.min(100, (duration / elapsedMs) * 100));
        const errorText = String(item.error || "").trim();
        const statusCls = itemStatus === "error" ? "error" : "";
        const rangeText = `${formatEpochTime(Number(item.start_ts || 0))} -> ${formatEpochTime(Number(item.end_ts || 0))}`;
        const errorHtml = errorText ? `<div class="timeline-error">${escapeHtml(errorText)}</div>` : "";
        return `
          <div class="timeline-item ${statusCls}" data-index="${index}">
            <div class="timeline-item-head">
              <span class="timeline-title">节点 ${escapeHtml(nodeId)} · ${escapeHtml(classType)}</span>
              <span class="timeline-status ${statusCls}">${_reportReplay.timelineItemStatusText ? _reportReplay.timelineItemStatusText(itemStatus) : (itemStatus === "error" ? "失败" : "成功")}</span>
            </div>
            <div class="timeline-metrics">
              <span>耗时: ${duration.toFixed(1)} ms</span>
              <span>时间: ${escapeHtml(rangeText)}</span>
            </div>
            <div class="timeline-bar-wrap"><div class="timeline-bar" style="width:${width.toFixed(2)}%"></div></div>
            ${errorHtml}
          </div>
        `;
      }).join("");

      body.innerHTML = `${controlsHtml}<div class="timeline-list">${listHtml}</div>`;
    }

    function toggleTimelinePlayback() {
      const speedEl = document.getElementById("timeline-speed-select");
      const speed = speedEl ? Number(speedEl.value || "1") : 1;
      const state = {
        timelinePlayTimer,
        timelinePlayIndex,
        timelineItems,
      };
      if (_reportRuntime.togglePlayback) _reportRuntime.togglePlayback(state, speed);
      else if (timelinePlayTimer) stopTimelinePlayback();
      else playTimelineSequence(speed);
      timelinePlayTimer = state.timelinePlayTimer || null;
      timelinePlayIndex = Number.isFinite(Number(state.timelinePlayIndex))
        ? Number(state.timelinePlayIndex)
        : timelinePlayIndex;
    }

    function renderReportSummaryCard(title, value, status = "") {
      if (_reportView.buildReportSummaryCard) {
        return _reportView.buildReportSummaryCard(title, value, status);
      }
      const cls = status ? `report-card ${status}` : "report-card";
      return `<div class="${cls}"><div class="k">${title}</div><div class="v">${value}</div></div>`;
    }

    function renderExecutionReport(payload, reportPath = "", sourceText = "执行报告") {
      ensureRunResultHandler();
      if (_runResultHandler && _runResultHandler.renderExecutionReport) {
        _runResultHandler.renderExecutionReport(payload, reportPath, sourceText);
      }
    }

    function escapeHtml(text) {
      if (_reportController.escapeHtml) return _reportController.escapeHtml(text);
      const raw = String(text == null ? "" : text);
      return raw
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
    }

    async function openReportInBottomTab(path, sourceText = "执行报告", expectedRunId = "") {
      ensureRunResultHandler();
      if (_runResultHandler && _runResultHandler.openReportInBottomTab) {
        await _runResultHandler.openReportInBottomTab(path, sourceText, expectedRunId);
      }
    }

    async function openTimelineByReportPath(path, sourceText = "执行回放", runId = "") {
      ensureRunResultHandler();
      if (_runResultHandler && _runResultHandler.openTimelineByReportPath) {
        await _runResultHandler.openTimelineByReportPath(path, sourceText, runId);
      }
    }

    function renderPreviewTable(outputs) {
      ensurePreviewRenderer();
      if (_previewRenderer && _previewRenderer.renderPreviewTable) {
        _previewRenderer.renderPreviewTable(outputs);
        return;
      }
      const preview = pickPreviewOutput(outputs);
      if (!preview) {
        if (hasImagePreviewOutput(outputs)) clearPreviewTable("结果预览：图片已在图片预览节点中显示");
        else clearPreviewTable("结果预览：未检测到展示结果节点输出");
        return;
      }
      const columns = Array.isArray(preview.preview_columns) ? preview.preview_columns : [];
      const rows = Array.isArray(preview.preview_rows) ? preview.preview_rows : [];
      const total = Number(preview.preview_total_rows || rows.length || 0);
      const limit = Number(preview.preview_limit || rows.length || 10);
      const meta = document.getElementById("preview-meta-text");
      const body = document.getElementById("preview-body");
      if (!meta || !body) return;
      meta.textContent = `结果预览：展示 ${rows.length} / ${total} 条（上限 ${limit}）`;
      body.innerHTML = "";
      if (!columns.length) {
        body.innerHTML = '<div class="preview-empty">Excel 无可展示字段。</div>';
        return;
      }
      const table = document.createElement("table");
      table.className = "preview-table";
      const thead = document.createElement("thead");
      const headTr = document.createElement("tr");
      for (const col of columns) {
        const th = document.createElement("th");
        th.textContent = String(col);
        headTr.appendChild(th);
      }
      thead.appendChild(headTr);
      table.appendChild(thead);
      const tbody = document.createElement("tbody");
      for (const row of rows) {
        const tr = document.createElement("tr");
        for (const col of columns) {
          const td = document.createElement("td");
          const val = row && Object.prototype.hasOwnProperty.call(row, col) ? row[col] : "";
          td.textContent = val == null ? "" : String(val);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      body.appendChild(table);
    }

    function pickPreviewOutput(outputs) {
      ensurePreviewRenderer();
      if (_previewRenderer && _previewRenderer.pickPreviewOutput) {
        return _previewRenderer.pickPreviewOutput(outputs);
      }
      const nodeIds = Object.keys(outputs || {}).sort((a, b) => Number(a) - Number(b));
      let last = null;
      for (const nodeId of nodeIds) {
        const payload = outputs[nodeId];
        if (!payload || typeof payload !== "object") continue;
        const isExcelPreview = Array.isArray(payload.preview_columns) && Array.isArray(payload.preview_rows);
        if (isExcelPreview) {
          last = payload;
        }
      }
      return last;
    }

    function hasImagePreviewOutput(outputs) {
      ensurePreviewRenderer();
      if (_previewRenderer && _previewRenderer.hasImagePreviewOutput) {
        return _previewRenderer.hasImagePreviewOutput(outputs);
      }
      const nodeIds = Object.keys(outputs || {});
      for (const nodeId of nodeIds) {
        const payload = outputs[nodeId];
        if (!payload || typeof payload !== "object") continue;
        if (Array.isArray(payload.preview_images)) return true;
      }
      return false;
    }

    function markCanvasDirty() {
      if (canvas.setDirty) canvas.setDirty(true, true);
      if (graph.setDirtyCanvas) graph.setDirtyCanvas(true, true);
    }

    function zoomIn() {
      if (_uiLayout.zoom) {
        _uiLayout.zoom(canvas, markCanvasDirty, setStatus, "in");
        return;
      }
      const next = Math.min(2.2, (canvas.ds.scale || 1) * 1.15);
      canvas.ds.changeScale(next, [canvas.canvas.width * 0.5, canvas.canvas.height * 0.5]);
      markCanvasDirty();
      setStatus("缩放: " + Math.round(next * 100) + "%");
    }

    function zoomOut() {
      if (_uiLayout.zoom) {
        _uiLayout.zoom(canvas, markCanvasDirty, setStatus, "out");
        return;
      }
      const next = Math.max(0.2, (canvas.ds.scale || 1) / 1.15);
      canvas.ds.changeScale(next, [canvas.canvas.width * 0.5, canvas.canvas.height * 0.5]);
      markCanvasDirty();
      setStatus("缩放: " + Math.round(next * 100) + "%");
    }

    function resetView() {
      if (_uiLayout.resetView) {
        _uiLayout.resetView(canvas, markCanvasDirty, setStatus);
        return;
      }
      canvas.ds.scale = 1;
      canvas.ds.offset[0] = 0;
      canvas.ds.offset[1] = 0;
      markCanvasDirty();
      setStatus("视图已重置");
    }

    function arrangeAndFit() {
      if (_uiLayout.arrangeNodes) {
        _uiLayout.arrangeNodes(graph, markCanvasDirty, fitToView, setStatus);
        return;
      }
      const nodes = (graph._nodes || []).slice().sort((a, b) => a.id - b.id);
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
      markCanvasDirty();
      fitToView();
      setStatus("已自动排布");
    }

    function fitToView(silent = false) {
      if (_uiLayout.fitToView) {
        _uiLayout.fitToView(graph, canvas, markCanvasDirty, { silent, onStatus: setStatus });
        return;
      }
      const nodes = graph._nodes || [];
      if (!nodes.length) {
        markCanvasDirty();
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
      markCanvasDirty();
      if (!silent) setStatus("已适配视图");
    }

    function log(text) {
      const box = document.getElementById("logs");
      const now = new Date().toLocaleTimeString();
      box.textContent += `[${now}] ${text}\n`;
      scrollLogsToLatest();
    }

    function scrollLogsToLatest(force = false) {
      const box = document.getElementById("logs");
      if (!box) return;
      const doScroll = () => {
        box.scrollTop = box.scrollHeight;
      };
      doScroll();
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(doScroll);
      }
      setTimeout(doScroll, 0);
      if (force) {
        setTimeout(doScroll, 80);
      }
    }

    function setStatus(text) {
      const el = document.getElementById("status");
      el.textContent = text;
    }

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        const escModalClosers = [
          { id: "image-lightbox-modal", close: closeImageLightbox },
          { id: "workflow-picker-modal", close: closeWorkflowPicker },
          { id: "region-helper-modal", close: closeRegionHelper },
          { id: "tap-picker-modal", close: closeTapPicker },
          { id: "swipe-picker-modal", close: closeSwipePicker },
          { id: "dedup-keys-modal", close: closeDedupKeysEditor },
          { id: "invalid-data-key-modal", close: closeInvalidDataKeyEditor },
          { id: "schedule-modal", close: closeScheduleModal },
          { id: "schedule-list-modal", close: closeScheduleListModal },
          { id: "schedule-report-modal", close: closeScheduleReportModal },
          { id: "regions-modal", close: closeRegionsEditor },
        ];
        for (const item of escModalClosers) {
          const open = _modalController
            ? _modalController.isOpen(item.id)
            : (() => {
                const el = document.getElementById(item.id);
                return !!(el && !el.classList.contains("hidden"));
              })();
          if (!open) continue;
          item.close();
          return;
        }
      }

      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (isTypingInTextField(event.target)) return;

      let node = getSelectedPreviewImageNode();
      if (!node && imageLightboxState.nodeId != null) {
        node = getPreviewImageNodeById(imageLightboxState.nodeId);
      }
      if (!node || typeof node.nextPreview !== "function") return;

      const step = event.key === "ArrowLeft" ? -1 : 1;
      const switched = node.nextPreview(step);
      if (switched) {
        event.preventDefault();
        syncImageLightboxFromNode(node);
      }
    });

    const localWorkflowInput = document.getElementById("workflow-local-file");
    if (localWorkflowInput) {
      localWorkflowInput.addEventListener("change", handleLocalWorkflowFileChange);
    }
    const scheduleNameInput = document.getElementById("schedule-name-input");
    const scheduleIntervalInput = document.getElementById("schedule-interval-input");
    const scheduleMaxRunsInput = document.getElementById("schedule-max-runs-input");
    const onScheduleInputEnter = (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submitScheduleTask();
      }
    };
    if (scheduleNameInput) scheduleNameInput.addEventListener("keydown", onScheduleInputEnter);
    if (scheduleIntervalInput) scheduleIntervalInput.addEventListener("keydown", onScheduleInputEnter);
    if (scheduleMaxRunsInput) scheduleMaxRunsInput.addEventListener("keydown", onScheduleInputEnter);

    updateRunButtonState();
    refreshRuntimeStatus(true);
    refreshLatestScheduleOutcome(true);
    if (runtimeStatusTimer) clearInterval(runtimeStatusTimer);
    runtimeStatusTimer = setInterval(() => {
      if (workflowRunning) return;
      refreshRuntimeStatus(true);
      refreshLatestScheduleOutcome(true);
    }, 3000);

    loadWorkflowSchema();
    refreshDevices();
    loadDefaultWorkflow();
    switchBottomTab("logs");
    setTimeout(() => {
      canvas.resize();
      fitToView();
    }, 80);

