(function () {
  const root = (window.ADBModules = window.ADBModules || {});

  function createPreviewRenderer(deps) {
    const {
      clearPreviewTable,
      getMetaElement,
      getBodyElement,
    } = deps || {};

    function hasImagePreviewOutput(outputs) {
      const nodeIds = Object.keys(outputs || {});
      for (const nodeId of nodeIds) {
        const payload = outputs[nodeId];
        if (!payload || typeof payload !== "object") continue;
        if (Array.isArray(payload.preview_images)) return true;
      }
      return false;
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

    function renderPreviewTable(outputs) {
      const preview = pickPreviewOutput(outputs);
      if (!preview) {
        if (hasImagePreviewOutput(outputs)) {
          if (typeof clearPreviewTable === "function") clearPreviewTable("结果预览：图片已在图片预览节点中显示");
        } else {
          if (typeof clearPreviewTable === "function") clearPreviewTable("结果预览：未检测到展示结果节点输出");
        }
        return;
      }

      const columns = Array.isArray(preview.preview_columns) ? preview.preview_columns : [];
      const rows = Array.isArray(preview.preview_rows) ? preview.preview_rows : [];
      const total = Number(preview.preview_total_rows || rows.length || 0);
      const limit = Number(preview.preview_limit || rows.length || 10);

      const meta = typeof getMetaElement === "function" ? getMetaElement() : null;
      const body = typeof getBodyElement === "function" ? getBodyElement() : null;
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

    return {
      hasImagePreviewOutput,
      pickPreviewOutput,
      renderPreviewTable,
    };
  }

  root.previewRenderer = {
    createPreviewRenderer,
  };
})();
