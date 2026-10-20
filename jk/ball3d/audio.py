"""Built-in *synthesized* melody (never sampled piano) -> 16-bit WAV.

Every onset is placed at ``round(t * sample_rate)`` where ``t`` comes from the
single absolute-time event list in the plan, so the onset error is <= 0.5 sample
(<= 1 sample as required).  Rests consume time and produce no voice; a rest is
audible only through the natural decay of the previous note.
"""

from __future__ import annotations

import math
import wave

import numpy as np

SAMPLE_RATE = 44100
# partial -> relative amplitude (synthesized piano-ish timbre, no samples)
PARTIALS = ((1.0, 1.00), (2.0, 0.38), (3.0, 0.15), (4.0, 0.06), (5.03, 0.025))


def midi_to_hz(midi):
    return 440.0 * (2.0 ** ((float(midi) - 69.0) / 12.0))


def onset_sample(t, sample_rate=SAMPLE_RATE):
    """Exact sample index of an onset: one rounding, never accumulated."""
    return int(round(t * sample_rate))


def render(plan, sample_rate=SAMPLE_RATE):
    """Render the whole plan into a float32 mono buffer of plan['duration']."""
    duration = float(plan["duration"])
    n = int(round(duration * sample_rate))
    buf = np.zeros(n, dtype=np.float64)
    t_axis = np.arange(n, dtype=np.float64) / sample_rate

    for landing in plan["landings"]:
        start = onset_sample(landing["t"], sample_rate)
        if start >= n:
            continue
        freq = midi_to_hz(landing["midi"])
        dur = float(landing["dur"]) if landing.get("duration_source") == "note_off" else max(0.05, float(landing["dur"]))
        expressive = (landing.get("articulation") in ("sustain", "glissando")
                      or landing.get("duration_source") == "note_off" or "pitch_bend" in landing)
        tone_sec = min(dur + 0.8 if expressive else dur * 2.5 + 0.6, duration)
        count = min(n - start, int(round(tone_sec * sample_rate)))
        if count <= 0:
            continue
        tt = t_axis[:count]
        env = (1.0 - np.exp(-tt / 0.004)) * np.exp(-tt / (0.30 + 0.55 * dur))
        if expressive:
            env = (1.0 - np.exp(-tt / 0.004)) * (0.75 + 0.25 * np.exp(-tt / 0.12))
            env *= np.exp(-np.maximum(0.0, tt - dur) / 0.18)
        phase = freq * tt
        if "pitch_bend" in landing:
            points = landing["pitch_bend"]
            times = [0.0] + [p["time_sec"] for p in points]
            offsets = [0.0] + [p["semitones"] for p in points]
            if points[0]["time_sec"] == 0:
                times, offsets = times[1:], offsets[1:]
            frequencies = freq * 2 ** (np.interp(tt, times, offsets) / 12)
            phase = np.zeros(count, dtype=np.float64)
            phase[1:] = np.cumsum((frequencies[:-1] + frequencies[1:]) / (2 * sample_rate))
        elif landing.get("articulation") == "glissando":
            target = midi_to_hz(landing["glissando_to_midi"])
            rate = math.log(target / freq) / dur
            if abs(rate) > 1e-12:
                phase = freq * np.expm1(rate * np.minimum(tt, dur)) / rate
                phase += target * np.maximum(0.0, tt - dur)
        voice = np.zeros(count, dtype=np.float64)
        for mult, amp in PARTIALS:
            voice += amp * np.sin(2.0 * math.pi * mult * phase)
        buf[start:start + count] += voice * env
        # short "board" tick at the moment of the landing
        click_n = min(n - start, int(round(0.022 * sample_rate)))
        if click_n > 0:
            ct = t_axis[:click_n]
            buf[start:start + click_n] += 0.10 * np.sin(2.0 * math.pi * 1400.0 * ct) \
                * np.exp(-ct / 0.004)

    peak = float(np.max(np.abs(buf))) if buf.size else 0.0
    if peak > 0.0:
        buf *= 0.89 / peak
    return buf.astype(np.float32)


def write_wav(path, samples, sample_rate=SAMPLE_RATE):
    """Write mono 16-bit PCM.  ``path`` may contain spaces / Chinese."""
    pcm = np.clip(samples, -1.0, 1.0)
    pcm = (pcm * 32767.0).astype("<i2")
    with wave.open(str(path), "wb") as fh:
        fh.setnchannels(1)
        fh.setsampwidth(2)
        fh.setframerate(int(sample_rate))
        fh.writeframes(pcm.tobytes())
    return path


def render_to_wav(plan, path, sample_rate=SAMPLE_RATE):
    write_wav(path, render(plan, sample_rate), sample_rate)
    return path
