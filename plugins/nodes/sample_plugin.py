from __future__ import annotations


class EchoNode:
    class_type = "Echo"

    def run(self, inputs, ctx):
        text = str(inputs.get("text", "hello plugin"))
        ctx.log(f"[插件节点 Echo] {text}")
        payload = inputs.get("input") if isinstance(inputs.get("input"), dict) else {}
        return {**payload, "echo": text}


def register(register_node):
    register_node("Echo", EchoNode, overwrite=True)
