# ball3d — true-3D ball video from a jianpu JSON score

当前默认入口是 [Three.js 快速版](realtime/README.md)：Blender 制作参考图木板和金色双轨模型，Three.js 按 JSON 时间轴输出视频。当前轨道仅用于按持续时间判定的长音和滑音，休止滞空；支持可选 `duration_sec` / `pitch_bend`，旧 q 时值明确标为推算。模型不带示例球。用法与字段见 [快速版说明](realtime/README.md)，最新验收见 [长音与滑音验收](out/expressive_rails/ACCEPTANCE.md)。以下为仍保留的原 Blender 渲染入口说明。

A standalone generator (this directory only, no changes to the rest of the
project) that turns a `jianpu2letter-notes-v1` score into a portrait MP4:
a pearl-like ball hops across small suspended piano-like boards, with real
geometry, real shadows and a synthesized melody. Blender does the 3D; CPython
does input validation, timing, motion planning and audio.

## Requirements

| Need | Version / note |
| --- | --- |
| Python | `D:/python/python11/python.exe` (must have `numpy`, `imageio-ffmpeg`) |
| Blender | 4.5 LTS (`BLENDER_EEVEE_NEXT`), run headless via `-b`; verified install: `D:/apps/Blender/blender-4.5.3-windows-x64/blender.exe` |
| ffmpeg | taken from `imageio_ffmpeg.get_ffmpeg_exe()`, else `ffmpeg` on PATH |

Nothing is installed by these scripts, and no audio asset is downloaded: the
melody is **synthesized** (sine partials + a short board tick), not a sampled
piano. If Blender is not installed, `--plan-only` still produces the plan and
the WAV, and any render attempt fails with a clear message listing the paths
searched.

## Quick start

```powershell
# 0) tests (no Blender needed)
D:/python/python11/python.exe -m unittest discover -s "D:/Letter piano jk/ball3d/tests" -v

# 1) input + audio only (works without Blender)
D:/python/python11/python.exe "D:/Letter piano jk/ball3d/make_ball_video.py" `
  --input D:/Downloads/10_notes.json --seconds 12 --plan-only

# 2) 12-second portrait preview (360x640 @30fps) — the first milestone
D:/python/python11/python.exe "D:/Letter piano jk/ball3d/make_ball_video.py" `
  --input D:/Downloads/10_notes.json --seconds 12 `
  --blender "D:/apps/Blender/blender-4.5.3-windows-x64/blender.exe"

# 3) full song, 720x1280
D:/python/python11/python.exe "D:/Letter piano jk/ball3d/make_ball_video.py" `
  --input D:/Downloads/10_notes.json --width 720 --height 1280 `
  --blender "D:/apps/Blender/blender-4.5.3-windows-x64/blender.exe" `
  --output "D:/out/孤勇者_ball3d.mp4"

# 4) bounded sequential batch (max 3 inputs unless --limit is raised)
D:/python/python11/python.exe "D:/Letter piano jk/ball3d/make_ball_video.py" `
  --batch D:/scores/list.txt --limit 3 --seconds 12 `
  --blender "D:/apps/Blender/blender-4.5.3-windows-x64/blender.exe"

D:/python/python11/python.exe "D:/Letter piano jk/ball3d/make_ball_video.py" --help
```

`--blender` may be omitted if `JPK_BLENDER` is set, Blender is on PATH, or it is
in `D:\apps\Blender\blender-4.5.3-windows-x64\` / `C:\Program Files\Blender
Foundation\*\`.
`--batch` accepts a text file (one input path per line, `#` comments, directories
are expanded to `*.json`) or a directory; two inputs that would write the same
output are rejected before rendering. Default output goes to `ball3d/out/`.

### 快速开始（中文）

环境：Python 用 `D:/python/python11/python.exe`（需要 `numpy`、
`imageio-ffmpeg`），Blender 用 4.5 LTS，本机实测路径就是
`D:/apps/Blender/blender-4.5.3-windows-x64/blender.exe`。

```powershell
# 1) 跑测试（不需要 Blender）
D:/python/python11/python.exe -m unittest discover -s "D:/Letter piano jk/ball3d/tests" -v

# 2) 只出乐谱计划 + 音频，不渲染视频（没装 Blender 也能跑）
D:/python/python11/python.exe "D:/Letter piano jk/ball3d/make_ball_video.py" `
  --input D:/Downloads/10_notes.json --seconds 12 --plan-only

# 3) 12 秒竖屏预览：360x640 @30fps —— 这条路径评审已成功渲染（画面明显改善）
D:/python/python11/python.exe "D:/Letter piano jk/ball3d/make_ball_video.py" `
  --input D:/Downloads/10_notes.json --seconds 12 `
  --blender "D:/apps/Blender/blender-4.5.3-windows-x64/blender.exe"

# 4) 整曲 720x1280 —— 参数已通过校验，但从未实际渲染过（见下）
D:/python/python11/python.exe "D:/Letter piano jk/ball3d/make_ball_video.py" `
  --input D:/Downloads/10_notes.json --width 720 --height 1280 `
  --blender "D:/apps/Blender/blender-4.5.3-windows-x64/blender.exe" `
  --output "D:/out/孤勇者_ball3d.mp4"
```

**已验证（2026-10-09，Codex 独立审核）：** 66 项测试全部通过。最终代码已导出并完整解码 12 秒 / 360 帧 / 360x640 / 30fps 的《孤勇者》样片，包含 AAC 音轨；两个不同调号、含休止与重复音的小型简谱也完成顺序批量导出和解码。整首《孤勇者》的 335 个落点、42 个休止符、完整时间轴和合成 WAV 已独立核对。

**尚未验证：** 整曲 720x1280 视频和长时间、大批量连续运行。当前版本按原型交付；音色、画面精细度和渲染吞吐量仍有改进空间。详细证据见 [审核报告](REVIEW_REPORT.md)。

**性能实测（2026-10-10）：** 固定 10 秒、720x1280、30fps、16 次采样，优化前 233.67 秒，优化后 107.33 秒，约 2.18 倍速度，耗时减少 54.07%。73 项测试通过。300 帧中 284 帧逐像素相同，剩余 16 帧合计 58 个 RGB 分量有极小变化（最大 2/255）；音频逐字节相同。详见 [性能审核报告](PERFORMANCE_REPORT.md)。命令不变，默认使用优化路径。整曲约半小时仅为短片外推，尚未重渲整曲验证。

画面是程序生成的 3D 场景，**不是**对参考视频的复刻：正交相机（`ortho_scale 8.0`，
偏移约 `(-3,-6,5.5)`，瞄准点比小球领先 `0.6 m`）、中性灰地面与背景、深色悬浮
琴板、按音高取色的饱和接触光（青/绿/黄/橙/品红）以及落点附近的彩色点光源。
能和参考视频"像"到什么程度没有测量过，也不做保证。

其它如实说明：旋律是**合成**的（正弦分音 + 落板轻击），不是真钢琴采样；**画面里
不渲染歌词文字**（Blender 自带字体没有中文字形，不联网下载字体）；输入 JSON 的
OCR 准确度不做校验；渲染需要 EEVEE，也就是需要可用的 GPU。

## Input contract

`jianpu2letter-notes-v1`, `lines[].notes[]` in stored order.

* `n` 1..7 = scale degree, `n` = 0 = rest; `o` = signed octave (±1 = one octave);
  `q` = duration in quarter notes (> 0); `tempo_qpm` = quarter notes per minute (> 0).
* OCR items with `n: null` (or absent `n`) and explicit `unknown: true`
  become silent placeholders with their original positive `q` duration. They
  create no board or voice; the editor shows their count. The source JSON is
  unchanged. Unmarked missing pitches and invalid durations still fail validation.
* `letter` is a **keyboard mapping, not a pitch** — it is never used for audio.
* `key` (`"1=B"`) transposes the diatonic degrees. **Middle 1 = C = MIDI 60**,
  so `key=1=C` puts degree 1 / `o=0` at MIDI 60 and `key=1=B` at MIDI 71 (B4);
  degree 7 in B is MIDI 82 (A#5). Degrees use the diatonic steps
  `1,2,3,4,5,6,7 -> 0,2,4,5,7,9,11` semitones, `o` adds `12*o`.
* No implicit repeats, ties or lyrics handling; rests consume time and never
  produce audio or a landing.

Invalid input (unknown `n`, missing/zero/negative `q`, non-finite or non-positive
`tempo_qpm`, bad `key`, unknown `format`) fails **before rendering**, quoting the
file plus `L<line> N<index>`.

## Timing and motion model

* One absolute-time event list: `t = lead + (cumulative q) * 60 / tempo`.
  Every onset is computed from that single formula — no per-note rounding and no
  accumulated frame counts.
* Frames are sampled at exactly `frame_index / fps`, so a landing may fall
  between two frames (visual sampling error ≤ 1 frame) and onsets are placed at
  `round(t * sample_rate)` (audio onset error ≤ 1 sample).
* Motion is deterministic and analytic (no physics). The timeline is an explicit
  list of contiguous segments — a **hold** on a board for
  `min(note duration, gap/2, 0.8 s)`, then a **hop** parabola spanning the whole
  remaining gap — so every dwell interval is covered and no time can fall through
  to the wrong board (`score.check_segments()` fails loudly on a gap). The
  parabola is 0 at both ends, so a landing is exactly on the board surface
  (`ball centre = board top + ball radius`) and the path is continuous.
* The lead-in starts on a **start pad** one board behind board 0, so the first
  note is reached by a visible arriving hop instead of the ball sitting still
  and flashing.
* Boards advance one fixed step (`1.05 m`) along +X per sounding event with a
  gentle Z weave; board height follows the pitch, clamped to ±24 semitones, and
  the hop height is clamped to 0.9 m — so long notes cannot produce extreme leaps.
* Audio and animation come from the same list; the plan JSON written to the
  work directory contains everything the renderer uses.

## Coordinates (plan vs Blender)

The plan is **Y-up** (`x` = track, `y` = height, `z` = lane); Blender is **Z-up**.
Every plan coordinate crosses the renderer boundary through
`render_scene.to_blender()` (`x, y, z -> x, z, y`): board thickness becomes
vertical, support posts grow along Blender +Z from the floor to the board
underside, particles base at the ball, and the camera offsets are written in
Blender axes. The floor is a single Blender XY plane at `z = 0`, sized from the
plan itself (`ground_bounds()`: board extents plus a 40 m margin on every side),
so a longer song gets a longer floor instead of being rejected by a fixed
extent. The margin is what keeps the floor's edge out of frame — at the render
angle any edge is projected outside the picture, so there is no horizon line.
The factory-startup cube/light/camera are removed before the scene is built.

The camera is **orthographic** (`ortho_scale 8.0`, offset `(-3, -6, 5.5)`,
aim point `0.6 m` ahead of the ball on the smooth track line). For the portrait
360x640 frames that is a 4.5 x 8 m window: about four board pitches across, the
ball is a small pearl of ~4 % of the frame height, and it stays fully inside the
frame through the whole hop (asserted in `tests/test_render_geometry.py`).

## Outputs and layout

`--output` (default `ball3d/out/<name>_ball3d.mp4`) is H.264 / `yuv420p` + AAC,
360x640@30fps for previews, 720x1280 for finals. Output must end in `.mp4`, the
dimensions must be even (yuv420p), and the input file is never overwritten (the
CLI compares resolved paths and refuses when `--output` aliases the input).

Each run gets a **fresh unique** temp directory next to the output —
`<outdir>/<name>.ball3d.XXXX/` with `plan.json`, `audio.wav`,
`frames/frame_%06d.png`, `silent.mp4` — so a shorter rerun can never encode stale
frames from a longer one. Its resolved path is verified to be exactly the
directory that was just created inside the output parent; `--clean` removes only
that directory. Frames are kept by default so renders can be inspected — because
each run gets its own directory, old `<name>.ball3d.*` directories can be deleted
by hand once a render has been reviewed.

The renderer fails loudly instead of silently: Blender runs with
`--python-exit-code 1`, EEVEE Next and the requested sample count are verified
rather than assumed, the rendered frame names are checked **exactly**
(`frame_000001.png` … in order, both in the renderer and again in the CLI before
muxing), and the encode is bounded with `-frames:v` — no muxing of a half-rendered
sequence.

## Performance (2026-10-10)

Independent before/after benchmark: the same first 10 seconds of `10_notes.json`,
720x1280, 30 fps, 16 EEVEE samples, 300 frames, unchanged camera, lights, geometry,
audio and encoding settings. Both runs used the same machine and included the
CLI, Blender render and MP4 encoding.

| Measurement | Baseline | Optimized |
| --- | --- | --- |
| Wall time | 233.67 s | 107.33 s |
| Frame count | 300 | 300 |
| Dimensions / fps / samples | 720x1280 / 30 / 16 | unchanged |

The measured speed ratio is 2.177x (54.07% less time). This is one benchmark pair,
not a full-song or sustained-batch measurement. A linear full-song extrapolation
is around 31 minutes, not a guarantee.

Changes:

- One Blender animation render replaces one separate render invocation per frame.
  A frame-change handler samples the unchanged analytic motion at `(frame-1)/fps`.
- Immutable star materials share palette entries (4 used in this song, up to 5).
  Animated board materials remain independent, so unrelated boards do not glow.
- PNG compression is 10 rather than the default 15; pixel storage remains lossless.
- Handler exceptions and missing callbacks reject the render, and exact frame
  filenames/count are still validated before encoding. Build/render timing and
  scene counts are logged.

All boards and shadow casters remain; spatial culling, lower shadow quality,
resolution/frame-rate/sample reductions and renderer migration are not part of
this change. The scene has 678 objects and 343 materials for the fixture.

Reviewer verification: 73 tests passed. All 300 decoded PNG frames were compared;
284 are byte-for-byte equal as pixel arrays. The remaining frames have only 58
changed RGB components in total, maximum channel difference 2/255. Generated WAV
files are byte-identical. Both MP4 files fully decode with 300 frames at 30 fps.
See [the performance report](PERFORMANCE_REPORT.md) and
`out/perf_20261010/comparison.json` for the evidence.

## Files

| File | Role |
| --- | --- |
| `make_ball_video.py` | CLI: validate, plan, synthesize WAV, call Blender, mux MP4 |
| `score.py` | pure-stdlib parsing, validation, pitch model, timing, motion plan |
| `audio.py` | synthesized melody → 16-bit WAV (numpy) |
| `render_scene.py` | Blender 4.5 / EEVEE scene: boards, posts, sun, pearl, stars, follow camera |
| `tests/test_score.py` | unit tests (CPython, no Blender needed) |
| `tests/test_render_geometry.py` | plan Y-up → Blender Z-up conversion, boards/posts/ground/camera (no Blender needed) |
| `tests/test_cli.py` | CLI validation, per-run temp dirs, frame bounds, batch collisions, `--plan-only` end to end |

## Known limitations

* **No lyric text is rendered in v1 — this is deliberate.** The plan keeps the
  `lyric` strings (and a test asserts they survive into `plan.json`), but drawing
  them would need a CJK-capable font: Blender's bundled font has no CJK glyphs,
  no system font is added and nothing is downloaded, so text is omitted with this
  explanation rather than drawn as broken boxes. Supporting CJK lyrics therefore
  remains optional for a later version.
* The camera is a plain analytic oblique follow (fixed offset, no easing) that
  tracks `sample_track()` — the smooth line under the hops — for both its
  position and its aim point, so it does not pitch up and down with each hop.
  Fast 16th-note passages still move quickly across boards.
* Verified outputs include a 12-second 360x640 preview, two short batch fixtures, and the same-settings 10-second 720x1280 performance comparison. Full-song performance with this optimization has not been measured. The result is not claimed to match the reference video.
* Lighting is hand-tuned constants (neutral gray world/floor, dark boards,
  saturated contact-light palette, one coloured point light at the current
  landing) rather than a physically calibrated setup; the floor halo is a light,
  because EEVEE emission on a material does not illuminate the floor.
* The MVP renders **all** frames of the requested duration through Blender in one
  process; a full song at 720x1280 takes minutes. `--seconds` is the fast path.
* OCR correctness of the input JSON is not validated or asserted — only the
  documented counts/timing of the fixture are checked.
* Rendering needs EEVEE; Cycles is untested. Blender < 4.2 lacks
  `BLENDER_EEVEE_NEXT` and the renderer does not fall back to the legacy look.
  EEVEE also needs a usable GPU even in background mode, so a software-only
  machine will fail with a GPU/OpenGL error from Blender.
* Batch mode is sequential and stops at the first failure.


