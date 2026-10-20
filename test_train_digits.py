"""Validation tests for training the existing model from human-labelled crops."""
from pathlib import Path
import tempfile
import unittest

import numpy as np

from train_digits import train_samples


class TrainSampleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "samples.npz"
        self.output = self.root / "candidate.npz"
        self.data = dict(feats=np.eye(2, 768, dtype=np.float32),
                         labels=np.array([0, 6], dtype=np.int16),
                         groups=np.array(["source-a", "source-b"]),
                         ids=np.array(["crop-a", "crop-b"]))

    def save(self):
        np.savez_compressed(self.source, **self.data)

    def test_model_preserves_labels_features_and_source_groups(self):
        self.save()
        self.assertEqual(train_samples(self.source, self.output), 0)
        with np.load(self.output, allow_pickle=False) as model:
            for key in self.data:
                np.testing.assert_array_equal(model[key], self.data[key])
            self.assertEqual(len(str(model["source_sha256"])), 64)

    def test_existing_model_is_not_overwritten(self):
        self.save()
        self.output.write_bytes(b"existing")
        with self.assertRaisesRegex(ValueError, "不覆盖"):
            train_samples(self.source, self.output)
        self.assertEqual(self.output.read_bytes(), b"existing")

    def test_list_does_not_write_a_model(self):
        self.save()
        self.assertEqual(train_samples(self.source, list_only=True), 0)
        self.assertFalse(self.output.exists())

    def test_invalid_labels_fail_before_writing(self):
        for labels in (np.array([0, 8]), np.array([0., 6.]), np.array([0])):
            with self.subTest(labels=labels):
                self.data["labels"] = labels
                self.save()
                with self.assertRaises(ValueError):
                    train_samples(self.source, self.output)
                self.assertFalse(self.output.exists())

    def test_invalid_features_fail_before_writing(self):
        for feats in (np.zeros((2, 767)), np.full((2, 768), np.nan),
                      np.full((2, 768), 2.), np.zeros((0, 768))):
            with self.subTest(shape=feats.shape):
                self.data["feats"] = feats
                self.save()
                with self.assertRaises(ValueError):
                    train_samples(self.source, self.output)
                self.assertFalse(self.output.exists())

    def test_duplicate_ids_and_missing_provenance_are_rejected(self):
        for changes in (dict(ids=np.array(["same", "same"])),
                        dict(ids=np.array(["crop-a", "crop-b"]), groups=np.array(["one"]))):
            self.data.update(changes)
            self.save()
            with self.assertRaises(ValueError):
                train_samples(self.source, self.output)
            self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
