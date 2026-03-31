(function () {
  const root = (window.ADBModules = window.ADBModules || {});

  async function parseNdjsonStream(res, handlers) {
    const onLog = typeof handlers?.onLog === "function" ? handlers.onLog : () => {};
    const onEvent = typeof handlers?.onEvent === "function" ? handlers.onEvent : () => {};
    const onResult = typeof handlers?.onResult === "function" ? handlers.onResult : () => {};

    if (!res.body || typeof res.body.getReader !== "function") {
      throw new Error("浏览器不支持流式执行");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let finalResult = null;

    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });

        let nl = buffer.indexOf("\n");
        while (nl >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line) {
            const msg = JSON.parse(line);
            if (msg.type === "log") onLog(String(msg.line || ""));
            else if (msg.type === "event") onEvent(msg);
            else if (msg.type === "error") throw new Error(String(msg.error || "执行失败"));
            else if (msg.type === "result") {
              finalResult = {
                outputs: msg.outputs || {},
                logs: msg.logs || [],
                report_path: msg.report_path || "",
                run_id: msg.run_id || "",
                migration_warnings: Array.isArray(msg.migration_warnings) ? msg.migration_warnings : [],
              };
              onResult(finalResult);
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
            logs: msg.logs || [],
            report_path: msg.report_path || "",
            run_id: msg.run_id || "",
            migration_warnings: Array.isArray(msg.migration_warnings) ? msg.migration_warnings : [],
          };
          onResult(finalResult);
        }
      }
      if (!finalResult) throw new Error("执行流未返回结果");
      return finalResult;
    } finally {
      try {
        await reader.cancel();
      } catch (_err) {}
    }
  }

  root.runControl = {
    parseNdjsonStream,
  };
})();
