(function () {
  const root = (window.ADBModules = window.ADBModules || {});

  function createOcrRegionEditor(deps) {
    const {
      regionHelper,
      markCanvasDirty,
      setStatus,
      modalController,
      getCurrentNode,
      setCurrentNode,
    } = deps || {};

    let regionHelperReady = false;

    function parseFlexibleJson(text) {
      const raw = String(text || "").trim();
      if (!raw) return [];
      try {
        return JSON.parse(raw);
      } catch (_jsonErr) {
        // 兼容常见输入：单引号、尾逗号、中文标点。
        const normalized = raw
          .replace(/，/g, ",")
          .replace(/：/g, ":")
          .replace(/'/g, "\"")
          .replace(/,\s*([}\]])/g, "$1");
        return JSON.parse(normalized);
      }
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

    function parseRegionsFromText(text) {
      if (!text || !String(text).trim()) return [];
      try {
        const parsed = parseFlexibleJson(String(text));
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
            h: Math.round(h),
          });
        }
        return result;
      } catch (_err) {
        return [];
      }
    }

    function parseRegionNamesFromRaw(raw) {
      let parsed = [];
      if (Array.isArray(raw)) {
        parsed = raw;
      } else if (typeof raw === "string" && raw.trim()) {
        try {
          const x = parseFlexibleJson(raw);
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

    function syncOcrRegionsPreview(node) {
      if (!node || !node.__regionsPreviewWidget) return;
      node.__regionsPreviewWidget.value = buildRegionsPreview(node.properties.regions);
      if (typeof markCanvasDirty === "function") markCanvasDirty();
    }

    function openEditor(node) {
      if (typeof setCurrentNode === "function") setCurrentNode(node);
      const textarea = document.getElementById("regions-textarea");
      if (textarea) {
        textarea.value = normalizeRegionsText(node && node.properties ? node.properties.regions : "");
        setTimeout(() => textarea.focus(), 0);
      }
      if (modalController) modalController.open("regions-modal");
      else {
        const modal = document.getElementById("regions-modal");
        if (modal) modal.classList.remove("hidden");
      }
    }

    function closeEditor() {
      closeHelper();
      if (typeof setCurrentNode === "function") setCurrentNode(null);
      if (modalController) modalController.close("regions-modal");
      else {
        const modal = document.getElementById("regions-modal");
        if (modal) modal.classList.add("hidden");
      }
    }

    function formatEditor() {
      const textarea = document.getElementById("regions-textarea");
      if (!textarea) return;
      const text = String(textarea.value || "").trim();
      if (!text) {
        textarea.value = "[]";
        return;
      }
      try {
        const parsed = parseFlexibleJson(text);
        textarea.value = JSON.stringify(parsed, null, 2);
        if (typeof setStatus === "function") setStatus("识别区域配置已格式化");
      } catch (_err) {
        if (typeof setStatus === "function") setStatus("识别区域配置不是合法 JSON，无法格式化");
      }
    }

    function saveEditor() {
      const node = typeof getCurrentNode === "function" ? getCurrentNode() : null;
      if (!node) {
        closeEditor();
        return;
      }
      const textarea = document.getElementById("regions-textarea");
      node.properties.regions = String((textarea && textarea.value) || "");
      syncOcrRegionsPreview(node);
      if (typeof setStatus === "function") setStatus("识别区域配置已保存");
      closeEditor();
    }

    function ensureHelperReady() {
      if (regionHelperReady) return;
      regionHelperReady = true;
      const fileInput = document.getElementById("region-helper-file");
      const canvasEl = document.getElementById("region-helper-canvas");
      if (fileInput) fileInput.addEventListener("change", onHelperFileChange);
      if (canvasEl) {
        canvasEl.addEventListener("mousedown", onHelperMouseDown);
        canvasEl.addEventListener("mousemove", onHelperMouseMove);
      }
      window.addEventListener("mouseup", onHelperMouseUp);
      window.addEventListener("resize", () => {
        const open = modalController
          ? modalController.isOpen("region-helper-modal")
          : (() => {
              const m = document.getElementById("region-helper-modal");
              return !!(m && !m.classList.contains("hidden"));
            })();
        if (open) {
          resizeHelperCanvas();
          drawHelperCanvas();
        }
      });
    }

    function openHelper() {
      ensureHelperReady();
      const textarea = document.getElementById("regions-textarea");
      if (modalController) modalController.open("region-helper-modal");
      else {
        const modal = document.getElementById("region-helper-modal");
        if (modal) modal.classList.remove("hidden");
      }
      regionHelper.rects = parseRegionsFromText(String((textarea && textarea.value) || ""));
      regionHelper.activeIndex = regionHelper.rects.length ? 0 : -1;
      updateHelperImageInfo();
      renderHelperList();
      resizeHelperCanvas();
      drawHelperCanvas();
    }

    function closeHelper() {
      if (modalController) modalController.close("region-helper-modal");
      else {
        const modal = document.getElementById("region-helper-modal");
        if (modal) modal.classList.add("hidden");
      }
      regionHelper.drawing = false;
      regionHelper.tempRect = null;
      drawHelperCanvas();
    }

    function onHelperFileChange(event) {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          regionHelper.image = img;
          regionHelper.imageName = file.name || "";
          resizeHelperCanvas();
          drawHelperCanvas();
          updateHelperImageInfo();
          if (typeof setStatus === "function") setStatus("截图已加载，可开始框选区域");
        };
        img.src = String(reader.result || "");
      };
      reader.readAsDataURL(file);
    }

    function resizeHelperCanvas() {
      const canvasEl = document.getElementById("region-helper-canvas");
      if (!canvasEl) return;
      const rect = canvasEl.getBoundingClientRect();
      const nextW = Math.max(360, Math.floor(rect.width));
      const nextH = Math.max(320, Math.floor(rect.height));
      if (canvasEl.width !== nextW) canvasEl.width = nextW;
      if (canvasEl.height !== nextH) canvasEl.height = nextH;
      computeHelperImageLayout();
    }

    function computeHelperImageLayout() {
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

    function drawHelperCanvas() {
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

      computeHelperImageLayout();
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

    function helperCanvasToImagePoint(event) {
      const canvasEl = document.getElementById("region-helper-canvas");
      if (!canvasEl || !regionHelper.image) return null;
      const rect = canvasEl.getBoundingClientRect();
      const cx = event.clientX - rect.left;
      const cy = event.clientY - rect.top;
      const x = (cx - regionHelper.offsetX) / regionHelper.scale;
      const y = (cy - regionHelper.offsetY) / regionHelper.scale;
      if (x < 0 || y < 0 || x > regionHelper.image.width || y > regionHelper.image.height) return null;
      return {
        x: Math.max(0, Math.min(regionHelper.image.width, x)),
        y: Math.max(0, Math.min(regionHelper.image.height, y)),
      };
    }

    function onHelperMouseDown(event) {
      if (!regionHelper.image) return;
      const p = helperCanvasToImagePoint(event);
      if (!p) return;
      regionHelper.drawing = true;
      regionHelper.startX = p.x;
      regionHelper.startY = p.y;
      regionHelper.tempRect = { name: `区域${regionHelper.rects.length + 1}`, x: p.x, y: p.y, w: 0, h: 0 };
      drawHelperCanvas();
    }

    function onHelperMouseMove(event) {
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
        h: Math.round(h),
      };
      drawHelperCanvas();
    }

    function onHelperMouseUp() {
      if (!regionHelper.drawing) return;
      regionHelper.drawing = false;
      const rect = regionHelper.tempRect;
      regionHelper.tempRect = null;
      if (rect && rect.w >= 2 && rect.h >= 2) {
        regionHelper.rects.push(rect);
        regionHelper.activeIndex = regionHelper.rects.length - 1;
        renderHelperList();
      }
      drawHelperCanvas();
    }

    function renderHelperList() {
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
          renderHelperList();
          drawHelperCanvas();
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
          renderHelperList();
          drawHelperCanvas();
        });
        rowTop.appendChild(delBtn);
        item.appendChild(rowTop);

        const nameInput = document.createElement("input");
        nameInput.value = rect.name || `区域${index + 1}`;
        nameInput.addEventListener("input", () => {
          rect.name = nameInput.value;
          drawHelperCanvas();
        });
        item.appendChild(nameInput);

        const info = document.createElement("div");
        info.textContent = `x:${Math.round(rect.x)} y:${Math.round(rect.y)} w:${Math.round(rect.w)} h:${Math.round(rect.h)}`;
        info.style.color = "#b7c0cf";
        item.appendChild(info);

        list.appendChild(item);
      });
    }

    function clearHelperRects() {
      regionHelper.rects = [];
      regionHelper.activeIndex = -1;
      renderHelperList();
      drawHelperCanvas();
      if (typeof setStatus === "function") setStatus("已清空选区");
    }

    function applyHelperToEditor() {
      const textarea = document.getElementById("regions-textarea");
      if (!textarea) return;
      const payload = regionHelper.rects.map((rect, idx) => ({
        name: String(rect.name || `区域${idx + 1}`),
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.w),
        h: Math.round(rect.h),
      }));
      textarea.value = JSON.stringify(payload, null, 2);
      if (typeof setStatus === "function") setStatus(`已写入 ${payload.length} 个识别区域`);
      closeHelper();
    }

    function updateHelperImageInfo() {
      const el = document.getElementById("helper-image-info");
      if (!el) return;
      if (!regionHelper.image) {
        el.textContent = "请先上传截图，然后在图上拖拽框选";
        return;
      }
      el.textContent = `${regionHelper.imageName || "已上传图片"} (${regionHelper.image.width} x ${regionHelper.image.height})`;
    }

    return {
      normalizeRegionsText,
      buildRegionsPreview,
      parseRegionsFromText,
      parseRegionNamesFromRaw,
      syncOcrRegionsPreview,
      openEditor,
      closeEditor,
      formatEditor,
      saveEditor,
      openHelper,
      closeHelper,
      clearHelperRects,
      applyHelperToEditor,
    };
  }

  root.ocrRegionEditor = {
    createOcrRegionEditor,
  };
})();
