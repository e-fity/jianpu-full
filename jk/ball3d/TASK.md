# JSON music ball video: implementation and review contract

Planner/reviewer: Codex. Implementer: Claude Code using the existing DeepSeek provider.

## Scope
Create a standalone Blender-based true 3D video generator in ball3d only. Do not modify existing application files or discard any user changes. Do not change provider settings or read credentials. First milestone: a reproducible 12-second portrait preview from D:/Downloads/10_notes.json. Then full-song and sequential batch CLI. No new OCR, web UI, original vocal reconstruction or game controls.

## Input and timing
Accept jianpu2letter-notes-v1, lines[].notes[] in stored order. n=1..7 is scale degree, n=0 rest; o is signed octave. q is positive quarter-note duration. tempo_qpm is positive finite quarter-notes per minute. key=1=B transposes diatonic degrees; define middle 1=C as MIDI 60 and document it. letter is keyboard mapping, not pitch. Validate unknown notes, missing q, invalid tempo before rendering. Report errors with line/index. Rests consume time and never trigger audio or a new sounding landing. No implicit repeats or ties. All audio and animation derive from one absolute-time event list, with optional fixed lead-in. Never accumulate rounded per-note frames. Sample frames at frame_index/fps; a landing may lie between frames. Audio onset error <=1 sample and visual sampling error <=1 frame.

## Visual target
Reference is a pearl-like ball jumping across small suspended piano-like boards with visible thickness and supports, long shadows on a neutral background, colored glow and sparse star particles on each sounding landing, oblique follow camera. Geometry and lighting must be real 3D, not PIL painted pseudo-3D. Use deterministic analytic motion, no free-running physics. Ensure consecutive landings are continuous, board collision positions are correct, rests do not produce ghost strikes, repeated pitches remain separate events, and long notes do not create extreme leaps. Keep a single consistent visual template. Optional lyric text must not render broken Chinese glyphs; omit with clear explanation if font unavailable.

## Audio and output
Use built-in synthesized melody for MVP; call it synthesized, not sampled piano. No external sound asset downloads. Write WAV, render frames, mux H.264/yuv420p MP4 with audio using available imageio-ffmpeg executable. Paths must support spaces and Chinese via argument arrays, never shell concatenation. Preview defaults 360x640 30fps for timely review; final support 720x1280. Support --seconds preview, --output, --blender explicit executable and a bounded sequential batch mode. No input overwrites. Temporary files in per-run output directories. Fail on subprocess errors and report missing Blender clearly.

## Acceptance
Input fixture: 13 lines, 377 events =335 sounding +42 rests, sum q=188, tempo=65, exact score duration=188*60/65 seconds before lead/tail. Do not assert OCR correctness. Meaningful tests for rests, transposition, octave, repeated notes, invalid timing and absolute onset accumulation. Provide CLI help and a concise README, exact commands, dependency requirements, and known limitations. Reviewer runs tests independently, checks real rendered frames at several times and audio/video metadata. A successful code-generation response alone is NOT delivery.

## Current environment
Windows PowerShell; Python D:/python/python11/python.exe includes numpy, cv2, Pillow, imageio-ffmpeg. Blender not found in common install paths yet. No engine install or global modifications by implementer. Existing make_video.py is dirty: do not edit or import it. Only read if needed for conventions. Keep implementation small, avoid speculative abstraction.
