"""Animation config must round-trip without touching the note input format."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import webapp

class PresentationApiTests(unittest.TestCase):
    def test_phrase_layering_is_enabled_and_round_trips_as_a_boolean(self):
        original = Path(webapp.EDITOR_PRESENTATION).read_text(encoding="utf-8")
        with tempfile.TemporaryDirectory() as tmp:
            config_path = Path(tmp) / "config.json"
            config_path.write_text(original, encoding="utf-8")
            with patch.object(webapp, "EDITOR_PRESENTATION", str(config_path)):
                client = webapp.app.test_client()
                config = client.get("/api/editor/presentation").get_json()["config"]
                self.assertIs(config["spatial"]["layeredPhrases"], True)
                for enabled in (False, True):
                    config["spatial"]["layeredPhrases"] = enabled
                    response = client.post("/api/editor/presentation", json=config)
                    self.assertEqual(response.status_code, 200)
                    self.assertIs(response.get_json()["config"]["spatial"]["layeredPhrases"], enabled)
                saved = config_path.read_bytes()
                for invalid in (0, 1, "true", None):
                    config["spatial"]["layeredPhrases"] = invalid
                    self.assertEqual(client.post("/api/editor/presentation", json=config).status_code, 400)
                    self.assertEqual(config_path.read_bytes(), saved)

    def test_import_uses_existing_score_structure(self):
        score = {"format": "jianpu2letter-notes-v1", "title": "test", "key": "1=C",
                 "tempo_qpm": 100, "lines": [{"notes": [{"n": 1, "o": 0, "q": 1}]}]}
        with tempfile.TemporaryDirectory() as tmp, patch.object(webapp, "EDITOR_IMPORTS", tmp):
            response = webapp.app.test_client().post("/api/editor/import", data=json.dumps(score))
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.get_json()["notes"], 1)

    def test_save_and_reject_invalid_without_changing_file(self):
        original = Path(webapp.EDITOR_PRESENTATION).read_text(encoding="utf-8")
        with tempfile.TemporaryDirectory() as tmp:
            config_path = Path(tmp) / "config.json"
            config_path.write_text(original, encoding="utf-8")
            with patch.object(webapp, "EDITOR_PRESENTATION", str(config_path)):
                client = webapp.app.test_client()
                config = client.get("/api/editor/presentation").get_json()["config"]
                config["camera"]["fov"] = 39
                config["ball"]["attenuationColor"] = "#f0e8df"
                config["physics"]["gravity"] = 7
                self.assertEqual(client.post("/api/editor/presentation", json=config).status_code, 200)
                self.assertEqual(json.loads(config_path.read_text(encoding="utf-8"))["camera"]["fov"], 39)
                self.assertEqual(json.loads(config_path.read_text(encoding="utf-8"))["ball"]["attenuationColor"], "#f0e8df")
                self.assertEqual(json.loads(config_path.read_text(encoding="utf-8"))["physics"]["gravity"], 7)
                saved = config_path.read_bytes()
                for group, key, value in [("camera", "sigma", 0), ("camera", "maxBoardsAcross", 6.5),
                    ("ball", "attenuationColor", "white"), ("boards", "springDamping", 0),
                    ("camera", "fov", "37"), ("environment", "file", "../secret.hdr"),
                    ("physics", "gravity", -1), ("boards", "rodLengthWidths", 1.2),
                    ("spatial", "levelPhraseGap", 4.5), ("spatial", "levelMaxNotes", 2.5),
                    ("spatial", "levelMaxNotes", 2), ("spatial", "levelMaxNotes", 7),
                    ("tracks", "glissMinNotes", 4.5), ("tracks", "integrationSteps", 512.5),
                    ("tracks", "maxLengthWidths", 5.1), ("tracks", "minFlightSeconds", .19)]:
                    bad = json.loads(saved); bad[group][key] = value
                    self.assertEqual(client.post("/api/editor/presentation", json=bad).status_code, 400)
                    self.assertEqual(config_path.read_bytes(), saved)

if __name__ == "__main__":
    unittest.main()
