import unittest
from helpers import _sanitize_outputs_for_report


class ReportSlimmingTests(unittest.TestCase):
    def test_preview_images_data_url_is_removed(self):
        outputs = {
            "4": {
                "preview_images": [
                    {"name": "a.png", "path": "outputs/screenshots/a.png", "data_url": "data:image/png;base64,AAA"},
                    {"name": "b.png", "path": "outputs/screenshots/b.png", "data_url": "data:image/png;base64,BBB"},
                ],
                "preview_image_total": 2,
            }
        }

        slim = _sanitize_outputs_for_report(outputs)
        payload = slim["4"]
        self.assertTrue(payload.get("_preview_images_data_url_omitted"))
        self.assertEqual(len(payload["preview_images"]), 2)
        self.assertNotIn("data_url", payload["preview_images"][0])
        self.assertEqual(payload["preview_images"][0]["name"], "a.png")


if __name__ == "__main__":
    unittest.main()
