(function () {
  const root = (window.ADBModules = window.ADBModules || {});

  async function fetchJson(url, options) {
    const res = await fetch(url, options);
    let data = {};
    try {
      data = await res.json();
    } catch (_err) {
      data = {};
    }
    if (!res.ok || !data.ok) {
      const msg = data && data.error ? String(data.error) : `请求失败（HTTP ${res.status}）`;
      throw new Error(msg);
    }
    return data;
  }

  function normalizeResult(data) {
    return {
      workflow: data.workflow || {},
      migration_warnings: Array.isArray(data.migration_warnings) ? data.migration_warnings : [],
      path: String(data.path || ""),
      name: String(data.name || ""),
    };
  }

  async function loadWorkflowByUrl(url) {
    const data = await fetchJson(url);
    return normalizeResult(data);
  }

  async function normalizeWorkflow(workflow) {
    const data = await fetchJson("/api/workflow/normalize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workflow }),
    });
    return normalizeResult(data);
  }

  async function listWorkflows() {
    const data = await fetchJson("/api/workflows");
    return {
      dir: String(data.dir || "workflows"),
      files: Array.isArray(data.files) ? data.files : [],
    };
  }

  root.workflowService = {
    fetchJson,
    loadWorkflowByUrl,
    normalizeWorkflow,
    listWorkflows,
  };
})();

