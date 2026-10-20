# Reviewer findings — must fix before acceptance

Independent pytest: 26 passed, 3 failed. Do not weaken tests to hide actual motion errors.

1. BLOCKER score.build_plan creates gaps between landing and next hop (dwell has no hold segment). sample_ball/sample_track fall through to final board. Repro with real fixture: t=1.315384615 returns x=350.7 instead of x=0. Insert explicit holds covering every dwell, ensure contiguous segments and exact landing endpoints. Add regression for all dwell intervals and near boundaries.
2. BLOCKER scene mixes Y-up plan with Z-up Blender ground/posts. Convert all plan coordinates consistently to Blender Z-up at renderer boundary (x,y,z -> x,z,y), including board dimensions, ball, support bases, particles, camera offsets/targets/fill. Or fully use Y-up renderer, but don't mix. Ground must cover entire track, including last board x=350.7. Factory-startup scene must be cleared of default cube/light/camera before build.
3. Tests: third note onset is lead+2*step, NOT lead+3*step; end is lead+3*step. Rest endpoint comparison suffers floating error: use an absolute tolerance <=1e-9 or quarter-beat positions; do not exclude a genuinely interior strike.
4. CLI reuses fixed .work directory, so rerunning a shorter video will encode stale extra frames; --clean may delete unrelated pre-existing files. Use tempfile.mkdtemp under output parent per run. Verify resolved cleanup path remains under intended output parent and is the exact newly created directory. Bound encoded frame count explicitly and consistent ceil(duration*fps). --seconds should cap preview at total duration.
5. Validate finite positive seconds, nonnegative finite lead/tail, positive samples, even output dimensions for yuv420p before writes. Validate input/output aliases using normalized resolved paths; restrict output suffix to .mp4. Batch same-basename inputs must not silently overwrite each other's output. Reject collisions before rendering or generate unique deterministic names.
6. Blender script errors may still exit 0: add --python-exit-code 1, fail before mux if frames are missing. Make samples actually apply to Blender 4.5; don't silently claim a setting worked.
7. Camera should follow sample_track for both position and target to avoid aiming up/down with every hop. First note should have a visible arriving hop, not sit there throughout lead-in and just flash.
8. Support CJK lyrics remains optional for first version; clearly document omission. No invented sampled-piano claims.

Blender is now installed and verified at D:/apps/Blender/blender-4.5.3-windows-x64/blender.exe. Add this path to discovery and README examples. Reviewer will run tests and render, so do not claim they passed without execution. Keep changes within ball3d.
