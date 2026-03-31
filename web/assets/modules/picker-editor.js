(function () {
  const root = (window.ADBModules = window.ADBModules || {});

  function createPickerEditor(deps) {
    const {
      graph,
      classMap,
      tapPicker,
      swipePicker,
      markCanvasDirty,
      setStatus,
      log,
      directionValueToLabel,
      modalController,
    } = deps || {};

    let tapPickerReady = false;
    let swipePickerReady = false;

    function findPreferredDeviceId() {
      const nodes = graph && graph._nodes ? graph._nodes : [];
      const startNodes = nodes.filter((n) => n && classMap[n.type] === "StartDevice");
      for (const node of startNodes) {
        const deviceId = String((node.properties && node.properties.device_id) || "").trim();
        if (deviceId) return deviceId;
      }
      return "";
    }

    function ensureTapPickerReady() {
      if (tapPickerReady) return;
      tapPickerReady = true;
      const fileInput = document.getElementById("tap-picker-file");
      const canvasEl = document.getElementById("tap-picker-canvas");
      if (fileInput) fileInput.addEventListener("change", onTapPickerFileChange);
      if (canvasEl) canvasEl.addEventListener("click", onTapPickerCanvasClick);
      window.addEventListener("resize", () => {
        const open = modalController
          ? modalController.isOpen("tap-picker-modal")
          : (() => {
              const m = document.getElementById("tap-picker-modal");
              return !!(m && !m.classList.contains("hidden"));
            })();
        if (!open) return;
        resizeTapPickerCanvas();
        drawTapPickerCanvas();
      });
    }

    async function cleanupTapPickerCapturedImage() {
      const token = String(tapPicker.tempCaptureToken || "").trim();
      tapPicker.tempCaptureToken = "";
      if (!token) return;
      try {
        await fetch("/api/tap-picker/cleanup-screen", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
      } catch (_err) {
      }
    }

    function openTapPicker(node) {
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
      if (modalController) modalController.open("tap-picker-modal");
      else {
        const modal = document.getElementById("tap-picker-modal");
        if (modal) modal.classList.remove("hidden");
      }
      resizeTapPickerCanvas();
      drawTapPickerCanvas();
      if (typeof setStatus === "function") setStatus("请上传图片或捕捉手机屏幕，然后点击目标位置获取 x,y 坐标");
    }

    async function closeTapPicker() {
      await cleanupTapPickerCapturedImage();
      tapPicker.image = null;
      tapPicker.imageName = "";
      if (modalController) modalController.close("tap-picker-modal");
      else {
        const modal = document.getElementById("tap-picker-modal");
        if (modal) modal.classList.add("hidden");
      }
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
          if (typeof setStatus === "function") setStatus("图片已加载，点击图片选择坐标");
        };
        img.src = String(reader.result || "");
      };
      reader.readAsDataURL(file);
    }

    async function captureTapPickerScreen() {
      try {
        if (typeof setStatus === "function") setStatus("正在捕捉手机屏幕...");
        const deviceId = findPreferredDeviceId();
        const res = await fetch("/api/tap-picker/capture-screen", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ device_id: deviceId }),
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
        if (typeof setStatus === "function") setStatus("已捕捉手机屏幕，请点击图片选择坐标");
      } catch (err) {
        if (typeof log === "function") log("捕捉手机屏幕失败: " + err.message);
        if (typeof setStatus === "function") setStatus("捕捉手机屏幕失败");
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
      if (x < 0 || y < 0 || x > tapPicker.image.width || y > tapPicker.image.height) return null;
      return { x: Math.max(0, Math.min(tapPicker.image.width, x)), y: Math.max(0, Math.min(tapPicker.image.height, y)) };
    }

    function onTapPickerCanvasClick(event) {
      if (!tapPicker.image) return;
      const p = tapPickerCanvasToImagePoint(event);
      if (!p) {
        if (typeof setStatus === "function") setStatus("请点击图片内容区域");
        return;
      }
      tapPicker.selectedX = Math.round(p.x);
      tapPicker.selectedY = Math.round(p.y);
      updateTapPickerPointInfo();
      drawTapPickerCanvas();
      if (typeof setStatus === "function") setStatus(`已选取坐标 (${tapPicker.selectedX}, ${tapPicker.selectedY})`);
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
      if (!tapPicker.node) {
        closeTapPicker();
        return;
      }
      if (!Number.isFinite(tapPicker.selectedX) || !Number.isFinite(tapPicker.selectedY)) {
        if (typeof setStatus === "function") setStatus("请先在图片上点击选点");
        return;
      }
      tapPicker.node.properties.x = Math.round(tapPicker.selectedX);
      tapPicker.node.properties.y = Math.round(tapPicker.selectedY);
      const widgets = tapPicker.node.widgets || [];
      const wx = widgets.find((w) => String((w && w.name) || "") === "横坐标");
      const wy = widgets.find((w) => String((w && w.name) || "") === "纵坐标");
      if (wx) wx.value = tapPicker.node.properties.x;
      else if (widgets[0]) widgets[0].value = tapPicker.node.properties.x;
      if (wy) wy.value = tapPicker.node.properties.y;
      else if (widgets[1]) widgets[1].value = tapPicker.node.properties.y;
      if (typeof markCanvasDirty === "function") markCanvasDirty();
      if (typeof setStatus === "function") setStatus(`已写入点击坐标 (${tapPicker.node.properties.x}, ${tapPicker.node.properties.y})`);
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
        const open = modalController
          ? modalController.isOpen("swipe-picker-modal")
          : (() => {
              const m = document.getElementById("swipe-picker-modal");
              return !!(m && !m.classList.contains("hidden"));
            })();
        if (!open) return;
        resizeSwipePickerCanvas();
        drawSwipePickerCanvas();
      });
    }

    async function cleanupSwipePickerCapturedImage() {
      const token = String(swipePicker.tempCaptureToken || "").trim();
      swipePicker.tempCaptureToken = "";
      if (!token) return;
      try {
        await fetch("/api/tap-picker/cleanup-screen", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
      } catch (_err) {
      }
    }

    function openSwipePicker(node) {
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
      if (modalController) modalController.open("swipe-picker-modal");
      else {
        const modal = document.getElementById("swipe-picker-modal");
        if (modal) modal.classList.remove("hidden");
      }
      updateSwipePickerInfo();
      resizeSwipePickerCanvas();
      drawSwipePickerCanvas();
      if (typeof setStatus === "function") setStatus("请上传截图或捕捉手机屏幕，依次点击起点和终点");
    }

    async function closeSwipePicker() {
      await cleanupSwipePickerCapturedImage();
      swipePicker.image = null;
      swipePicker.imageName = "";
      if (modalController) modalController.close("swipe-picker-modal");
      else {
        const modal = document.getElementById("swipe-picker-modal");
        if (modal) modal.classList.add("hidden");
      }
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

    async function captureSwipePickerScreen() {
      try {
        if (typeof setStatus === "function") setStatus("正在捕捉手机屏幕...");
        const deviceId = findPreferredDeviceId();
        const res = await fetch("/api/tap-picker/capture-screen", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ device_id: deviceId }),
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
        if (typeof setStatus === "function") setStatus("已捕捉手机屏幕，请依次点击起点和终点");
      } catch (err) {
        if (typeof log === "function") log("捕捉手机屏幕失败: " + err.message);
        if (typeof setStatus === "function") setStatus("捕捉手机屏幕失败");
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
      if (!swipePicker.node) return;
      if (!Number.isFinite(swipePicker.startX) || !Number.isFinite(swipePicker.startY) ||
          !Number.isFinite(swipePicker.endX) || !Number.isFinite(swipePicker.endY)) {
        if (typeof setStatus === "function") setStatus("请先选择起点和终点");
        return;
      }
      const dy = swipePicker.endY - swipePicker.startY;
      const direction = dy >= 0 ? "down" : "up";
      const distancePx = Math.max(1, Math.round(Math.abs(dy)));
      const widgets = swipePicker.node.widgets || [];
      swipePicker.node.properties.direction = direction;
      swipePicker.node.properties.distance_px = distancePx;
      swipePicker.node.properties.x = swipePicker.startX;
      swipePicker.node.properties.y = swipePicker.startY;
      const wDirection = widgets.find((w) => String((w && w.name) || "") === "滑动方向");
      const wDistance = widgets.find((w) => String((w && w.name) || "") === "滑动像素");
      const wX = widgets.find((w) => String((w && w.name) || "") === "起点X(可选)");
      const wY = widgets.find((w) => String((w && w.name) || "") === "起点Y(可选)");
      if (wDirection) wDirection.value = directionValueToLabel(direction);
      else if (widgets[0]) widgets[0].value = directionValueToLabel(direction);
      if (wDistance) wDistance.value = distancePx;
      else if (widgets[2]) widgets[2].value = distancePx;
      if (wX) wX.value = String(swipePicker.startX);
      if (wY) wY.value = String(swipePicker.startY);
      if (typeof markCanvasDirty === "function") markCanvasDirty();
      if (typeof setStatus === "function") {
        setStatus(`已写入滑动配置：方向=${directionValueToLabel(direction)}，像素=${distancePx}`);
      }
      closeSwipePicker();
    }

    return {
      openTapPicker,
      closeTapPicker,
      captureTapPickerScreen,
      applyTapPickerPoint,
      openSwipePicker,
      closeSwipePicker,
      captureSwipePickerScreen,
      resetSwipePickerPoints,
      applySwipePickerPoints,
    };
  }

  root.pickerEditor = {
    createPickerEditor,
  };
})();
