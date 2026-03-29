from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Callable

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

    def run(
        self,
        workflow: dict[str, Any],
        on_log: Callable[[str], None] | None = None,
        on_event: Callable[[dict[str, Any]], None] | None = None,
    ) -> ExecutionResult:
        if not isinstance(workflow, dict) or not workflow:
            raise WorkflowFormatError("工作流必须是非空对象")

        logs: list[str] = []
        ctx = NodeContext(adb=self.adb, logs=logs, on_log=on_log, on_event=on_event)
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
        try:
            if class_type == "LoopEnd":
                output = self._evaluate_loop_end(
                    node_id=node_id,
                    raw_inputs=raw_inputs,
                    workflow=workflow,
                    cache=cache,
                    visiting=visiting,
                    ctx=ctx,
                )
            else:
                resolved_inputs: dict[str, Any] = {}
                for input_name, value in raw_inputs.items():
                    resolved_inputs[input_name] = self._resolve_value(
                        value=value,
                        workflow=workflow,
                        cache=cache,
                        visiting=visiting,
                        ctx=ctx,
                    )
                output = self._run_node_impl(
                    node_id=node_id,
                    class_type=class_type,
                    display_type=display_type,
                    resolved_inputs=resolved_inputs,
                    ctx=ctx,
                )
        except (NodeExecutionError, Exception) as exc:
            ctx.event(
                "node_error",
                node_id=node_id,
                class_type=class_type,
                display_type=display_type,
                error=str(exc),
            )
            raise NodeExecutionError(f"节点 {node_id}（{display_type}）执行失败：{exc}") from exc
        finally:
            visiting.remove(node_id)

        cache[key] = output
        return output

    def _run_node_impl(
        self,
        node_id: str,
        class_type: str,
        display_type: str,
        resolved_inputs: dict[str, Any],
        ctx: NodeContext,
    ) -> Any:
        node_impl = NODE_REGISTRY[class_type]()
        ctx.event("node_start", node_id=node_id, class_type=class_type, display_type=display_type)
        ctx.log(f"[节点 {node_id}] 类型={display_type}，开始执行")
        output = node_impl.run(resolved_inputs, ctx)
        ctx.log(f"[节点 {node_id}] 类型={display_type}，执行完成")
        ctx.event("node_done", node_id=node_id, class_type=class_type, display_type=display_type)
        return output

    def _evaluate_loop_end(
        self,
        node_id: str,
        raw_inputs: dict[str, Any],
        workflow: dict[str, Any],
        cache: dict[tuple[str, int], Any],
        visiting: set[str],
        ctx: NodeContext,
    ) -> Any:
        loop_start_id = self._find_loop_start_id_for_end(node_id, workflow)
        loop_start_node = workflow.get(loop_start_id) or {}
        loop_start_inputs = loop_start_node.get("inputs") if isinstance(loop_start_node, dict) else {}
        if not isinstance(loop_start_inputs, dict):
            loop_start_inputs = {}

        loop_count = self._as_loop_count(loop_start_inputs.get("loop_count"), default=1)
        loop_start_wait_sec = self._as_nonnegative_float(
            loop_start_inputs.get("loop_start_wait_sec"),
            default=0.0,
        )
        body_node_ids = self._collect_loop_body_node_ids(loop_start_id, node_id, workflow)
        display_type = _class_type_display_name("LoopEnd")

        resolved_inputs: dict[str, Any] = {}
        for input_name, value in raw_inputs.items():
            resolved_inputs[input_name] = self._resolve_value(
                value=value,
                workflow=workflow,
                cache=cache,
                visiting=visiting,
                ctx=ctx,
            )
        loop_state = resolved_inputs.get("input")
        ctx.log(
            f"[循环容器] 区间 {loop_start_id}->{node_id}，循环次数={loop_count}，"
            f"循环节点数={len(body_node_ids)}"
        )

        for iter_index in range(2, loop_count + 1):
            if loop_start_wait_sec > 0:
                time.sleep(loop_start_wait_sec)
            if loop_state is not None:
                cache[(loop_start_id, 0)] = self._with_loop_meta(
                    loop_state,
                    loop_iteration=iter_index,
                    loop_count=loop_count,
                )
            self._clear_cache_for_nodes(cache, body_node_ids)

            resolved_inputs = {}
            for input_name, value in raw_inputs.items():
                resolved_inputs[input_name] = self._resolve_value(
                    value=value,
                    workflow=workflow,
                    cache=cache,
                    visiting=visiting,
                    ctx=ctx,
                )
            loop_state = resolved_inputs.get("input", loop_state)
            ctx.log(f"[循环容器] 第 {iter_index}/{loop_count} 轮执行完成")

        return self._run_node_impl(
            node_id=node_id,
            class_type="LoopEnd",
            display_type=display_type,
            resolved_inputs=resolved_inputs,
            ctx=ctx,
        )

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
    def _primary_input_ref_node_id(node_id: str, workflow: dict[str, Any]) -> str | None:
        node = workflow.get(node_id)
        if not isinstance(node, dict):
            return None
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            return None
        ref = inputs.get("input")
        if (
            isinstance(ref, list)
            and len(ref) == 2
            and isinstance(ref[0], (str, int))
            and isinstance(ref[1], int)
        ):
            return str(ref[0])
        return None

    def _find_loop_start_id_for_end(self, loop_end_id: str, workflow: dict[str, Any]) -> str:
        prev_id = self._primary_input_ref_node_id(loop_end_id, workflow)
        if not prev_id:
            raise WorkflowFormatError(f"循环结束节点 {loop_end_id} 缺少输入连接")

        visited: set[str] = set()
        current = prev_id
        while current:
            if current in visited:
                raise WorkflowFormatError(f"循环容器检测到环路，节点：{current}")
            visited.add(current)

            node = workflow.get(current)
            if not isinstance(node, dict):
                raise WorkflowFormatError(f"循环容器引用了不存在的节点：{current}")
            class_type = str(node.get("class_type", "")).strip()
            if class_type == "LoopStart":
                return current
            current = self._primary_input_ref_node_id(current, workflow) or ""

        raise WorkflowFormatError(f"循环结束节点 {loop_end_id} 上游未找到循环开始节点")

    def _collect_loop_body_node_ids(
        self,
        loop_start_id: str,
        loop_end_id: str,
        workflow: dict[str, Any],
    ) -> list[str]:
        body_rev: list[str] = []
        current = self._primary_input_ref_node_id(loop_end_id, workflow)
        if not current:
            return []
        while current != loop_start_id:
            if current in body_rev:
                raise WorkflowFormatError(f"循环容器检测到环路，节点：{current}")
            body_rev.append(current)
            next_id = self._primary_input_ref_node_id(current, workflow)
            if not next_id:
                raise WorkflowFormatError(
                    f"循环结束节点 {loop_end_id} 与循环开始节点 {loop_start_id} 之间链路不完整"
                )
            current = next_id
        body_rev.reverse()
        return body_rev

    @staticmethod
    def _clear_cache_for_nodes(cache: dict[tuple[str, int], Any], node_ids: list[str]) -> None:
        for node_id in node_ids:
            cache.pop((node_id, 0), None)

    @staticmethod
    def _as_loop_count(value: Any, default: int) -> int:
        if value is None:
            return default
        try:
            parsed = int(value)
        except Exception:
            return default
        return max(1, parsed)

    @staticmethod
    def _as_nonnegative_float(value: Any, default: float) -> float:
        if value is None:
            return default
        try:
            parsed = float(value)
        except Exception:
            return default
        return max(0.0, parsed)

    @staticmethod
    def _with_loop_meta(loop_state: Any, loop_iteration: int, loop_count: int) -> Any:
        if not isinstance(loop_state, dict):
            return loop_state
        next_state = {**loop_state}
        next_state["loop_iteration"] = max(1, int(loop_iteration))
        next_state["loop_count"] = max(1, int(loop_count))
        return next_state

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
        "InputFill": "输入节点",
        "Screenshot": "截图节点",
        "LoopStart": "循环开始节点",
        "LoopEnd": "循环结束节点",
        "PullToPC": "回传节点",
        "EasyOCR": "文字识别节点",
        "ExportExcel": "导出表格节点",
        "PreviewExcel": "展示结果节点",
        "PreviewImages": "图片预览节点",
    }
    return mapping.get(class_type, class_type)
