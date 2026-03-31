(function () {
  const root = (window.ADBModules = window.ADBModules || {});

  function createDedupKeysEditor(deps) {
    const {
      graph,
      classMap,
      markCanvasDirty,
      setStatus,
      modalController,
      getCurrentNode,
      setCurrentNode,
      parseRegionNamesFromRaw,
    } = deps || {};

    function normalizeDedupKeysValue(value) {
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
      const keys = normalizeDedupKeysValue(value);
      const text = keys.join(", ");
      if (text.length <= 30) return text;
      return text.slice(0, 30) + "...";
    }

    function normalizeInvalidDataKeyValue(value) {
      return String(value || "").trim();
    }

    function buildInvalidDataKeyPreview(value) {
      const key = normalizeInvalidDataKeyValue(value);
      return key || "未设置";
    }

    function syncExportDedupPreview(node) {
      if (!node) return;
      node.properties.dedup_keys = normalizeDedupKeysValue(node.properties.dedup_keys);
      if (!node.__dedupPreviewWidget) return;
      node.__dedupPreviewWidget.value = buildDedupKeysPreview(node.properties.dedup_keys);
      if (typeof markCanvasDirty === "function") markCanvasDirty();
    }

    function syncExportInvalidDataKeyPreview(node) {
      if (!node) return;
      node.properties.invalid_data_key = normalizeInvalidDataKeyValue(node.properties.invalid_data_key);
      if (!node.__invalidDataKeyPreviewWidget) return;
      node.__invalidDataKeyPreviewWidget.value = buildInvalidDataKeyPreview(node.properties.invalid_data_key);
      if (typeof markCanvasDirty === "function") markCanvasDirty();
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
        if (classMap[node.type] === "EasyOCR") return node;
        const prev = getInputNodeSafe(node, 0);
        if (prev) queue.push(prev);
      }
      return null;
    }

    function collectDedupCandidateKeys(exportNode) {
      const base = ["图片"];
      const ocrNode = findUpstreamOcrNode(exportNode);
      const regionNames = typeof parseRegionNamesFromRaw === "function"
        ? parseRegionNamesFromRaw(ocrNode && ocrNode.properties ? ocrNode.properties.regions : "")
        : [];
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

    function collectInvalidDataCandidateKeys(exportNode) {
      const ocrNode = findUpstreamOcrNode(exportNode);
      const regionNames = typeof parseRegionNamesFromRaw === "function"
        ? parseRegionNamesFromRaw(ocrNode && ocrNode.properties ? ocrNode.properties.regions : "")
        : [];
      const current = normalizeInvalidDataKeyValue(exportNode && exportNode.properties ? exportNode.properties.invalid_data_key : "");
      const all = [...regionNames, current];
      const used = new Set();
      const result = [];
      for (const item of all) {
        const key = String(item || "").trim();
        if (!key || used.has(key)) continue;
        used.add(key);
        result.push(key);
      }
      return result;
    }

    function openEditor(node) {
      if (typeof setCurrentNode === "function") setCurrentNode(node);
      const listEl = document.getElementById("dedup-keys-list");
      if (!listEl) return;
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
      if (modalController) modalController.open("dedup-keys-modal");
      else {
        const modal = document.getElementById("dedup-keys-modal");
        if (modal) modal.classList.remove("hidden");
      }
    }

    function closeEditor() {
      if (typeof setCurrentNode === "function") setCurrentNode(null);
      if (modalController) modalController.close("dedup-keys-modal");
      else {
        const modal = document.getElementById("dedup-keys-modal");
        if (modal) modal.classList.add("hidden");
      }
    }

    function openInvalidDataKeyEditor(node) {
      if (typeof setCurrentNode === "function") setCurrentNode(node);
      const listEl = document.getElementById("invalid-data-key-list");
      if (!listEl) return;
      const candidates = collectInvalidDataCandidateKeys(node);
      const selected = normalizeInvalidDataKeyValue(node && node.properties ? node.properties.invalid_data_key : "");
      listEl.innerHTML = "";
      if (!candidates.length) {
        const empty = document.createElement("div");
        empty.className = "workflow-empty";
        empty.textContent = "未找到可选 OCR 区域名，请先连接并配置文字识别节点区域。";
        listEl.appendChild(empty);
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
      if (modalController) modalController.open("invalid-data-key-modal");
      else {
        const modal = document.getElementById("invalid-data-key-modal");
        if (modal) modal.classList.remove("hidden");
      }
    }

    function closeInvalidDataKeyEditor() {
      if (typeof setCurrentNode === "function") setCurrentNode(null);
      if (modalController) modalController.close("invalid-data-key-modal");
      else {
        const modal = document.getElementById("invalid-data-key-modal");
        if (modal) modal.classList.add("hidden");
      }
    }

    function clearInvalidDataKeySelection() {
      const listEl = document.getElementById("invalid-data-key-list");
      if (!listEl) return;
      listEl.querySelectorAll("input[type=radio]").forEach((el) => {
        el.checked = false;
      });
    }

    function saveInvalidDataKeyEditor() {
      const node = typeof getCurrentNode === "function" ? getCurrentNode() : null;
      if (!node) {
        closeInvalidDataKeyEditor();
        return;
      }
      const listEl = document.getElementById("invalid-data-key-list");
      if (!listEl) {
        closeInvalidDataKeyEditor();
        return;
      }
      const selected = listEl.querySelector("input[type=radio]:checked");
      node.properties.invalid_data_key = selected ? String(selected.value || "").trim() : "";
      syncExportInvalidDataKeyPreview(node);
      if (typeof setStatus === "function") {
        setStatus(
          node.properties.invalid_data_key
            ? `无效数据主键已设置: ${node.properties.invalid_data_key}`
            : "无效数据主键已清空"
        );
      }
      closeInvalidDataKeyEditor();
    }

    function selectAll() {
      const listEl = document.getElementById("dedup-keys-list");
      if (!listEl) return;
      listEl.querySelectorAll("input[type=checkbox]").forEach((el) => {
        el.checked = true;
      });
    }

    function clearSelection() {
      const listEl = document.getElementById("dedup-keys-list");
      if (!listEl) return;
      listEl.querySelectorAll("input[type=checkbox]").forEach((el) => {
        el.checked = false;
      });
    }

    function saveEditor() {
      const node = typeof getCurrentNode === "function" ? getCurrentNode() : null;
      if (!node) {
        closeEditor();
        return;
      }
      const listEl = document.getElementById("dedup-keys-list");
      if (!listEl) {
        closeEditor();
        return;
      }
      const keys = [];
      listEl.querySelectorAll("input[type=checkbox]").forEach((el) => {
        if (el.checked) keys.push(String(el.value || "").trim());
      });
      node.properties.dedup_keys = keys.length ? keys : ["图片"];
      syncExportDedupPreview(node);
      if (typeof setStatus === "function") {
        setStatus(`去重键已更新: ${node.properties.dedup_keys.join(", ")}`);
      }
      closeEditor();
    }

    return {
      normalizeDedupKeysValue,
      buildDedupKeysPreview,
      syncExportDedupPreview,
      normalizeInvalidDataKeyValue,
      buildInvalidDataKeyPreview,
      syncExportInvalidDataKeyPreview,
      openEditor,
      closeEditor,
      selectAll,
      clearSelection,
      saveEditor,
      openInvalidDataKeyEditor,
      closeInvalidDataKeyEditor,
      clearInvalidDataKeySelection,
      saveInvalidDataKeyEditor,
    };
  }

  root.dedupKeysEditor = {
    createDedupKeysEditor,
  };
})();
