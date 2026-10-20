# Performance task 2026-10-10

Planner/reviewer: Codex; implementer: Claude Code with DeepSeek. User approved optimizing the EXISTING Blender version and comparing the SAME 10-second clip before/after. Keep existing uncommitted changes, only edit ball3d source/tests and relevant README. Baseline source snapshot and benchmark are in out/perf_20261010/baseline; DO NOT alter that snapshot or out/* evidence. Baseline is running via snapshot independently now.

## Fixed acceptance conditions
Input D:/Downloads/10_notes.json, first 10 seconds incl existing lead-in, 720x1280, 30 fps, 16 EEVEE samples, 300 frames. Same camera, geometry dimensions, light/shadow settings, colors, motion, timing, synth audio and encoding quality. NO performance claims through lowering quality, frame count or resolution. Actual wall-clock and image comparison are required by reviewer. Current 66 tests pass outside Windows sandbox; do not change score.py or audio.py unless demonstrated necessity (none expected).

## Optimize the measured structure, keep it simple
- Main likely cost: current loop calls bpy.ops.render.render(write_still=True) for EACH frame, reconstructing render state. Use a single animation render call with frame_change_pre/post handler updating analytic state t=(frame-1)/fps, persistent renderer across frames, proper handler removal in finally, exact output filenames frame_000001.png..frame_000300.png. Verify actual Blender 4.5 behavior, don't assume render result equivalence. Keep PNG validation in CLI.
- Reuse immutable star materials by palette, possibly idle board materials where safe; DO NOT make unrelated boards glow together by sharing mutable emissions. Static shader updates should be avoided.
- Bounded spatial window for nearby boards, posts and particles can help full-song scaling, but avoid complex speculative pool rewrite. Be conservative about offscreen shadow casters and point/sun shadows; do not pop objects or change visible shadows. If uncertain, implement only well-supported optimizations first and report deferred pooling. A preview-only prune that helps 10s but not full songs must not be presented as full-song speedup.
- PNG compression can be reduced without image quality change; do not remove debug frames or change CLI contracts unnecessarily. Encoding is a smaller contributor; no gratuitous dependencies or renderer migration.
- Add small explicit render timing/object/material stats to log (build and rendering wall seconds). Preserve nonzero failure exit and exact frame completeness checks.
- Tests should protect frame/time mapping, material independence if sharing, and any culling margin/boundary logic. Avoid mock tests that merely assert constants or code structure.
- Keep functions simple, no new version abstraction, no generalized render backend framework, no unrelated cleanup.

Implement directly; Codex will execute tests, compare 10sec before/after at identical settings and visually inspect frames (also later-song positions if culling). You have Read/Write/Edit/Glob/Grep tools, no shell. Do NOT claim execution. Blender installed at D:/apps/Blender/blender-4.5.3-windows-x64/blender.exe. Don't inspect credentials or provider settings. Finish with changed files, rationale and precise risks to check. Only change source in current ball3d, never snapshot in out.
