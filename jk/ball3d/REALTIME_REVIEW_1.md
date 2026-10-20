# Reviewer checks during implementation

- InstancedMesh bounding sphere is cached by Three.js. When moving a fixed instance pool along a 350m track, disable frustumCulled for these small pooled meshes or recompute bounds every update. Otherwise later-song objects/shadows disappear although matrices are correct. Test an actual rendered later frame.
- Swapping Blender Y/Z into a right-handed Three Y-up system reflects handedness. Inspect camera orientation against baseline; if track slopes opposite on screen, mirror projection horizontally (or use a proper rotation mapping for all coordinates) consistently. Motion can remain mathematically identical while screen appearance is reflected.
- Measured Edge headless WebGL on RX6500XT works. H264 VideoEncoder supports no-preference/prefer-software, prefer-hardware false. Do not force hardware. Simple 300-frame720x1280 H264 encode probe took0.792s; not a full scene benchmark.
- No need to implement unused parity helpers or tests of copied constants. Keep focus on rendered export and actual trajectory/pool correctness.

Reviewer already applied fixes in source while implementation proceeded:
- Scene Z reflection + matching camera Z restores handedness; frustumCulled=false on pools avoids cached bounds.
- /qa token query building fixed; bundle URL receives session token; upload saved at correct outPath.
- Unused encoder modules stubbed at build time (bare external imports prevented browser startup); legal comments retained.
- Recorder time explicitly i/fps; bloom reduced to .18 after visual QA.
- burstPool returns empty when latest burst expired; fade test threshold corrected to .001 of peak (original Blender formula gives .00019, not <.0001).

Measured first full CLI10s ~6s; full175.838s export46s,5276frames decoded. DO NOT overwrite these reviewer fixes. Finish remaining tests/docs; no speed claims beyond these measurements. Reviewer will author final performance report.
