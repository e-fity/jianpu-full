"""Expressive JSON keeps score timing and produces the requested audio."""
import json
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import audio
import score


def load(tmp_path, notes, key="1=C"):
    path = tmp_path / "expressive.json"
    path.write_text(json.dumps({"format": "jianpu2letter-notes-v1", "key": key,
        "tempo_qpm": 60, "lines": [{"notes": notes}]}), encoding="utf8")
    return score.build_plan(score.load_score(path), lead=0, tail=1)


def test_expressive_metadata_preserves_notes_rests_and_timing(tmp_path):
    notes = [{"n": 1, "q": 1}, {"n": 0, "q": .5}, {"n": 3, "q": 1}]
    plain = load(tmp_path, notes, "1=B")
    notes[0]["articulation"] = "sustain"
    notes[2].update(articulation="glissando", glissando_to={"n": 5, "o": 1})
    expressive = load(tmp_path, notes, "1=B")
    for key in ("t", "q", "dur", "midi"):
        assert [n[key] for n in expressive["landings"]] == [n[key] for n in plain["landings"]]
    assert expressive["duration"] == plain["duration"]
    assert expressive["rests"] == plain["rests"]
    assert expressive["landings"][1]["glissando_to_midi"] == 90
    assert expressive["events"][0]["articulation"] == "sustain"


@pytest.mark.parametrize("note", [
    {"n": 0, "q": 1, "articulation": "sustain"},
    {"n": 1, "q": 1, "articulation": "unknown"},
    {"n": 1, "q": 1, "articulation": "glissando"},
    {"n": 1, "q": 1, "glissando_to": {"n": 2}},
    *[{"n": 1, "q": 1, "articulation": "glissando", "glissando_to": target}
      for target in ({"n": 0}, {"n": True}, {"n": 8}, {"n": 2, "o": .5})],
])
def test_invalid_expressive_notes_are_rejected(tmp_path, note):
    with pytest.raises(score.ScoreError):
        load(tmp_path, [note])


def test_normal_articulation_keeps_audio_unchanged(tmp_path):
    note = {"n": 1, "q": 2}
    original = audio.render(load(tmp_path, [note]))
    note["articulation"] = "normal"
    assert np.array_equal(original, audio.render(load(tmp_path, [note])))


def test_note_off_and_bend_preserve_onsets_and_label_q_estimates(tmp_path):
    notes = [{"n": 1, "q": 2}, {"n": 0, "q": .5}, {"n": 3, "q": 1}]
    original = load(tmp_path, notes)
    notes[0].update(duration_sec=.8, pitch_bend=[
        {"time_sec": 0, "semitones": 0}, {"time_sec": .8, "semitones": 2}])
    actual = load(tmp_path, notes)
    assert [n["t"] for n in actual["landings"]] == [n["t"] for n in original["landings"]]
    assert actual["landings"][0]["dur"] == .8
    assert actual["landings"][0]["duration_source"] == "note_off"
    assert actual["landings"][1]["duration_source"] == "score_q"
    assert actual["events"][0]["score_dur_sec"] == 2
    assert actual["events"][0]["pitch_bend"] == notes[0]["pitch_bend"]


@pytest.mark.parametrize("fields", [
    {"duration_sec": value} for value in [0, -1, True, "1", float("inf"), float("nan")]
] + [{"pitch_bend": value} for value in [None, [], {},
    [{"time_sec": -1, "semitones": 0}], [{"time_sec": 2, "semitones": 0}],
    [{"time_sec": 0, "semitones": float("nan")}], [{"time_sec": 0, "semitones": 100}],
    [{"time_sec": .5, "semitones": 0}, {"time_sec": .5, "semitones": 1}],
    [{"time_sec": True, "semitones": 1}], [{"time_sec": 0}],
]])
def test_invalid_note_off_and_bend(tmp_path, fields):
    with pytest.raises(score.ScoreError):
        load(tmp_path, [{"n": 1, "q": 1, **fields}])


@pytest.mark.parametrize("fields", [{"duration_sec": 1}, {"pitch_bend": [{"time_sec": 0, "semitones": 0}]}])
def test_rest_cannot_carry_expressive_fields(tmp_path, fields):
    with pytest.raises(score.ScoreError):
        load(tmp_path, [{"n": 1, "q": 1}, {"n": 0, "q": 1, **fields}])


def test_bend_audio_tracks_points_and_releases_at_note_off(tmp_path):
    rate = 16000
    plan = load(tmp_path, [{"n": 1, "q": 3, "duration_sec": 1,
        "pitch_bend": [{"time_sec": 0, "semitones": 0}, {"time_sec": .5, "semitones": 12}]}])
    signal = audio.render(plan, rate)
    sample = signal[int(.65*rate):int(.85*rate)]
    spectrum = np.abs(np.fft.rfft(sample*np.hanning(len(sample)), n=32768))
    hz = np.fft.rfftfreq(32768, 1/rate)[np.argmax(spectrum)]
    assert hz == pytest.approx(audio.midi_to_hz(72), rel=.01)
    assert np.sqrt(np.mean(signal[int(1.6*rate):int(1.8*rate)]**2)) < .02


def test_earlier_note_off_can_outlast_the_final_onset(tmp_path):
    plan = load(tmp_path, [{"n": 1, "q": 1, "duration_sec": 4}, {"n": 3, "q": 1}])
    assert plan["landings"][1]["t"] == 1
    assert plan["duration"] == 5


def test_sustain_holds_until_note_end_then_releases(tmp_path):
    rate = 16000
    rendered = audio.render(load(tmp_path, [{"n": 1, "q": 2, "articulation": "sustain"}]), rate)
    rms = lambda a, b: np.sqrt(np.mean(rendered[int(a * rate):int(b * rate)] ** 2))
    assert rms(1.7, 1.9) > .75 * rms(.3, .5)
    assert rms(2.5, 2.7) < .10 * rms(1.7, 1.9)


@pytest.mark.parametrize("octave", [-1, 0, 1])
def test_glissando_reaches_the_requested_pitch(tmp_path, octave):
    rate = 16000
    rendered = audio.render(load(tmp_path, [{"n": 1, "q": 2,
        "articulation": "glissando", "glissando_to": {"n": 1, "o": octave}}]), rate)
    start_hz = audio.midi_to_hz(60)
    for center in (.35, 1.65, 2.2):
        sample = rendered[int((center - .1) * rate):int((center + .1) * rate)]
        power = np.abs(np.fft.rfft(sample * np.hanning(len(sample)), n=32768))
        hz = np.fft.rfftfreq(32768, 1 / rate)[np.argmax(power)]
        expected = start_hz * 2 ** (octave * min(center / 2, 1))
        assert hz == pytest.approx(expected, rel=.025)
