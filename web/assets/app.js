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

    let deviceOptions = [""];
    let sidebarCollapsed = true;
    let bottomCollapsed = true;
    let activeBottomTab = "logs";
    let currentEditingOcrNode = null;
    let regionHelperReady = false;
    let workflowRunning = false;
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

    const CLASS_MAP = {
      "节点/开始": "StartDevice",
      "节点/点击": "Tap",
      "节点/滑动": "Swipe",
      "节点/等待": "Wait",
      "节点/截图": "Screenshot",
      "节点/循环开始": "LoopStart",
      "节点/循环结束": "LoopEnd",
      "节点/回传": "PullToPC",
      "节点/识别": "EasyOCR",
      "节点/导出": "ExportExcel",
      "节点/展示": "PreviewExcel",
      "节点/图片预览": "PreviewImages"
    };
    const CLASS_TO_NODE_MAP = Object.fromEntries(
      Object.entries(CLASS_MAP).map(([nodeType, classType]) => [classType, nodeType])
    );

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

    function StartNode() {
      this.title = "开始节点";
      this.properties = { device_id: "" };
      makeIO(this, false);
      this.addWidget("combo", "设备编号", this.properties.device_id, (v) => {
        this.properties.device_id = v || "";
      }, { values: () => deviceOptions });
      this.addWidget("button", "刷新设备", "", () => refreshDevices());
      this.size = [250, 100];
    }

    function TapNode() {
      this.title = "点击节点";
      this.properties = { x: 540, y: 1600 };
      makeIO(this, true);
      this.addWidget("number", "横坐标", this.properties.x, (v) => this.properties.x = Number(v));
      this.addWidget("number", "纵坐标", this.properties.y, (v) => this.properties.y = Number(v));
      this.size = [220, 100];
    }

    function SwipeNode() {
      this.title = "滑动节点";
      this.properties = { direction: "up", duration_ms: 350, distance_px: 120 };
      makeIO(this, true);
      this.addWidget(
        "combo",
        "滑动方向",
        directionValueToLabel(this.properties.direction),
        (v) => this.properties.direction = directionLabelToValue(v),
        { values: ["上滑", "下滑"] }
      );
      this.addWidget("number", "滑动时长(毫秒)", this.properties.duration_ms, (v) => this.properties.duration_ms = Number(v));
      this.addWidget("number", "滑动像素", this.properties.distance_px, (v) => this.properties.distance_px = Number(v));
      this.size = [240, 120];
    }

    function WaitNode() {
      this.title = "等待节点";
      this.properties = { duration_sec: 0.8 };
      makeIO(this, true);
      this.addWidget("number", "等待秒数", this.properties.duration_sec, (v) => this.properties.duration_sec = Number(v));
      this.size = [220, 90];
    }

    function ScreenshotNode() {
      this.title = "截图节点";
      this.properties = {
        remote_dir: "/sdcard/adbflow",
        prefix: "capture",
        scroll: true,
        scroll_count: 3,
        scroll_distance_px: 120,
        scroll_direction: "up",
        swipe_duration_ms: 300,
        swipe_pause_sec: 0.8,
        capture_pause_sec: 0.2
      };
      makeIO(this, true);
      this.addWidget("text", "手机目录", this.properties.remote_dir, (v) => this.properties.remote_dir = v);
      this.addWidget("text", "文件名前缀", this.properties.prefix, (v) => this.properties.prefix = v);
      this.addWidget("toggle", "滚动截图", this.properties.scroll, (v) => this.properties.scroll = !!v);
      this.addWidget("number", "截图张数", this.properties.scroll_count, (v) => this.properties.scroll_count = Number(v));
      this.addWidget("number", "滚动像素", this.properties.scroll_distance_px, (v) => this.properties.scroll_distance_px = Number(v));
      this.addWidget(
        "combo",
        "滚动方向",
        directionValueToLabel(this.properties.scroll_direction),
        (v) => this.properties.scroll_direction = directionLabelToValue(v),
        { values: ["上滑", "下滑"] }
      );
      this.size = [320, 250];
    }

    function LoopStartNode() {
      this.title = "循环开始节点";
      this.properties = {
        loop_count: 5,
        loop_start_wait_sec: 0.6
      };
      makeIO(this, true);
      this.addWidget("number", "循环次数", this.properties.loop_count, (v) => this.properties.loop_count = Number(v));
      this.addWidget("number", "每轮开始等待(秒)", this.properties.loop_start_wait_sec, (v) => this.properties.loop_start_wait_sec = Number(v));
      this.size = [280, 110];
    }

    function LoopEndNode() {
      this.title = "循环结束节点";
      makeIO(this, true);
      this.size = [220, 70];
    }

    function PullNode() {
      this.title = "回传节点";
      this.properties = {
        save_dir: "outputs/screenshots",
        stitch_scroll: true,
        max_overlap_px: 300,
        cleanup_remote: true
      };
      makeIO(this, true);
      this.addWidget("text", "电脑保存目录", this.properties.save_dir, (v) => this.properties.save_dir = v);
      this.addWidget("toggle", "拼接长图", this.properties.stitch_scroll, (v) => this.properties.stitch_scroll = !!v);
      this.addWidget("number", "最大重叠像素", this.properties.max_overlap_px, (v) => this.properties.max_overlap_px = Number(v));
      this.addWidget("toggle", "清理手机临时图(建议开启)", this.properties.cleanup_remote, (v) => this.properties.cleanup_remote = !!v);
      this.size = [300, 150];
    }

    function OCRNode() {
      this.title = "文字识别节点";
      this.properties = {
        languages: "ch_sim,en",
        gpu: false,
        use_all_images: false,
        image_dir: "",
        regions: JSON.stringify(
          [
            {"name":"姓名","x":250,"y":870,"w":830,"h":980},
            {"name":"手机号","x":60,"y":1050,"w":445,"h":1130}
          ],
          null,
          2
        )
      };
      makeIO(this, true);
      this.addWidget("text", "识别语言", this.properties.languages, (v) => this.properties.languages = v);
      this.addWidget("toggle", "启用显卡加速", this.properties.gpu, (v) => this.properties.gpu = !!v);
      this.addWidget("toggle", "识别全部图片", this.properties.use_all_images, (v) => this.properties.use_all_images = !!v);
      this.addWidget("text", "图片文件夹", this.properties.image_dir, (v) => this.properties.image_dir = v);
      this.addWidget("button", "打开图片文件位置", "", () => openOcrImageLocation(this));
      this.addWidget("button", "编辑识别区域(多行)", "", () => openRegionsEditor(this));
      this.__regionsPreviewWidget = this.addWidget("text", "区域摘要", buildRegionsPreview(this.properties.regions), () => {});
      this.size = [360, 240];
    }

    function ExcelNode() {
      this.title = "导出表格节点";
      this.properties = { output_path: "outputs/ocr_result.xlsx" };
      makeIO(this, true);
      this.addWidget("text", "导出文件路径", this.properties.output_path, (v) => this.properties.output_path = v);
      this.addWidget("button", "打开文件所在位置", "", () => openExcelOutputLocation(this));
      this.size = [300, 120];
    }

    function PreviewNode() {
      this.title = "展示结果节点";
      this.properties = { max_rows: 10 };
      makeIO(this, true);
      this.addWidget("number", "展示条数", this.properties.max_rows, (v) => this.properties.max_rows = Number(v));
      this.size = [240, 90];
    }

    function ImagePreviewNode() {
      this.title = "图片预览节点";
      this.properties = {
        folder_dir: "",
        max_images: 12
      };
      this._previewImages = [];
      this._previewImage = null;
      this._previewName = "";
      this._previewTotal = 0;
      this._previewLimit = 0;
      this._previewIndex = -1;
      this._previewLoadToken = 0;
      this._previewPanelRect = { x: 8, y: 108, w: 1, h: 1 };
      this._previewMessage = "执行后在节点内显示图片";
      makeIO(this, true);
      this.addWidget("text", "图片文件夹", this.properties.folder_dir, (v) => this.properties.folder_dir = v);
      this.addWidget("number", "展示张数", this.properties.max_images, (v) => this.properties.max_images = Number(v));
      this.size = [320, 280];

      this.clearPreview = () => {
        this._previewImages = [];
        this._previewImage = null;
        this._previewName = "";
        this._previewTotal = 0;
        this._previewLimit = 0;
        this._previewIndex = -1;
        this._previewLoadToken += 1;
        this._previewMessage = "执行后在节点内显示图片";
        syncImageLightboxFromNode(this);
        if (this.graph && this.graph.setDirtyCanvas) this.graph.setDirtyCanvas(true, true);
      };

      this.setPreviewIndex = (index) => {
        const total = this._previewImages.length;
        if (!total) {
          this._previewIndex = -1;
          this._previewImage = null;
          this._previewName = "";
          this._previewMessage = "该目录下没有可预览图片";
          syncImageLightboxFromNode(this);
          if (this.graph && this.graph.setDirtyCanvas) this.graph.setDirtyCanvas(true, true);
          return false;
        }

        let next = Number(index);
        if (!Number.isFinite(next)) next = 0;
        next = ((Math.trunc(next) % total) + total) % total;
        this._previewIndex = next;

        const item = this._previewImages[next] || {};
        this._previewName = String(item.name || "");
        this._previewMessage = `共 ${this._previewTotal} 张，显示 ${this._previewImages.length} 张`;

        const src = String(item.data_url || "");
        if (!src) {
          this._previewImage = null;
          this._previewMessage = "图片数据为空";
          syncImageLightboxFromNode(this);
          if (this.graph && this.graph.setDirtyCanvas) this.graph.setDirtyCanvas(true, true);
          return false;
        }

        const token = ++this._previewLoadToken;
        this._previewImage = null;
        const img = new Image();
        img.onload = () => {
          if (token !== this._previewLoadToken) return;
          this._previewImage = img;
          syncImageLightboxFromNode(this);
          if (this.graph && this.graph.setDirtyCanvas) this.graph.setDirtyCanvas(true, true);
        };
        img.onerror = () => {
          if (token !== this._previewLoadToken) return;
          this._previewImage = null;
          this._previewMessage = "缩略图加载失败";
          syncImageLightboxFromNode(this);
          if (this.graph && this.graph.setDirtyCanvas) this.graph.setDirtyCanvas(true, true);
        };
        img.src = src;
        syncImageLightboxFromNode(this);
        if (this.graph && this.graph.setDirtyCanvas) this.graph.setDirtyCanvas(true, true);
        return true;
      };

      this.nextPreview = (step = 1) => {
        if (!this._previewImages.length) return false;
        return this.setPreviewIndex(this._previewIndex + Number(step || 0));
      };

      this.setPreviewPayload = (payload) => {
        const list = Array.isArray(payload && payload.preview_images) ? payload.preview_images : [];
        this._previewImages = list;
        this._previewTotal = Number(payload && payload.preview_image_total ? payload.preview_image_total : list.length);
        this._previewLimit = Number(payload && payload.preview_image_limit ? payload.preview_image_limit : list.length);

        if (!list.length) {
          this._previewImage = null;
          this._previewName = "";
          this._previewIndex = -1;
          this._previewLoadToken += 1;
          this._previewMessage = "该目录下没有可预览图片";
          syncImageLightboxFromNode(this);
          if (this.graph && this.graph.setDirtyCanvas) this.graph.setDirtyCanvas(true, true);
          return;
        }

        this.setPreviewIndex(0);
      };

      this.onDrawForeground = (ctx) => {
        const panelX = 8;
        const panelY = 108;
        const panelW = Math.max(10, this.size[0] - 16);
        const panelH = Math.max(10, this.size[1] - 132);
        this._previewPanelRect = { x: panelX, y: panelY, w: panelW, h: panelH };

        ctx.save();
        ctx.fillStyle = "#151922";
        ctx.fillRect(panelX, panelY, panelW, panelH);
        ctx.strokeStyle = "#3d4452";
        ctx.strokeRect(panelX, panelY, panelW, panelH);

        if (this._previewImage) {
          const iw = this._previewImage.width || 1;
          const ih = this._previewImage.height || 1;
          const scale = Math.min(panelW / iw, panelH / ih);
          const dw = iw * scale;
          const dh = ih * scale;
          const dx = panelX + (panelW - dw) * 0.5;
          const dy = panelY + (panelH - dh) * 0.5;
          ctx.drawImage(this._previewImage, dx, dy, dw, dh);
        } else {
          ctx.fillStyle = "#8a93a5";
          ctx.font = "12px Segoe UI";
          ctx.fillText(this._previewMessage || "暂无预览", panelX + 10, panelY + 20);
        }

        ctx.fillStyle = "#c9d1df";
        ctx.font = "12px Segoe UI";
        if (this._previewName) {
          const title = this._previewName.length > 26 ? this._previewName.slice(0, 26) + "..." : this._previewName;
          ctx.fillText(title, panelX + 6, panelY - 6);
        }
        if (this._previewTotal > 0) {
          const current = this._previewIndex >= 0 ? this._previewIndex + 1 : 0;
          const txt = `第 ${current} / ${this._previewImages.length} 张（总数 ${this._previewTotal}）`;
          ctx.fillText(txt, panelX + 6, panelY + panelH + 16);
        }
        ctx.restore();
      };
    }

    LiteGraph.registerNodeType("节点/开始", StartNode);
    LiteGraph.registerNodeType("节点/点击", TapNode);
    LiteGraph.registerNodeType("节点/滑动", SwipeNode);
    LiteGraph.registerNodeType("节点/等待", WaitNode);
    LiteGraph.registerNodeType("节点/截图", ScreenshotNode);
    LiteGraph.registerNodeType("节点/循环开始", LoopStartNode);
    LiteGraph.registerNodeType("节点/循环结束", LoopEndNode);
    LiteGraph.registerNodeType("节点/回传", PullNode);
    LiteGraph.registerNodeType("节点/识别", OCRNode);
    LiteGraph.registerNodeType("节点/导出", ExcelNode);
    LiteGraph.registerNodeType("节点/展示", PreviewNode);
    LiteGraph.registerNodeType("节点/图片预览", ImagePreviewNode);

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
      clearPreviewTable();
      markCanvasDirty();
    }

    async function loadDefaultWorkflow() {
      try {
        setStatus("正在加载默认工作流...");
        await loadWorkflowByApi("/api/workflow/default", "example_workflow.json", false);
        setStatus("默认工作流已加载");
      } catch (err) {
        log("加载默认工作流失败: " + err.message);
        setStatus("默认工作流加载失败");
      }
    }

    async function openWorkflowPicker() {
      const modal = document.getElementById("workflow-picker-modal");
      modal.classList.remove("hidden");
      setStatus("正在读取 workflows 目录...");
      await refreshWorkflowList();
    }

    function closeWorkflowPicker() {
      const modal = document.getElementById("workflow-picker-modal");
      modal.classList.add("hidden");
    }

    async function refreshWorkflowList() {
      const list = document.getElementById("workflow-list");
      const dirText = document.getElementById("workflow-dir-text");
      list.innerHTML = '<div class="workflow-empty">正在读取工作流列表...</div>';
      try {
        const res = await fetch("/api/workflows");
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || "读取工作流列表失败");
        dirText.textContent = `目录：${data.dir || "workflows"}`;
        renderWorkflowList(Array.isArray(data.files) ? data.files : []);
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
      const res = await fetch(apiUrl);
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "加载工作流失败");
      importWorkflowToCanvas(data.workflow || {});
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
      reader.onload = () => {
        try {
          const text = String(reader.result || "");
          const workflow = JSON.parse(text);
          if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) {
            throw new Error("工作流内容必须是对象格式");
          }
          importWorkflowToCanvas(workflow);
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

    function importWorkflowToCanvas(workflow) {
      graph.clear();
      clearPreviewTable();
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
    }

    function isLinkRef(value) {
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

      if (ct === "StartDevice") {
        if (widgets[0]) widgets[0].value = node.properties.device_id || "";
      } else if (ct === "Tap") {
        if (widgets[0]) widgets[0].value = Number(node.properties.x ?? 540);
        if (widgets[1]) widgets[1].value = Number(node.properties.y ?? 1600);
      } else if (ct === "Swipe") {
        if (widgets[0]) widgets[0].value = directionValueToLabel(node.properties.direction || "up");
        if (widgets[1]) widgets[1].value = Number(node.properties.duration_ms ?? 350);
        if (widgets[2]) widgets[2].value = Number(node.properties.distance_px ?? 120);
      } else if (ct === "Wait") {
        if (widgets[0]) widgets[0].value = Number(node.properties.duration_sec ?? 0.8);
      } else if (ct === "Screenshot") {
        if (widgets[0]) widgets[0].value = node.properties.remote_dir || "/sdcard/adbflow";
        if (widgets[1]) widgets[1].value = node.properties.prefix || "capture";
        if (widgets[2]) widgets[2].value = !!node.properties.scroll;
        if (widgets[3]) widgets[3].value = Number(node.properties.scroll_count ?? 3);
        if (widgets[4]) widgets[4].value = Number(node.properties.scroll_distance_px ?? 120);
        if (widgets[5]) widgets[5].value = directionValueToLabel(node.properties.scroll_direction || "up");
      } else if (ct === "LoopStart") {
        if (widgets[0]) widgets[0].value = Number(node.properties.loop_count ?? 5);
        if (widgets[1]) widgets[1].value = Number(node.properties.loop_start_wait_sec ?? 0.6);
      } else if (ct === "PullToPC") {
        if (widgets[0]) widgets[0].value = node.properties.save_dir || "outputs/screenshots";
        if (widgets[1]) widgets[1].value = !!node.properties.stitch_scroll;
        if (widgets[2]) widgets[2].value = Number(node.properties.max_overlap_px ?? 300);
        if (widgets[3]) widgets[3].value = node.properties.cleanup_remote !== false;
      } else if (ct === "EasyOCR") {
        if (widgets[0]) widgets[0].value = node.properties.languages || "ch_sim,en";
        if (widgets[1]) widgets[1].value = !!node.properties.gpu;
        if (widgets[2]) widgets[2].value = !!node.properties.use_all_images;
        if (widgets[3]) widgets[3].value = node.properties.image_dir || "";
        syncOcrRegionsPreview(node);
      } else if (ct === "ExportExcel") {
        if (widgets[0]) widgets[0].value = node.properties.output_path || "outputs/ocr_result.xlsx";
      } else if (ct === "PreviewExcel") {
        if (widgets[0]) widgets[0].value = Number(node.properties.max_rows ?? 10);
      } else if (ct === "PreviewImages") {
        if (widgets[0]) widgets[0].value = node.properties.folder_dir || "";
        if (widgets[1]) widgets[1].value = Number(node.properties.max_images ?? 12);
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
        const inputs = { ...(node.properties || {}) };
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
      const outputPath = String((node && node.properties && node.properties.output_path) || "outputs/ocr_result.xlsx").trim();
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

    function setRunButtonBusy(isBusy) {
      workflowRunning = !!isBusy;
      const btn = document.getElementById("run-workflow-btn");
      if (!btn) return;
      btn.disabled = workflowRunning;
      btn.innerHTML = workflowRunning
        ? '<span class="btn-icon">&#9203;</span>执行中...'
        : '<span class="btn-icon">&#9654;</span>运行工作流';
    }

    function resetNodeProgressHighlight() {
      const nodes = graph && graph._nodes ? graph._nodes : [];
      for (const node of nodes) {
        if (!node) continue;
        const backup = node.__progressBackup;
        if (backup) {
          node.color = backup.color;
          node.bgcolor = backup.bgcolor;
          node.boxcolor = backup.boxcolor;
          node.__progressBackup = null;
        }
        node.__progressState = "";
      }
      markCanvasDirty();
    }

    function setNodeProgressState(nodeId, state) {
      const id = Number(nodeId);
      if (!Number.isFinite(id)) return;
      const node = graph.getNodeById(id);
      if (!node) return;

      if (!node.__progressBackup) {
        node.__progressBackup = {
          color: node.color,
          bgcolor: node.bgcolor,
          boxcolor: node.boxcolor
        };
      }

      if (state === "running") {
        node.color = "#f0ad4e";
        node.bgcolor = "#4a361c";
        node.boxcolor = "#f0ad4e";
      } else if (state === "done") {
        node.color = "#5fd08d";
        node.bgcolor = "#1d3b2d";
        node.boxcolor = "#5fd08d";
      } else if (state === "error") {
        node.color = "#ff6b6b";
        node.bgcolor = "#4f2020";
        node.boxcolor = "#ff6b6b";
      }
      node.__progressState = state;
      markCanvasDirty();
    }

    function handleRunEventMessage(msg) {
      const eventName = String(msg.event || "");
      const nodeId = msg.node_id;
      if (nodeId == null) return;
      const nodeText = `节点 ${nodeId}`;

      if (eventName === "node_start") {
        setNodeProgressState(nodeId, "running");
        setStatus(`执行中：${nodeText}`);
      } else if (eventName === "node_done") {
        setNodeProgressState(nodeId, "done");
        setStatus(`已完成：${nodeText}`);
      } else if (eventName === "node_error") {
        setNodeProgressState(nodeId, "error");
        setStatus(`执行失败：${nodeText}`);
      }
    }

    async function runWorkflowStream(workflow) {
      const res = await fetch("/api/run-stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow })
      });

      if (!res.ok) {
        try {
          const data = await res.json();
          throw new Error(data.error || "执行失败");
        } catch (_err) {
          throw new Error(`执行失败（HTTP ${res.status}）`);
        }
      }

      if (!res.body || typeof res.body.getReader !== "function") {
        const fallbackRes = await fetch("/api/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workflow })
        });
        const fallbackData = await fallbackRes.json();
        if (!fallbackData.ok) throw new Error(fallbackData.error || "执行失败");
        for (const line of (fallbackData.logs || [])) log(line);
        return { outputs: fallbackData.outputs || {}, logs: fallbackData.logs || [] };
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      let finalResult = null;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let nl = buffer.indexOf("\n");
        while (nl >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line) {
            const msg = JSON.parse(line);
            if (msg.type === "log") {
              log(String(msg.line || ""));
            } else if (msg.type === "event") {
              handleRunEventMessage(msg);
            } else if (msg.type === "error") {
              throw new Error(String(msg.error || "执行失败"));
            } else if (msg.type === "result") {
              finalResult = {
                outputs: msg.outputs || {},
                logs: msg.logs || []
              };
            }
          }
          nl = buffer.indexOf("\n");
        }
      }

      const tail = buffer.trim();
      if (tail) {
        const msg = JSON.parse(tail);
        if (msg.type === "error") throw new Error(String(msg.error || "执行失败"));
        if (msg.type === "result") {
          finalResult = {
            outputs: msg.outputs || {},
            logs: msg.logs || []
          };
        }
      }

      if (!finalResult) {
        throw new Error("执行流未返回结果");
      }
      return finalResult;
    }

    async function runWorkflow() {
      if (workflowRunning) {
        setStatus("工作流正在执行，请稍候");
        return;
      }
      const runStartedAt = performance.now();
      const workflow = serializeWorkflow();
      if (!Object.keys(workflow).length) {
        log("没有可执行节点");
        setStatus("没有可执行节点");
        return;
      }
      log("开始执行工作流...");
      setStatus("工作流执行中...");
      setRunButtonBusy(true);
      clearPreviewTable("结果预览：执行中...");
      clearPreviewImagesOnNodes();
      resetNodeProgressHighlight();
      try {
        const data = await runWorkflowStream(workflow);
        const elapsedSec = ((performance.now() - runStartedAt) / 1000).toFixed(2);
        log("执行完成。输出节点: " + Object.keys(data.outputs || {}).join(", "));
        log(`执行耗时: ${elapsedSec} 秒`);
        applyPreviewImagesToNodes(data.outputs || {});
        renderPreviewTable(data.outputs || {});
        setStatus("执行完成");
      } catch (err) {
        log("执行失败: " + err.message);
        clearPreviewTable("结果预览：执行失败");
        setStatus("执行失败");
      } finally {
        setRunButtonBusy(false);
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
      activeBottomTab = tab === "preview" ? "preview" : "logs";
      const logs = document.getElementById("logs");
      const preview = document.getElementById("preview-panel");
      const tabLogBtn = document.getElementById("tab-log-btn");
      const tabPreviewBtn = document.getElementById("tab-preview-btn");
      const clearBtn = document.getElementById("clear-log-btn");

      const onLogs = activeBottomTab === "logs";
      logs.classList.toggle("hidden", !onLogs);
      preview.classList.toggle("hidden", onLogs);
      tabLogBtn.classList.toggle("active", onLogs);
      tabPreviewBtn.classList.toggle("active", !onLogs);
      clearBtn.classList.toggle("hidden", !onLogs);
      if (onLogs) {
        scrollLogsToLatest(true);
      }
      setStatus(onLogs ? "已切换到执行日志" : "已切换到结果预览");
    }

    function normalizeRegionsText(value) {
      if (typeof value === "string") return value;
      try {
        return JSON.stringify(value || [], null, 2);
      } catch (_err) {
        return "";
      }
    }

    function buildRegionsPreview(value) {
      const raw = normalizeRegionsText(value).trim();
      if (!raw) return "未配置";
      const lines = raw.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
      if (!lines.length) return "未配置";
      if (lines.length === 1) return lines[0].slice(0, 24);
      return `${lines[0].slice(0, 20)} ... (${lines.length} 行)`;
    }

    function syncOcrRegionsPreview(node) {
      if (!node || !node.__regionsPreviewWidget) return;
      node.__regionsPreviewWidget.value = buildRegionsPreview(node.properties.regions);
      markCanvasDirty();
    }

    function openRegionsEditor(node) {
      currentEditingOcrNode = node;
      const modal = document.getElementById("regions-modal");
      const textarea = document.getElementById("regions-textarea");
      textarea.value = normalizeRegionsText(node && node.properties ? node.properties.regions : "");
      modal.classList.remove("hidden");
      setTimeout(() => textarea.focus(), 0);
    }

    function closeRegionsEditor() {
      closeRegionHelper();
      currentEditingOcrNode = null;
      const modal = document.getElementById("regions-modal");
      modal.classList.add("hidden");
    }

    function formatRegionsEditor() {
      const textarea = document.getElementById("regions-textarea");
      const text = String(textarea.value || "").trim();
      if (!text) {
        textarea.value = "[]";
        return;
      }
      try {
        const parsed = JSON.parse(text);
        textarea.value = JSON.stringify(parsed, null, 2);
        setStatus("识别区域配置已格式化");
      } catch (_err) {
        setStatus("识别区域配置不是合法 JSON，无法格式化");
      }
    }

    function saveRegionsEditor() {
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
      regionHelper.rects = [];
      regionHelper.activeIndex = -1;
      renderRegionHelperList();
      drawRegionHelperCanvas();
      setStatus("已清空选区");
    }

    function applyRegionHelperToEditor() {
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
        const parsed = JSON.parse(String(text));
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
        if (typeof node.clearPreview === "function") node.clearPreview();
      }
    }

    function applyPreviewImagesToNodes(outputs) {
      const entries = Object.entries(outputs || {});
      for (const [nodeId, payload] of entries) {
        if (!payload || typeof payload !== "object" || !Array.isArray(payload.preview_images)) continue;
        const node = graph.getNodeById(Number(nodeId));
        if (!node) continue;
        if (CLASS_MAP[node.type] !== "PreviewImages") continue;
        if (typeof node.setPreviewPayload === "function") {
          node.setPreviewPayload(payload);
        }
      }
    }

    function clearPreviewTable(metaText = "结果预览：暂无") {
      const meta = document.getElementById("preview-meta-text");
      const body = document.getElementById("preview-body");
      meta.textContent = metaText;
      body.innerHTML = '<div class="preview-empty">请在工作流中连接“展示结果节点”，执行后将在这里显示前 10 条记录。</div>';
    }

    function renderPreviewTable(outputs) {
      const preview = pickPreviewOutput(outputs);
      if (!preview) {
        if (hasImagePreviewOutput(outputs)) {
          clearPreviewTable("结果预览：图片已在图片预览节点中显示");
        } else {
          clearPreviewTable("结果预览：未检测到展示结果节点输出");
        }
        return;
      }

      const columns = Array.isArray(preview.preview_columns) ? preview.preview_columns : [];
      const rows = Array.isArray(preview.preview_rows) ? preview.preview_rows : [];
      const total = Number(preview.preview_total_rows || rows.length || 0);
      const limit = Number(preview.preview_limit || rows.length || 10);

      const meta = document.getElementById("preview-meta-text");
      const body = document.getElementById("preview-body");
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
      const next = Math.min(2.2, (canvas.ds.scale || 1) * 1.15);
      canvas.ds.changeScale(next, [canvas.canvas.width * 0.5, canvas.canvas.height * 0.5]);
      markCanvasDirty();
      setStatus("缩放: " + Math.round(next * 100) + "%");
    }

    function zoomOut() {
      const next = Math.max(0.2, (canvas.ds.scale || 1) / 1.15);
      canvas.ds.changeScale(next, [canvas.canvas.width * 0.5, canvas.canvas.height * 0.5]);
      markCanvasDirty();
      setStatus("缩放: " + Math.round(next * 100) + "%");
    }

    function resetView() {
      canvas.ds.scale = 1;
      canvas.ds.offset[0] = 0;
      canvas.ds.offset[1] = 0;
      markCanvasDirty();
      setStatus("视图已重置");
    }

    function arrangeAndFit() {
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
        const imageLightbox = document.getElementById("image-lightbox-modal");
        if (imageLightbox && !imageLightbox.classList.contains("hidden")) {
          closeImageLightbox();
          return;
        }
        const workflowPicker = document.getElementById("workflow-picker-modal");
        if (!workflowPicker.classList.contains("hidden")) {
          closeWorkflowPicker();
          return;
        }
        const helperModal = document.getElementById("region-helper-modal");
        if (!helperModal.classList.contains("hidden")) {
          closeRegionHelper();
          return;
        }
        const modal = document.getElementById("regions-modal");
        if (!modal.classList.contains("hidden")) {
          closeRegionsEditor();
        }
        return;
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
    const imageLightboxModal = document.getElementById("image-lightbox-modal");
    if (imageLightboxModal) {
      imageLightboxModal.addEventListener("click", (event) => {
        if (event.target === imageLightboxModal) {
          closeImageLightbox();
        }
      });
    }

    refreshDevices();
    loadDefaultWorkflow();
    switchBottomTab("logs");
    setTimeout(() => {
      canvas.resize();
      fitToView();
    }, 80);

