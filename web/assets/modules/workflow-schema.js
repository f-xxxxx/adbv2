(function () {
  const root = (window.ADBModules = window.ADBModules || {});

  function toBool(value, defVal) {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") {
      return ["1", "true", "yes", "y", "on"].includes(value.trim().toLowerCase());
    }
    return !!defVal;
  }

  function toInt(value, defVal) {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? n : Number(defVal || 0);
  }

  function toFloat(value, defVal) {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n : Number(defVal || 0);
  }

  function toNullableNumber(value, defVal) {
    if (value == null || String(value).trim() === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : (defVal == null ? null : Number(defVal));
  }

  function toStrList(value, defVal) {
    if (Array.isArray(value)) {
      const arr = value.map((x) => String(x || "").trim()).filter(Boolean);
      return arr.length ? arr : Array.isArray(defVal) ? defVal.slice() : [];
    }
    const txt = String(value || "").trim();
    if (!txt) return Array.isArray(defVal) ? defVal.slice() : [];
    const arr = txt.split(",").map((x) => x.trim()).filter(Boolean);
    return arr.length ? arr : Array.isArray(defVal) ? defVal.slice() : [];
  }

  function isLink(value) {
    return (
      Array.isArray(value) &&
      value.length === 2 &&
      (typeof value[0] === "string" || typeof value[0] === "number") &&
      Number.isInteger(value[1])
    );
  }

  function coerceByType(value, field) {
    const t = String((field && field.type) || "");
    const d = field ? field.default : null;
    if (t === "str") return String(value || "");
    if (t === "bool") return toBool(value, d);
    if (t === "int") return toInt(value, d);
    if (t === "float") return toFloat(value, d);
    if (t === "nullable_number") return toNullableNumber(value, d);
    if (t === "str_list") return toStrList(value, d);
    if (t === "link") return isLink(value) ? [String(value[0]), Number(value[1])] : null;
    return value;
  }

  function validateAndNormalize(workflow, schema) {
    const errors = [];
    const warnings = [];
    const nextWorkflow = {};
    if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) {
      return { ok: false, errors: ["工作流必须是对象"], warnings, workflow: {} };
    }

    for (const [nodeId, rawNode] of Object.entries(workflow)) {
      if (!rawNode || typeof rawNode !== "object" || Array.isArray(rawNode)) {
        errors.push(`节点 ${nodeId} 配置无效`);
        continue;
      }
      const classType = String(rawNode.class_type || "").trim();
      if (!classType) {
        errors.push(`节点 ${nodeId} 缺少 class_type`);
        continue;
      }
      const rawInputs = rawNode.inputs && typeof rawNode.inputs === "object" ? rawNode.inputs : {};
      const nodeSchema = schema && schema[classType] ? schema[classType] : null;
      if (!nodeSchema) {
        nextWorkflow[String(nodeId)] = { class_type: classType, inputs: { ...rawInputs } };
        continue;
      }

      const fields = nodeSchema.fields && typeof nodeSchema.fields === "object" ? nodeSchema.fields : {};
      const deprecated = Array.isArray(nodeSchema.deprecated_fields) ? nodeSchema.deprecated_fields : [];
      const nextInputs = {};

      for (const [fieldName, fieldSchema] of Object.entries(fields)) {
        if (Object.prototype.hasOwnProperty.call(rawInputs, fieldName)) {
          nextInputs[fieldName] = coerceByType(rawInputs[fieldName], fieldSchema);
        } else if (fieldSchema && Object.prototype.hasOwnProperty.call(fieldSchema, "default")) {
          const defVal = fieldSchema.default;
          if (Array.isArray(defVal)) nextInputs[fieldName] = defVal.slice();
          else if (defVal && typeof defVal === "object") nextInputs[fieldName] = { ...defVal };
          else if (defVal !== null) nextInputs[fieldName] = defVal;
        }
      }

      for (const depName of deprecated) {
        if (Object.prototype.hasOwnProperty.call(rawInputs, depName)) {
          warnings.push(`节点 ${nodeId}（${classType}）移除废弃字段：${depName}`);
        }
      }

      nextWorkflow[String(nodeId)] = { class_type: classType, inputs: nextInputs };
    }

    return { ok: errors.length === 0, errors, warnings, workflow: nextWorkflow };
  }

  root.workflowSchema = {
    validateAndNormalize,
  };
})();
