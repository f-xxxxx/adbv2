from __future__ import annotations

import argparse
import json
from pathlib import Path

from .engine import WorkflowEngine


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run ADB node workflow")
    parser.add_argument(
        "--workflow",
        required=True,
        help="Path to workflow JSON (ComfyUI-like node object)",
    )
    parser.add_argument(
        "--print-output-node",
        default="",
        help="Optional node id to print final output JSON only for that node",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    workflow_path = Path(args.workflow).resolve()
    if not workflow_path.exists():
        raise FileNotFoundError(f"Workflow file not found: {workflow_path}")

    with workflow_path.open("r", encoding="utf-8") as f:
        workflow = json.load(f)

    engine = WorkflowEngine()
    result = engine.run(workflow)

    print("=" * 80)
    print("WORKFLOW LOG")
    print("=" * 80)
    for line in result.logs:
        print(line)

    print("=" * 80)
    print("WORKFLOW OUTPUT")
    print("=" * 80)
    if args.print_output_node:
        node_id = str(args.print_output_node)
        payload = result.outputs.get(node_id)
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print(json.dumps(result.outputs, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

