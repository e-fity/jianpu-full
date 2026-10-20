# 彩色木板音乐装置：实现与审核报告

2026-10-10。需求见 `MUSIC_MACHINE_REQUIREMENTS.md`。状态：首版实现和技术审核完成，待用户视觉审核，未声明与参考视频完全一致。

> **后续更新（同日，窄板间距版）**：木板已从 0.60 m 缩到 **0.30 m 宽 × 0.06 m 厚 × 0.40 m 深**，球半径 0.22 → **0.10**，
> 渲染器默认加载 `assets/music_machine_compact.glb`（`--preset compact`），并在运行时量取真实载入的网格、
> 与 `realtime/src/layout.mjs` 的碰撞常量不符就报错。整曲 5276 帧、`forced == 0` / `clearance_fails == 0` / 板与板不互相穿插，
> 一键 CLI 导出已通过（`ERR_STRING_TOO_LONG` 根因是整段视频单次 POST 被浏览器镜像成超 512 MiB 的协议消息，已改为 2 MiB 有界分块上传）。
> 样片、抽帧、二维预览与实测数据见 `out/natural_fall_spacing/NATURAL_FALL_SPACING_HANDOFF.md` 与同目录 `delivery.json`。
> 本文以下内容描述首版 0.60 m 装置的实现与审核，仍可用于对照。

## 开发与审核

已将需求交给本机 Claude Code，通过 CC Switch 已保存的 DeepSeek 服务，以 `deepseek-flash`（DeepSeek-V4.1-Flash）运行。Claude 完成初版及一次审核修订；Codex 独立运行 Blender、测试和整曲导出，并修复审核中发现的问题。开发子进程不修改全局供应商，不在项目保存凭证。

主要修复：过宽分组、跨排穿板、滑槽入口擦碰、过曝丢失底色、模型预览相机、可见物体池容量、旧风格兼容。原开发交接草稿保存在 `out/music_machine_v2/claude_handoff_draft.md`，其未验证说明不代表最终状态。

## 实现

- `assets/build_music_machine.py`：Blender 生成带倒角木板、小接头、细弯铜支臂和圆底座，输出 `.blend`、嵌入木纹贴图的 `.glb` 和近景预览。GLB 的 Board/Arm/Foot 网格被实时场景实际加载。
- `realtime/src/layout.mjs`：2D/3D 共用编排；按音长、休止、密度和音高分组，横排、浅弧、斜排、单板变化，每组最多 5 块。同一输入和 seed 可重现。
- 长音候选要求至少 1.0 秒且 1.5 拍；休止候选至少 1.2 秒。还需跨组、可用时间至少 0.7 秒、端点距离至少 0.85、垂直落差至少 2.8、路径平均速度不超过 4.2；不满足时使用跳跃。各滑槽记录触发原因。实际槽底、侧沿和球路径共用曲线。
- `music_machine.mjs`、`instance_glow.mjs`：实例化 GLB，按板染色；命中板同色亮起并衰减，保留木纹。镜头总体下移，球反弹后继续下降。
- `make_layout_preview.py`、`preview2d.mjs`、`preview_build.mjs`：单文件 HTML 编排预览，显示路线、时间轴、休止和滑槽原因，可拖动时间；不播放音频。
- `make_realtime_video.py`、`export.mjs`、`export_session.mjs`：默认新风格 `music-machine`，保留 `classic` 和旧 `wood-drop` 用于对照；沿用 JSON、音频、批量及快速视频输出。
- 原 `score.py`、`audio.py`、Blender 视频入口及 classic 场景文件 SHA256 与开发前一致；未改根目录已有用户修改。

## 实际验证

- Python：84 项通过；JavaScript：90 项通过。
- 验证同输入可重现、不同曲目、单音/空编排、短音、长音、休止、精确 onset 接触、段间连续、GLB 网格及尺寸、二维预览导出。全休止输入仍遵循原解析器规则拒绝生成，并不承诺生成全休止视频。
- 真实《孤勇者》：335 个发声音符、42 个休止、80 组、14 条滑槽。全曲球与木板 OBB 检查通过；实际滑槽三角面密集采样检查通过，曲面离散容差 0.003（球半径 0.22，最小实测间距 0.217623）。这不是所有可能输入或装饰件的完整物理证明。
- Edge 打开最终二维 HTML，无页面错误，两个画布和时间滑块可用。
- 12.2 秒混合短片：366 帧全部解码通过，包含短音、长音与休止，最终版本 CLI 实测约 7 秒。
- 真实整曲：720×1280、30 fps、175.838 秒、5276 帧，H.264 + AAC；全部帧解码通过。端到端实测 **49.76 秒**，其中 CLI 49.39 秒、浏览器导出约 36.02 秒。GPU 为 RX 6500 XT，H.264 软件编码。这是本机单次结果，不是其他歌曲或长期批量保证。
- 整曲 WAV 与上一版逐字节相同。音频仍是 JSON 合成旋律，没有原唱或伴奏。
- 已抽查开头、35.37 秒滑槽衔接、中段和末尾图像；未见后段模型消失。详细证据在 `out/music_machine_v2/full_timing.json`、`full_wall.json`、`trough_validation.json`、`delivery_validation.json`。

## 交付文件（绝对路径）

- 需求：`D:/Letter piano jk/ball3d/MUSIC_MACHINE_REQUIREMENTS.md`
- 模型：`D:/Letter piano jk/ball3d/assets/music_machine.blend`、`D:/Letter piano jk/ball3d/assets/music_machine.glb`
- 模型预览：`D:/Letter piano jk/ball3d/out/music_machine_preview/oblique.png`、`palette.png`、`hit_before.png`、`hit_after.png`
- 混合审核样片：`D:/Letter piano jk/ball3d/out/music_machine_v2/mixed_review.mp4`
- 整曲：`D:/Letter piano jk/ball3d/out/孤勇者_彩色音乐装置_待审核.mp4`
- 二维预览：`D:/Letter piano jk/ball3d/out/music_machine_v2/layout_review.html`
- 整曲抽帧：`D:/Letter piano jk/ball3d/out/music_machine_v2/full_contact.jpg`

## 运行命令

在项目目录 PowerShell 运行；资产已生成，通常无需重建。

```powershell
# 整曲；换 --input 即可处理另一份相同格式 JSON
& D:/python/python11/python.exe ball3d/make_realtime_video.py --input D:/Downloads/10_notes.json --style music-machine --node D:/node/node.exe --output "D:/Letter piano jk/ball3d/out/孤勇者_音乐装置.mp4"
# 二维编排
& D:/python/python11/python.exe ball3d/make_layout_preview.py --input D:/Downloads/10_notes.json --output "D:/Letter piano jk/ball3d/out/孤勇者_编排2d.html"
# 验证
& D:/python/python11/python.exe -m pytest ball3d/tests -q
& D:/node/node.exe --test 'ball3d/realtime/tests/*.test.mjs'
# 需要修改模型时才重建
& D:/apps/Blender/blender-4.5.3-windows-x64/blender.exe -b -P ball3d/assets/build_music_machine.py -- --render-previews
```

以上模型构建和测试实际执行过；最终整曲通过 `out/music_machine_v2/render_review.py --full` 执行相同导出入口，额外保存计时及抽帧。二维预览也已实际生成并浏览器检查。

## 共同视觉审核与限制

待用户确认以下三项，不能提前标为通过：

1. 木板厚度、木纹、细支架和圆底座是否接近参考；当前木纹偏规则、阴影偏硬，质感尚有调整空间。
2. 排列是否足够自然；目前虽由歌曲决定分组与形状，横排仍偏多，属于有限形状规则，尚非对乐句的高级理解。
3. 同色亮起是否够明显、球的反弹及滑槽入口/出口是否顺畅；使用控制路径而非自由刚体物理，位置连续不等于全程速度/加速度物理连续。

未加入歌词、简谱图片识别或社交界面。未做数百首连续耐久测试；视频仍在浏览器内存中完成封装。支持按 JSON 顺序批量，但长期无人值守的稳定性需另行验证。
