"""Tests for crop provenance and human-only digit training targets."""
import json
from pathlib import Path
import tempfile
import unittest

import cv2
import numpy as np

import digit_samples as ds
from jianpu2letter.ocr_jianpu import _shape_feature


class DigitSamplesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "原谱.png"
        self.color = np.full((90, 100, 3), 255, np.uint8)
        self.color[12:27, 14:19] = 0
        self.color[12:27, 44:49] = 0
        self.color[52:67, 14:19] = 0
        self.binary = 255 - self.color[:, :, 0]
        self.source.write_bytes(ds.png_bytes(self.color))
        self.measures = [
            dict(row=2, notes=[dict(n=1, conf=.9, box=(10, 10, 20, 20)),
                               dict(n=5, conf=.3, box=(40, 10, 20, 20))]),
            dict(row=4, notes=[dict(n=None, conf=None, box=(10, 50, 20, 20))]),
        ]
        self.pack = self.root / "标注"
        ds.write_bundle(self.source, self.pack, self.measures,
                        self.color, self.binary, 2)
        self.label_path = self.pack / "labels.json"

    def label(self, values, name="labels.json"):
        data = json.loads(self.label_path.read_text(encoding="utf-8"))
        data["labels"].update(values)
        path = self.pack / name
        ds.write_json(path, data)
        return path

    def test_crops_match_scaled_coordinates_and_numbering(self):
        manifest = json.loads((self.pack/"manifest.json").read_text(encoding="utf-8"))
        self.assertEqual([r["id"] for r in manifest["notes"]],
                         ["L01N001", "L01N002", "L02N001"])
        crop = cv2.imdecode(np.frombuffer((self.pack/"digits/L02N001.png").read_bytes(),
                                         np.uint8), cv2.IMREAD_COLOR)
        np.testing.assert_array_equal(crop, self.color[50:70, 10:30])
        self.assertEqual(manifest["source"]["scale"], 2)
        self.assertTrue((self.pack/"sheets/001.png").exists())

    def test_unverified_predictions_never_become_training_targets(self):
        destination = self.root/"dataset"
        with self.assertRaisesRegex(ValueError, "没有已确认"):
            ds.export([self.label_path], destination)
        self.assertFalse(destination.exists())

    def test_export_includes_confirmed_correct_and_corrected_rest_labels(self):
        self.label({"L01N001": 1, "L01N002": 0, "L02N001": "skip"})
        destination = self.root/"dataset"
        rows = ds.export([self.label_path], destination)
        self.assertEqual([r["label"] for r in rows], [1, 0])
        with np.load(destination/"samples.npz") as data:
            self.assertEqual(data["labels"].tolist(), [1, 0])
            expected = _shape_feature(dict(x=10, y=10, w=20, h=20), self.binary)
            np.testing.assert_array_equal(data["feats"][0], expected)
            self.assertEqual(len(set(data["groups"])), 1)
        self.assertFalse((destination/"digit_model.npz").exists())

    def test_invalid_digit_labels_are_rejected_before_writing(self):
        for invalid in (8, -1, True, "5", 1.5):
            with self.subTest(label=invalid):
                self.label({"L01N001": invalid})
                with self.assertRaisesRegex(ValueError, "标签必须"):
                    ds.export([self.label_path], self.root/"invalid")
                self.assertFalse((self.root/"invalid").exists())

    def test_unknown_note_ids_are_rejected(self):
        self.label({"L99N001": 3})
        with self.assertRaisesRegex(ValueError, "未知音符"):
            ds.collect_samples([self.label_path])

    def test_duplicate_samples_are_deduplicated_and_conflicts_rejected(self):
        self.label({"L01N001": 1})
        self.assertEqual(len(ds.collect_samples([self.label_path]*2)), 1)
        other = self.label({"L01N001": 2}, "other.json")
        with self.assertRaisesRegex(ValueError, "冲突标签"):
            ds.collect_samples([self.label_path, other])

    def test_wrong_source_hash_and_changed_crops_are_rejected(self):
        self.label({"L01N001": 1})
        data = json.loads(self.label_path.read_text(encoding="utf-8"))
        correct = data["source_sha256"]
        data["source_sha256"] = "wrong"
        ds.write_json(self.label_path, data)
        with self.assertRaisesRegex(ValueError, "原图不匹配"):
            ds.collect_samples([self.label_path])
        data["source_sha256"] = correct
        ds.write_json(self.label_path, data)
        (self.pack/"digits/L01N001.png").write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "小图已改变"):
            ds.collect_samples([self.label_path])

    def test_existing_annotations_and_datasets_are_not_overwritten(self):
        self.label({"L01N001": 1})
        saved = self.label_path.read_bytes()
        with self.assertRaisesRegex(ValueError, "不覆盖"):
            ds.write_bundle(self.source, self.pack, self.measures,
                            self.color, self.binary, 2)
        self.assertEqual(self.label_path.read_bytes(), saved)
        destination = self.root/"dataset"
        ds.export([self.label_path], destination)
        with self.assertRaisesRegex(ValueError, "已存在"):
            ds.export([self.label_path], destination)

    def test_out_of_bounds_crop_does_not_create_partial_bundle(self):
        self.measures[0]["notes"][0]["box"] = (95, 0, 20, 20)
        output = self.root/"bad"
        with self.assertRaisesRegex(ValueError, "越界"):
            ds.write_bundle(self.source, output, self.measures,
                            self.color, self.binary, 2)
        self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
