from __future__ import annotations

import importlib.metadata
import importlib.util
import threading
from pathlib import Path
from types import ModuleType
from typing import Any, Callable

from .observability import log_event

NodeFactory = Callable[[], Any]

_LOCK = threading.Lock()
_REGISTRY: dict[str, NodeFactory] = {}
_PLUGINS_LOADED = False


def init_builtin_nodes() -> None:
    from .nodes import NODE_REGISTRY as BUILTIN_NODE_REGISTRY

    with _LOCK:
        if _REGISTRY:
            return
        _REGISTRY.update(BUILTIN_NODE_REGISTRY)


def register_node(class_type: str, factory: NodeFactory, overwrite: bool = False) -> None:
    key = str(class_type or "").strip()
    if not key:
        raise ValueError("class_type 不能为空")
    with _LOCK:
        if key in _REGISTRY and not overwrite:
            raise ValueError(f"节点类型已存在：{key}")
        _REGISTRY[key] = factory


def get_node_factory(class_type: str) -> NodeFactory | None:
    init_builtin_nodes()
    key = str(class_type or "").strip()
    with _LOCK:
        return _REGISTRY.get(key)


def all_node_types() -> list[str]:
    init_builtin_nodes()
    with _LOCK:
        return sorted(_REGISTRY.keys())


def load_plugins_once(
    plugin_dir: Path | None = None,
    entrypoint_group: str = "adbflow.nodes",
) -> None:
    global _PLUGINS_LOADED
    init_builtin_nodes()
    with _LOCK:
        if _PLUGINS_LOADED:
            return
        _PLUGINS_LOADED = True

    _load_entrypoint_plugins(entrypoint_group)
    _load_directory_plugins(plugin_dir)


def _load_entrypoint_plugins(group: str) -> None:
    try:
        eps = importlib.metadata.entry_points()
        if hasattr(eps, "select"):
            entries = list(eps.select(group=group))
        else:
            entries = list(eps.get(group, []))  # type: ignore[attr-defined]
    except Exception as exc:
        log_event("node_plugin_entrypoints_failed", error=str(exc))
        return

    for ep in entries:
        try:
            loaded = ep.load()
            _apply_plugin_payload(loaded, source=f"entrypoint:{ep.name}")
            log_event("node_plugin_loaded", source=f"entrypoint:{ep.name}")
        except Exception as exc:
            log_event("node_plugin_load_failed", source=f"entrypoint:{ep.name}", error=str(exc))


def _load_directory_plugins(plugin_dir: Path | None) -> None:
    if plugin_dir is None:
        return
    p = Path(plugin_dir).resolve()
    if not p.exists() or not p.is_dir():
        return

    for f in sorted(p.glob("*.py")):
        if f.name.startswith("_"):
            continue
        try:
            module = _load_python_module(f)
            _apply_plugin_payload(module, source=str(f))
            log_event("node_plugin_loaded", source=str(f))
        except Exception as exc:
            log_event("node_plugin_load_failed", source=str(f), error=str(exc))


def _load_python_module(path: Path) -> ModuleType:
    module_name = f"adbflow_plugin_{path.stem}_{abs(hash(str(path)))}"
    spec = importlib.util.spec_from_file_location(module_name, str(path))
    if spec is None or spec.loader is None:
        raise RuntimeError(f"无法加载插件：{path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _apply_plugin_payload(payload: Any, source: str) -> None:
    if isinstance(payload, ModuleType):
        if hasattr(payload, "register") and callable(payload.register):
            payload.register(register_node)
            return
        if hasattr(payload, "NODE_FACTORIES"):
            payload = getattr(payload, "NODE_FACTORIES")
        else:
            return

    if callable(payload):
        payload(register_node)
        return
    if isinstance(payload, dict):
        for class_type, factory in payload.items():
            register_node(str(class_type), factory, overwrite=True)
        return
    raise TypeError(f"插件载荷不支持：{source}")
