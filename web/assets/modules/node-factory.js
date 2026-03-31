(function () {
  const root = (window.ADBModules = window.ADBModules || {});

  const CLASS_MAP = {
    "节点/开始": "StartDevice",
    "节点/输入": "InputFill",
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
    "节点/图片预览": "PreviewImages",
  };

  function createMappings() {
    return {
      CLASS_MAP: { ...CLASS_MAP },
      CLASS_TO_NODE_MAP: Object.fromEntries(
        Object.entries(CLASS_MAP).map(([nodeType, classType]) => [classType, nodeType])
      ),
    };
  }

  function registerBuiltinNodes(deps) {
    const {
      LiteGraph,
      makeIO,
      directionValueToLabel,
      directionLabelToValue,
      inputChannelValueToLabel,
      inputChannelLabelToValue,
      getDeviceOptions,
      refreshDevices,
      openTapPicker,
      openSwipePicker,
      setStatus,
      openOcrImageLocation,
      openRegionsEditor,
      buildRegionsPreview,
      openDedupKeysEditor,
      buildDedupKeysPreview,
      openExcelOutputLocation,
      syncImageLightboxFromNode,
    } = deps;

    function StartNode() {
      this.title = "开始节点";
      this.properties = { device_id: "" };
      makeIO(this, false);
      this.addWidget(
        "combo",
        "设备编号",
        this.properties.device_id,
        (v) => {
          this.properties.device_id = v || "";
        },
        { values: () => (typeof getDeviceOptions === "function" ? getDeviceOptions() : [""]) }
      );
      this.addWidget("button", "刷新设备", "", () => refreshDevices());
      this.size = [250, 100];
    }

    function TapNode() {
      this.title = "点击节点";
      this.properties = { x: 540, y: 1600 };
      makeIO(this, true);
      this.addWidget("number", "横坐标", this.properties.x, (v) => (this.properties.x = Number(v)));
      this.addWidget("number", "纵坐标", this.properties.y, (v) => (this.properties.y = Number(v)));
      this.addWidget("button", "图片取点", "", () => openTapPicker(this));
      this.size = [240, 130];
    }

    function InputNode() {
      this.title = "输入节点";
      this.properties = {
        text_channel: "clipboard",
        text: "你好，这是一条自动输入内容",
      };
      makeIO(this, true);
      this.addWidget(
        "combo",
        "输入通道",
        inputChannelValueToLabel(this.properties.text_channel),
        (v) => (this.properties.text_channel = inputChannelLabelToValue(v)),
        { values: ["剪贴板", "自动", "ADB Keyboard", "InputText"] }
      );
      this.addWidget("text", "输入内容", this.properties.text, (v) => (this.properties.text = v));
      this.size = [340, 130];
    }

    function SwipeNode() {
      this.title = "滑动节点";
      this.properties = { direction: "up", duration_ms: 350, distance_px: 420, x: null, y: null };
      makeIO(this, true);
      this.addWidget(
        "combo",
        "滑动方向",
        directionValueToLabel(this.properties.direction),
        (v) => (this.properties.direction = directionLabelToValue(v)),
        { values: ["上滑", "下滑"] }
      );
      this.addWidget("number", "滑动时长(毫秒)", this.properties.duration_ms, (v) => (this.properties.duration_ms = Number(v)));
      this.addWidget("number", "滑动像素", this.properties.distance_px, (v) => (this.properties.distance_px = Number(v)));
      this.addWidget("text", "起点X(可选)", this.properties.x == null ? "" : String(this.properties.x), (v) => {
        const txt = String(v || "").trim();
        this.properties.x = txt === "" ? null : Number(txt);
      });
      this.addWidget("text", "起点Y(可选)", this.properties.y == null ? "" : String(this.properties.y), (v) => {
        const txt = String(v || "").trim();
        this.properties.y = txt === "" ? null : Number(txt);
      });
      this.addWidget("button", "图片取点(起止)", "", () => openSwipePicker(this));
      this.size = [280, 200];
    }

    function WaitNode() {
      this.title = "等待节点";
      this.properties = { duration_sec: 0.8 };
      makeIO(this, true);
      this.addWidget("number", "等待秒数", this.properties.duration_sec, (v) => (this.properties.duration_sec = Number(v)));
      this.size = [220, 90];
    }

    function ScreenshotNode() {
      this.title = "截图节点";
      this.properties = {
        remote_dir: "/sdcard/adbflow",
        prefix: "capture",
      };
      makeIO(this, true);
      this.addWidget("text", "手机目录", this.properties.remote_dir, (v) => (this.properties.remote_dir = v));
      this.addWidget("text", "文件名前缀", this.properties.prefix, (v) => (this.properties.prefix = v));
      this.size = [300, 110];
    }

    function LoopStartNode() {
      this.title = "循环开始节点";
      this.properties = {
        loop_count: 5,
        loop_start_wait_sec: 0.6,
      };
      makeIO(this, true);
      this.addWidget("number", "循环次数", this.properties.loop_count, (v) => (this.properties.loop_count = Number(v)));
      this.addWidget("number", "每轮开始等待(秒)", this.properties.loop_start_wait_sec, (v) => (this.properties.loop_start_wait_sec = Number(v)));
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
        clear_save_dir: false,
        cleanup_remote: true,
      };
      makeIO(this, true);
      this.addWidget("text", "电脑保存目录", this.properties.save_dir, (v) => (this.properties.save_dir = v));
      this.addWidget("toggle", "执行前清空目录(高风险)", this.properties.clear_save_dir, (v) => {
        const nextVal = !!v;
        if (!nextVal) {
          this.properties.clear_save_dir = false;
          return;
        }
        const yes = window.confirm("开启后将删除保存目录中的历史文件，是否确认开启？");
        this.properties.clear_save_dir = !!yes;
        if (!yes) setStatus("已取消开启“清空目录”");
        else setStatus("风险提示：已开启执行前清空目录");
        if (this.widgets && this.widgets[1]) this.widgets[1].value = this.properties.clear_save_dir;
      });
      this.addWidget("toggle", "清理手机临时图(建议开启)", this.properties.cleanup_remote, (v) => (this.properties.cleanup_remote = !!v));
      this.size = [320, 140];
    }

    function OCRNode() {
      this.title = "文字识别节点";
      this.properties = {
        languages: "ch_sim,en",
        gpu: false,
        image_dir: "",
        regions: JSON.stringify(
          [
            { name: "姓名", x: 250, y: 870, w: 830, h: 980 },
            { name: "手机号", x: 60, y: 1050, w: 445, h: 1130 },
          ],
          null,
          2
        ),
      };
      makeIO(this, true);
      this.addWidget("text", "识别语言", this.properties.languages, (v) => (this.properties.languages = v));
      this.addWidget("toggle", "启用显卡加速", this.properties.gpu, (v) => (this.properties.gpu = !!v));
      this.addWidget("text", "图片文件夹", this.properties.image_dir, (v) => (this.properties.image_dir = v));
      this.addWidget("button", "打开图片文件位置", "", () => openOcrImageLocation(this));
      this.addWidget("button", "编辑识别区域(多行)", "", () => openRegionsEditor(this));
      this.__regionsPreviewWidget = this.addWidget("text", "区域摘要", buildRegionsPreview(this.properties.regions), () => {});
      this.size = [360, 210];
    }

    function ExcelNode() {
      this.title = "导出表格节点";
      this.properties = {
        output_path: "outputs/docs/ocr_result.xlsx",
        append_mode: false,
        dedup_keys: ["图片"],
      };
      makeIO(this, true);
      this.addWidget("text", "导出文件路径", this.properties.output_path, (v) => (this.properties.output_path = v));
      this.addWidget("toggle", "增量导出", this.properties.append_mode, (v) => (this.properties.append_mode = !!v));
      this.addWidget("button", "选择去重键", "", () => openDedupKeysEditor(this));
      this.__dedupPreviewWidget = this.addWidget("text", "去重键摘要", buildDedupKeysPreview(this.properties.dedup_keys), () => {});
      this.addWidget("button", "打开文件所在位置", "", () => openExcelOutputLocation(this));
      this.size = [360, 170];
    }

    function PreviewNode() {
      this.title = "展示结果节点";
      this.properties = { max_rows: 10 };
      makeIO(this, true);
      this.addWidget("number", "展示条数", this.properties.max_rows, (v) => (this.properties.max_rows = Number(v)));
      this.size = [240, 90];
    }

    function ImagePreviewNode() {
      this.title = "图片预览节点";
      this.properties = { folder_dir: "", max_images: 12 };
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
      this.addWidget("text", "图片文件夹", this.properties.folder_dir, (v) => (this.properties.folder_dir = v));
      this.addWidget("number", "展示张数", this.properties.max_images, (v) => (this.properties.max_images = Number(v)));
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
    LiteGraph.registerNodeType("节点/输入", InputNode);
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
  }

  root.nodeFactory = {
    createMappings,
    registerBuiltinNodes,
  };
})();
