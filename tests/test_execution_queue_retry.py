import unittest

from src.adbflow.engine import ExecutionResult, WorkflowFormatError
from src.adbflow.executor import ExecutionQueue


class _FlakyEngine:
    def __init__(self):
        self.calls = 0

    def run(self, workflow, on_log=None, on_event=None, cancel_event=None):
        self.calls += 1
        if self.calls == 1:
            raise RuntimeError("temporary")
        return ExecutionResult(outputs={"1": {"ok": True}}, logs=["done"])


class _InvalidWorkflowEngine:
    def __init__(self):
        self.calls = 0

    def run(self, workflow, on_log=None, on_event=None, cancel_event=None):
        self.calls += 1
        raise WorkflowFormatError("invalid workflow")


class ExecutionQueueRetryTests(unittest.TestCase):
    def test_retry_then_success(self):
        engine = _FlakyEngine()
        queue = ExecutionQueue(engine, default_timeout_sec=20, default_max_retries=1)
        result = queue.run({"1": {"class_type": "Dummy", "inputs": {}}}, timeout=30)
        self.assertEqual(engine.calls, 2)
        self.assertTrue(result.outputs["1"]["ok"])

    def test_non_retryable_workflow_format_error(self):
        engine = _InvalidWorkflowEngine()
        queue = ExecutionQueue(engine, default_timeout_sec=20, default_max_retries=2)
        with self.assertRaises(WorkflowFormatError):
            queue.run({"1": {"class_type": "Dummy", "inputs": {}}}, timeout=30)
        self.assertEqual(engine.calls, 1)


if __name__ == "__main__":
    unittest.main()
