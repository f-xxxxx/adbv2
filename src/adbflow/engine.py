from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .adb_client import ADBClient
from .nodes import NODE_REGISTRY, NodeContext, NodeExecutionError


class WorkflowFormatError(ValueError):
    pass


@dataclass
class ExecutionResult:
    outputs: dict[str, Any]
    logs: list[str]


class WorkflowEngine:
    """
    ComfyUI-like workflow executor.

    Workflow format:
    {
      "1": {"class_type": "StartDevice", "inputs": {"device_id": ""}},
      "2": {"class_type": "Tap", "inputs": {"input": ["1", 0], "x": 500, "y": 1200}}
    }
    """

    def __init__(self, adb: ADBClient | None = None) -> None:
        self.adb = adb or ADBClient()

    def run(self, workflow: dict[str, Any]) -> ExecutionResult:
        if not isinstance(workflow, dict) or not workflow:
            raise WorkflowFormatError("工作流必须是非空对象")

        logs: list[str] = []
        ctx = NodeContext(adb=self.adb, logs=logs)
        cache: dict[tuple[str, int], Any] = {}
        visiting: set[str] = set()

        for node_id in self._node_ids(workflow):
            self._evaluate_node(node_id, workflow, cache, visiting, ctx)

        final_outputs = {
            node_id: cache.get((node_id, 0))
            for node_id in self._node_ids(workflow)
            if (node_id, 0) in cache
        }
        return ExecutionResult(outputs=final_outputs, logs=logs)

    def _evaluate_node(
        self,
        node_id: str,
        workflow: dict[str, Any],
        cache: dict[tuple[str, int], Any],
        visiting: set[str],
        ctx: NodeContext,
    ) -> Any:
        key = (node_id, 0)
        if key in cache:
            return cache[key]
        if node_id in visiting:
            raise WorkflowFormatError(f"检测到循环依赖，节点：{node_id}")

        node = workflow.get(node_id)
        if not isinstance(node, dict):
            raise WorkflowFormatError(f"节点 {node_id} 配置无效")

        class_type = str(node.get("class_type", "")).strip()
        display_type = _class_type_display_name(class_type)
        if class_type not in NODE_REGISTRY:
            raise WorkflowFormatError(f"节点 {node_id} 的节点类型不支持：`{class_type}`")

        raw_inputs = node.get("inputs", {})
        if not isinstance(raw_inputs, dict):
            raise WorkflowFormatError(f"节点 {node_id}.inputs 必须是对象")

        visiting.add(node_id)
        resolved_inputs: dict[str, Any] = {}
        for input_name, value in raw_inputs.items():
            resolved_inputs[input_name] = self._resolve_value(
                value=value,
                workflow=workflow,
                cache=cache,
                visiting=visiting,
                ctx=ctx,
            )

        node_impl = NODE_REGISTRY[class_type]()
        ctx.log(f"[节点 {node_id}] 类型={display_type}，开始执行")
        try:
            output = node_impl.run(resolved_inputs, ctx)
        except (NodeExecutionError, Exception) as exc:
            raise NodeExecutionError(f"节点 {node_id}（{display_type}）执行失败：{exc}") from exc
        ctx.log(f"[节点 {node_id}] 类型={display_type}，执行完成")

        cache[key] = output
        visiting.remove(node_id)
        return output

    def _resolve_value(
        self,
        value: Any,
        workflow: dict[str, Any],
        cache: dict[tuple[str, int], Any],
        visiting: set[str],
        ctx: NodeContext,
    ) -> Any:
        # Reference style: ["node_id", output_index]
        if (
            isinstance(value, list)
            and len(value) == 2
            and isinstance(value[1], int)
            and isinstance(value[0], (str, int))
        ):
            ref_node_id = str(value[0])
            ref_output_idx = int(value[1])
            if ref_output_idx != 0:
                raise WorkflowFormatError("当前仅支持输出索引 0")
            ref_value = self._evaluate_node(ref_node_id, workflow, cache, visiting, ctx)
            return ref_value

        if isinstance(value, list):
            return [
                self._resolve_value(
                    value=item,
                    workflow=workflow,
                    cache=cache,
                    visiting=visiting,
                    ctx=ctx,
                )
                for item in value
            ]
        if isinstance(value, dict):
            return {
                k: self._resolve_value(
                    value=v,
                    workflow=workflow,
                    cache=cache,
                    visiting=visiting,
                    ctx=ctx,
                )
                for k, v in value.items()
            }
        return value

    @staticmethod
    def _node_ids(workflow: dict[str, Any]) -> list[str]:
        # Keep deterministic order. Numeric-like keys first by int value.
        def _key(k: str) -> tuple[int, str]:
            return (int(k), k) if k.isdigit() else (10**9, k)

        return sorted(workflow.keys(), key=_key)


def _class_type_display_name(class_type: str) -> str:
    mapping = {
        "StartDevice": "开始节点",
        "Tap": "点击节点",
        "Swipe": "滑动节点",
        "Wait": "等待节点",
        "Screenshot": "截图节点",
        "LoopSequence": "循环序列节点",
        "PullToPC": "回传节点",
        "EasyOCR": "文字识别节点",
        "ExportExcel": "导出表格节点",
        "PreviewExcel": "展示结果节点",
        "PreviewImages": "图片预览节点",
    }
    return mapping.get(class_type, class_type)
