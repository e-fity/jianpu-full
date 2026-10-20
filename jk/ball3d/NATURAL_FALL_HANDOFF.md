# NATURAL_FALL 交付说明（第 2 轮收尾）

**结论一句话**：本轮把「自然下坠 + 真实倾斜板反弹」做成了可跑、可审、可回滚的实现并渲染出真实 MP4；
但**真实歌曲的密集段落仍有实质性穿板**，因此按评审指示：实验版源码隔离保存、`realtime/` 与测试
**已恢复到 `out/natural_fall/before.zip` 基线**（网页按钮回到已验收版本），样片只作为**实验交付**，
**不是生产版本**。没有声称密集段落的碰撞已解决。

---

## 1. 交付物（绝对路径）

### 1.1 视频（全部为本轮实验版代码真实渲染，720x1280 / 30fps / H.264 yuv420p + AAC）

| 文件 | 内容 | 时长 | 帧数（实测解码） | 字节 |
|---|---|---|---|---|
| `D:/Letter piano jk/ball3d/out/natural_fall/natural_descent_demo.mp4` | 代表性演示：自然下坠、倾斜板转向、长音高弹、逐音精确落点 | 19.400 s | 582 = 582 | 5,544,676 |
| `D:/Letter piano jk/ball3d/out/natural_fall/song_sample.mp4` | 真实曲 `D:/Downloads/10_notes.json` 前 20 s | 20.000 s | 600 = 600 | 9,096,206 |
| `D:/Letter piano jk/ball3d/out/natural_fall/full_song.mp4` | 真实曲全曲（孤勇者，335 音符 + 42 休止） | 175.838 s | 5276 = 5276 | 109,622,151 |
| `D:/Letter piano jk/ball3d/out/natural_fall/baseline_restored_check.mp4` | 恢复基线后的自检片段（证明恢复后的代码可渲染） | 4.000 s | 120 | 1,182,737 |

- 演示与 20 s 样片由流水线一次跑完（`EXIT=0`，写了 `timing.json`）；渲染耗时见第 2 节。
- **全曲的 `timing.json` 缺失**：画面 5276 帧全部渲染并落盘到 `browser.mp4`（106,484,638 字节），
  但 Playwright 控制通道在传回成品文件时抛出 `ERR_STRING_TOO_LONG`（单条消息超过 V8 字符串上限），
  进程在写 `node.json`/`timing.json` 之前就退出了。我用流水线自带的 `mux()`（ffmpeg，
  `-c:v copy -c:a aac`）把 `browser.mp4` + `audio.wav` 合成了 `full_song.mp4`，
  并用 `count_video_frames()` 解码校验得到 5276 帧。**这是渲染器的一个已知规模限制，不是画面缺失。**

### 1.2 2D 预览（与 3D 共用同一份 `layout.mjs` 数据；显示板面倾角、板面法线、球路径、主动击板环、审计面板）

- `D:/Letter piano jk/ball3d/out/natural_fall/preview_demo.html`
- `D:/Letter piano jk/ball3d/out/natural_fall/preview_song20.html`

### 1.3 复核用抽帧 / 拼图（ffmpeg 从上面这些视频直接解码）

- `out/natural_fall/demo_contact.jpg`（演示 20 格拼图）
- `out/natural_fall/song_sample_contact.jpg`（真实曲 20 s 拼图）
- `out/natural_fall/full_song_contact.jpg`（全曲 8 格拼图）
- `out/natural_fall/frames/demo_apex.png`（长音高弹顶点）、`demo_strike.png`、`demo_mid.png`
- `out/natural_fall/frames/sample_f5.png` / `sample_f12.png` / `sample_f18.png`
- `out/natural_fall/frames/full_t26.png`、`full_t100.png`（**缺陷区**：密集段落的板堆叠/倾斜聚簇）

### 1.4 实验版源码隔离（可回滚、可复核）

- `out/natural_fall/natural_fall_src/`（本轮改动过的 5 个文件的完整副本）
  - `realtime/src/layout.mjs`、`realtime/src/music_machine.mjs`、`realtime/src/preview2d.mjs`
  - `realtime/tests/layout.test.mjs`、`tests/test_realtime_video.py`
  - `diff_vs_before.patch`（相对 `before.zip` 基线的 unified diff）
- 基线与实验版的差异**只有这 5 个文件**（逐字节比对确认，其余 21 个快照文件字节相同）。

### 1.5 可复现的审计数据

- `out/natural_fall/audit_report.json`：用**隔离副本**里的 `layout.mjs` 重新构建 demo / 20 s / 全曲三种
  layout 的 `audit` 与 60 点全路径球-OBB 扫描直方图（脚本 `out/natural_fall/audit_report.mjs`）。
- 其它测量脚本：`smoke.mjs`、`hist.mjs`、`window.mjs`（分时段统计）、`thr.mjs`（密度阈值）、
  `pen*.mjs`、`dbg*.mjs`、`ffmpeg_path.txt`。

---

## 2. 渲染实测（本轮，未沿用上一轮任何数字）

来自 `out/natural_fall/demo_timing.json` / `song_sample_timing.json`（流水线自己写的 JSON）：

| | 演示 | 真实曲 20 s |
|---|---|---|
| 帧数 / 时长 | 582 帧 / 19.400 s | 600 帧 / 20.000 s |
| 解码校验帧数 | 582 | 600 |
| CLI 总耗时 | 7.94 s（node 6.91 s） | 8.05 s（node 7.06 s） |
| 浏览器 setup / update / encode | 741 / 1164 / 2609 ms | 1103 / 1237 / 2425 ms |
| 场景 | music-machine，23 板位、5 组、seed 3601343228 | music-machine，222 板位、1 滑槽、80 组、seed 1074576649 |
| WebGL | ANGLE (AMD Radeon RX 6500 XT, D3D11)，非软件渲染 | 同左 |

全曲：5276 帧全部渲染完成并解码校验通过；`browser.mp4` 17:07-17:08 落盘，分块 mux 2.4 s。
**没有把上一轮 50 s 的结果当作本轮测量。**

---

## 3. 本轮代码改动（相对 `before.zip` 基线）

- `realtime/src/layout.mjs`：600 -> 1373 行。重写过渡求解（统一重力解析抛体 + 倾角可达域 + 落点/板姿联合选择）、
  `plankPose`/`hingeFor` 基准统一（`centre = hinge + (H/2)·n`，**与 `off` 无关**，这是「off=0.3 但看着居中」那个 bug 的根因）、
  全路径球-OBB 间隙检查（6 个粗采样 + 24 步细扫 + 沿板面最近点解析解）、板堆叠检测，以及审计字段
  （`transitions/flights/chutes/active_strikes/forced/clearance_fails/clearance_fail_deep/plank_overlaps/min_clearance/clearance_scan/...`）。
- `realtime/src/music_machine.mjs`：实例化板按 hinge 旋转（`setFromAxisAngle(Z, -tilt)`），
  支架/底座与板同一 pivot、不脱开；主动击板时板面按记录增益做 0.17 s 阻尼弹动；
  正交尺度与相机抬高放宽（`ORTHO_SCALE 9.5->10.5`、`CAM_LIFT 1.9->2.5`），保住高顶点与落点。
- `realtime/src/preview2d.mjs`：2D 预览按 `board.tilt` 旋转绘制板、画板面法线、主动击板画环，
  新增「本轮运动模型（可审计）」面板。
- `realtime/tests/layout.test.mjs`（269->395 行）与 `tests/test_realtime_video.py`（167->202 行）：见第 5 节。

---

## 4. 运动 / 碰撞模型（可审计）

1. **统一重力** `G = 6.5 m/s2`（`G_VEC = (0,-G,0)`）。每次自由飞行都是解析抛体
   `p(t) = p0 + v0·t + 0.5·g·t^2`，水平速度恒定、竖直加速度恒定；有限差分校验（测试 defect 2）
   断言 `vy = v0y - G·(t-t0)`、`ax = 0`、`ay = -G`。**空中不改向、不插值、不临时改重力。**
2. **碰撞**：法线 `n ∝ (v_out - v_in)`（切向分量被完整保留，不做任意偏转），
   `e = -(v_out·n)/(v_in·n)`。`e <= 1` = 被动反弹；`e > 1` = **主动弹性击板**，
   记录增益（`active_strike_boards` 里的 `e/dv/drop/apex`），渲染里可见板面弹动、2D 预览画环；
   上限 `E_MAX = 5.0`（强制回退 `E_FORCED = 9.0`）。全曲 47 次主动击板，全部可列。
3. **板姿唯一基准**：`plankPose(hinge, tilt, off)` -> `normal = (sin t, cos t)`、`tangent = (cos t, -sin t)`、
   `contact = hinge + (H/2)·n + off·tangent`、`centre = hinge + (H/2)·n`（与 off 无关）、
   `ball = contact + R·n`；`hingeFor` 是其逆。求解器间隙检查、渲染矩阵、2D 预览、测试四处
   **都用 `(centre, tilt)` 这一对数据**。
4. **支撑点**：`off = ±CONTACT_OFF = ±0.30 = W/2`，即球被支撑在它**行进方向的前缘**，
   板不会悬在球已离开的一侧（旧的「落在自己刚离开的板上」就是这样来的）。
5. **倾角可达域（解析）**：`n = (sin t, cos t)`、`s = tan t`，落点条件 `v_in·n < 0`
   化为 `tan t < -v_in.y/v_in.x`，与 `|t| <= TILT_MAX` 相交得到整个可达集合；
   横向位移区间 `dx ∈ [(v_in.x + s_lo·dvy)·T, (v_in.x + s_hi·dvy)·T]`（要求 `dvy > 0`）。
   即「板不能比落上来的轨迹更陡」——这是解析约束，不是调参。
6. **间隙检查**：候选弧对「本板 + 最近 6 块板」做全路径球-OBB 采样（6 个粗分数 + 24 步细扫 +
   沿板面坐标的解析最近点），高弹时另外对上方早期板做 3 点顶点检查；审计里公开
   `clearance_scan = 24`、每块板的 `clearance`、`clearance_fail(_deep)` 与失败清单。
7. **限速/步长**：`VX_MAX 2.2`、`V_MAX 6.0`、单次飞行横向 `STEP_MAX 0.60`、走廊 `X_BAND ±2.1`、
   `TILT_MAX 0.80 rad`；不允许「走到右边后跳回最左」的伪重置（测试 defect 1）。
8. **长音**：间隔越长、同端点下顶点越高（测试断言），长音**不自动**给滑槽；
   滑槽只在真正长的休止（`REST_CHANNEL_MIN = 1.2 s`、可用时间 >= 0.7 s、速度 <= 4.2 m/s）出现。
   全曲只有 **1 条**滑槽：`t0 = 115.669 s`，ride 9.258 s @ 0.606 m/s，休止 12.462 s，落差 7 m。
9. **确定性**：FNV-1a 种子 + mulberry32，无 `Math.random`（测试断言可复现）。

---

## 5. 测试实跑结果（真实执行，未放宽任何穿透阈值）

| 状态 | JS `D:/node/node.exe --test realtime/tests/*.test.mjs` | Python `D:/python/python11/python.exe -m pytest tests -q` |
|---|---|---|
| **实验版（隔离副本里那 5 个文件在树内时）** | tests 92 / suites 22 / **pass 92 / fail 0**（586 ms） | **85 passed**（2.78 s） |
| **恢复基线后（当前树 = 交给网页的状态）** | tests 90 / suites 22 / **pass 90 / fail 0** | **84 passed**（1.80 s） |

实验版新增/改写的关键断言：

- 精确落点：每个 onset 与球心-板面接触误差 `< 1e-9`（实测 8.5e-14）、每段接缝连续（实测 8.5e-14）。
- defect 1（隔行大跳重置）：`|dx| <= STEP_MAX`、走廊有界。
- defect 2（空中变速/转向）：水平速度恒定、`ay = -G`、`ax = 0`。
- defect 3（长音低跳/停顿）：长间隔顶点 > 短间隔顶点、长音无滑槽、`sit <= SIT_MAX`、单次飞行 <= `FLY_MAX`。
- 碰撞：法线单位长度、`e` 范围、主动击板记账（`e>1` 必须记录）。
- 穿透：**0.5 s 及以上间隔必须完全不擦板**（60 点扫描 `count == 0`、`clearance_fails == 0`、`plank_overlaps == 0`，
  四个 fixture，含音高差）；**密集间隔另立一条测试**，只断言「必须被报告」：
  `clearance_fails > 0`、失败清单非空、每条失败都带实测 `clearance`、`clearance_fail_deep <= clearance_fails`、
  `clearance_scan` 公开。**没有把穿透失败改写成通过，也没有删掉旧的兼容性覆盖。**
- Python 侧 `test_realtime_video.py` 把旧的「只按 yaw 判断的盒子探测」换成与求解器同一基准的
  **倾斜球-OBB**（`L.plankDistance`），并新增 `test_supported_spacing_never_touches_a_plank`。

---

## 6. 缺陷与限制（诚实清单，含实测数字）

### 6.1 支持的密度区间（实测，均匀间隔 fixture，16 音）

| 间隔 | `clearance_fails` | 板相交 | 擦碰采样点 | 深穿（球心进板） |
|---|---|---|---|---|
| 1.0 / 0.8 / 0.6 / 0.5 s | 0 | 0 | 0 | 0 |
| 0.45 s | 1 | 0 | 26 | 0 |
| 0.40 s | 1 | 0 | 38 | 0 |
| 0.35 s | 2 | 0 | 124 | 0 |
| 0.30 s | 4 | 0 | 134 | 326 |
| 0.25 s | 5 | 2 | 463 | 145 |
| 0.24 s | 5 | 2 | 314 | 272 |
| 0.20 s | 2 | 12 | 152 | -- |

**>= 0.5 s 是这套「板宽 0.60 / 板厚 0.075 / 球半径 0.22 / G 6.5」机械组件的干净区间。**
更密的间隔在几何上无解：一次 0.25 s 的飞行最多下落 `0.9·0.5·G·T^2 ≈ 0.18 m`，
而板宽 0.60、球半径 0.22，球无法在落向下一块板的同时从上方那块板的下面穿过。

### 6.2 真实歌曲（335 音符）实测

- `transitions 334`、`flights 333`、`chutes 1`、`active_strikes 47`、`forced 6`、`safe_mode_boards 0`，
  横向最大 0.6 m、最大顶点 2.693 m、最大倾角 0.80 rad、`descends true`。
- **间隙**：`clearance_fails = 135/334`（其中 `clearance_fail_deep = 71`）、`plank_overlaps = 44`、
  `min_clearance = 0`。60 点全路径扫描：667 段中 256 段存在「球心比球半径更近某块非落点板」的采样点，
  其中 **38 段的球心已经落在板体内部（d = 0，肉眼可见的穿板）**、63 段 < 0.05、22 段 < 0.10。
- **分时段**（用来区分「干净演示」与「真实缺陷」）：

| 窗口 | 段数 | 亚半径接近 | >0.10 深穿 | 球心在板内 | 最小距离 |
|---|---|---|---|---|---|
| 前 20 s | 82 | 2 | 0 | 0 | 0.1889（约 3 cm 擦入边缘） |
| 前 45 s | 153 | 15 | 7 | 2 | 0 |
| 全曲 | 667 | 256 | 123 | 38 | 0（最早出现在 t ≈ 23.91 s） |

  ⇒ **交付的 20 s 样片基本干净（只有两处 3 cm 级擦边、无穿板），实质性穿板从约 24 s 才开始**；
  全曲视频在 24 s 之后确实会看到球切入板、以及板与板相交（见 `frames/full_t26.png`、`frames/full_t100.png`）。
- **未解决**：这不是「浅/深分类后就当解决了」。分类只是把它公开出来；真正的修法（按密集段落
  一致地缩小机械组件，或全局重排布局）本轮**没有做**，也没有偷偷调阈值让它看起来通过。
- 其它未决：全曲缺 `timing.json`（见 1.1）；主动击板弹动幅度较小（0.010-0.085 rad）但可见；
  相机是固定正交 + 抬高的平滑跟随，没有做逐帧预测。

### 6.3 复核范围的声明

测试与扫描都是**有限采样**（每段 60 点、求解器 24 步 + 解析最近点），**不能证明任意输入下都不穿板**；
上面所有数字都是在这台机器、这些 fixture / 这支曲子上实测得到的。音频包络、音高、音符数与休止静音
**未做任何修改**。

---

## 7. 当前仓库状态与如何恢复实验版

- **当前（交付给网页）状态 = `before.zip` 基线**：`realtime/src/{layout,music_machine,preview2d}.mjs`、
  `realtime/tests/layout.test.mjs`、`tests/test_realtime_video.py` 这 5 个文件已按基线还原（sha1 见 `delivery.json`），
  其余 21 个快照文件逐字节相同、未动。恢复后 JS 90/90、Python 84/84 全过，
  并用基线代码渲染了 `baseline_restored_check.mp4`（120 帧，EXIT=0）——**网页按钮不会落到坏版本上**。
- **想复看实验版**：把 `out/natural_fall/natural_fall_src/` 里的 5 个文件按相对路径复制回原位置即可
  （`diff_vs_before.patch` 是相对基线的完整改动）。复看后可再用 `before.zip` 还原。

复核命令（在 `D:/Letter piano jk/ball3d` 下）：

```
D:/node/node.exe --test realtime/tests/*.test.mjs
D:/python/python11/python.exe -m pytest tests -q

# 2D 预览（与 3D 同一份 layout 数据）
D:/python/python11/python.exe make_layout_preview.py --input out/natural_fall/demo_score.json --node D:/node/node.exe --output out/natural_fall/preview_demo.html

# 重新渲染（实验版；需先从 natural_fall_src 恢复那 5 个文件）
D:/python/python11/python.exe make_realtime_video.py --input out/natural_fall/demo_score.json --style music-machine --output out/natural_fall/natural_descent_demo.mp4 --timing out/natural_fall/demo_timing.json --node D:/node/node.exe --build-dir out/natural_fall/build
D:/python/python11/python.exe make_realtime_video.py --input D:/Downloads/10_notes.json --seconds 20 --style music-machine --output out/natural_fall/song_sample.mp4 --node D:/node/node.exe --build-dir out/natural_fall/build_song

# 重算审计数字（用隔离副本，不需改树）
D:/node/node.exe out/natural_fall/audit_report.mjs > out/natural_fall/audit_report.json
```

---

## 8. 本轮没做的事（范围声明）

- 没有安装任何软件、没有联网取素材、没有动 `web/` 与 `lyric_sync.py` 等根目录未提交的改动，
  没有提交、没有上传、没有删除任何旧视频。
- 没有为了「看起来通过」放宽穿透阈值或删除测试；旧的 `classic`/`wood-drop` 及其测试未动
  （92 个 JS 测试里包含它们，实验版全过）。
- 没有做全局布局重排/按段落缩放组件——这是密集段落缺陷的正解，留给下一轮（或明确接受降级）。

---

## 9. 复核用 plan.json（与视频一一对应）

- `out/natural_fall/demo_plan.json`（演示视频用的 layout plan）
- `out/natural_fall/song_sample_plan.json`（20 s 样片用的 plan；注意 plan 覆盖全曲，`--seconds` 只截取画面）
- `out/natural_fall/full_song_plan.json`（全曲）
- 独立复核：`ffmpeg -i <video> -f null -` 解码计数 = 582 / 600 / 5276 / 120，与 `timing.json` 一致。
