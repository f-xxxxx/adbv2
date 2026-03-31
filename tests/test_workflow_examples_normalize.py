import json
import unittest
from pathlib import Path

from src.adbflow.workflow_contract import normalize_workflow


class WorkflowExamplesNormalizeTests(unittest.TestCase):
    def _load(self, name: str):
        p = (Path(__file__).resolve().parents[1] / "workflows" / name).resolve()
        with p.open("r", encoding="utf-8") as f:
            return json.load(f)

    def test_example_folder_ocr_workflow_normalizes(self):
        wf = self._load("example_folder_ocr_workflow.json")
        normalized, warnings = normalize_workflow(wf)
        self.assertTrue(normalized)
        self.assertIsInstance(warnings, list)

    def test_example_screenshot_only_workflow_normalizes(self):
        wf = self._load("example_screenshot_only_workflow.json")
        normalized, warnings = normalize_workflow(wf)
        self.assertTrue(normalized)
        self.assertIsInstance(warnings, list)

    def test_example_loop_sequence_workflow_normalizes(self):
        wf = self._load("example_loop_sequence_workflow.json")
        normalized, warnings = normalize_workflow(wf)
        self.assertTrue(normalized)
        self.assertIsInstance(warnings, list)


if __name__ == "__main__":
    unittest.main()
