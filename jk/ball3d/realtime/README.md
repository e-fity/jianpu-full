# 快速 3D 音乐弹球视频

JSON → 原有 `score.py` 时间轴和 `audio.py` 合成旋律 → Three.js → canvas-record / WebCodecs H.264 → FFmpeg 合成 AAC。

使用本机 Edge，无界面逐帧导出，不是录屏。歌曲时间按 `帧序号 / fps` 推进，机器快慢不影响小球落点。保留 Blender 命令，快速版使用独立入口。

## 当前默认：沿墙向下掉落与七色击中光晕

用户已确认安装方向为板面朝上、长轴朝墙外伸出。`spatial.wallMounted=true` 开启当前默认，保留 `reference_planks.blend:Plank_02_Ivory` 的原始长宽厚比例，名义显示尺寸为 0.21×1.060749×0.038780m，每板由 seed 控制等比缩放至 90%–110%。背端插入墙面；下降基线 0.42m 结合音符间隔、±20% 随机量及音高 EMA 起伏。取消固定格点与强制左右大跳，允许同侧连续落点；放置时检查动画板体、固定歌词和多个视角，冲突则重采样或增加该步下降距离。所有动画由绝对时间 t 求值。

转向与真实板面一起求解：选择下一块落点时，用前一块的 `normalize(v_out-v_in)` 设置其顶面法线，静止倾角不超过 15°；超过上限或接触不安全的候选重新选择，并预探后续接触，必要时回退排布。球心距离真实顶面恰好一个半径，杆和背端的位置按同一姿态计算。自由飞行的横向速度恒定，方向变化发生在击板或圆弧轨道上。轨道改变两端速度后也必须重新求两块板的法线并检查碰撞、投影和间距。每跳仍使用 `max(y0,y1)+0.7D` 的原顶点公式。

短节奏按 seed 预排为通常 3–6 个音符的同侧小组，较长停顿会提前结束小组；组内落点小幅往返，组间自然换侧，不要求每跳换侧或固定跨越距离。倾角仍由实际反弹决定，不为制造交替效果伪造板面法线。相邻同音中少量候选先尝试同高连接，不安全时回落到下降落点，整体下降但不再要求逐板下降。同高板先成对预留：统一两板及前后连接的深度，前一块落点必须预留同高出口；普通相邻板的投影留白下限由 .02 增至 .04。困难同高组合经有限重试后放弃并记录，其他候选继续保留。当前真实曲子有 5 组可见同高板（约 50.58、59.12、81.97、108.74、159.51 秒）；逐对截图中，击打前画面高度差均小于 0.5 px。整曲初次求解实测约 104 秒；验收见 [可见同高板报告](../out/wall_course/VISIBLE_LEVELS_ACCEPTANCE.md)。

木板由两侧固定短杆支撑，受击后板头下压约 3°–6°，以 ζ=.2、ω=30 的相位余弦响应回弹；铰链水平限位避免回弹顶到长间隔时缓慢离开的球。未击打时为近黑色、发光为零；击打后按 1–7 发出红、橙、黄、绿、青、蓝、紫自发光、柔和墙面光斑及局部照明，0.05 秒亮起后以约 0.6 秒衰减。歌词始终居中位于各自木板下方，8 px 固定间距。

仅满足 `Δt≥max(1秒,3.5Δ0)` 的间隔可使用细金属双轨圆弧，最多 3 条且间隔至少 8 秒。入口与出口飞行各不少于 0.25 秒；水平圆弧的滚动速度和势能恒定，入口保持飞行的切向速度，出口允许起跳冲量。其他间隔使用原顶点公式单跳。长音和滑音本身不触发轨道，开关只调整合格候选的优先级。当前网页验收见 [转向修正报告](../out/wall_course/TURNING_ACCEPTANCE.md)；旧视频和旧报告保留作历史记录。

球材质参数面板提供“柔光粉白”与“原版玻璃”对照按钮。镜头跟随低频支撑路径，限制横向跟随幅度，当前球径目标为画宽 7.4%。下落基线取代旧空间模式的全曲 ±4D 高度限制，总高差和相对基线的音高起伏分别报告。

关闭 `spatial.wallMounted` 可查看下面保留的自由空间模式；再关闭 `spatial.enabled` 回到更早的统一重力模式。

## 保留的自由空间 3D 模式（2026-10-13）

默认开启 `config.json` 的 `spatial.enabled`，D 指球直径（默认 0.20m），板宽为 1.25D（0.25m）。

- `spatial.seed=20261013` 驱动全部布局随机数。Catmull–Rom 样条作平缓 S 形参考线，沿弧长按 `clamp(speed×Δt, minStepWidths×板宽, maxStepWidths×板宽)` 前进，初始偏移为左右 1–2 板宽。多视角投影检查只调整横向偏移，最终允许最多约一板宽的修正。保持每块板的起音与音高不变。
- 音高 EMA 的时间常数为两小节，按谱面 meter 和 tempo 换算。高度用 `4D*tanh(pitchScale*D*(pitch−EMA)/(4D))`，再限制相邻高差；对倾斜接触面留出几何余量。板 yaw 为样条切线加带 seed 的 ±35°，基础倾斜沿反射冲量，至多 15°，另加 ±8° 随机倾角。真实板中心间距至少两板宽。
- 每段自由飞行的顶点是 `max(y0,y1)+0.7D`，由该顶点和时长求本跳 g、v0。水平分量匀速；不存在统一 g、额外弧高、休止加高。首跳也使用同一公式。
- 轨道只从 `Δt≥max(1秒,3.5Δ0)` 的间隔中选，全曲最多 3 条，候选起点至少相隔 8 秒。薄金属水平圆弧，弧长不超过 4 板宽，入口/出口飞行各不少于 0.25 秒。圆弧高度恒定，势能与滚动速度恒定，球旋转由解析式按 t 求值。出口起跳允许冲量；能量守恒范围是轨道内部。碰撞不安全的候选回退为普通单跳，不添加额外高度。
- `longNoteRails`、`glissandoRails` 默认 false。开启只让满足长间隔门槛的长音/滑音候选优先，仍遵守全片上限、间距与弧长限制；长音或滑音本身不会绕过门槛生成轨道。
- 固定支杆长 0.8 板宽（允许 0.6–1.0），只有板绕杆顶摆动。自发光和 ζ=.2、ω=30 的阻尼余弦响应按绝对时间重算。空间模式移除原墙面，保留原参考木板模型、玻璃材质、HDR 和景深；歌词在景深后清晰绘制，按当前投影避开球、板面和相邻文字。
- 镜头高斯平滑过去 2 秒、未来 3 秒，σ=1 秒，只采样支撑路径，不采样跳跃抛物线。构图基准位于画面纵向 35%；自然跳跃保留在基准周围。球画宽目标 7.7%，前方展示最多 10 块，远端背后用相机 far 平面裁剪。30 秒验收中完整可见前方 7–10 块。镜头与球占屏参数影响投影排布，改变时会重新解布局并更新缓存。
- 所有动画是绝对时间 t 的纯函数。视频按 `t=start+frame/fps` 渲染，并对选定关键帧倒序重新渲染，检查 PNG 字节一致性。

最新 [验收报告](../out/spatial_course/ACCEPTANCE.md) 和 [30 秒视频](../out/spatial_course/spatial_30s_final.mp4)。输入仍为原始《孤勇者》谱面 JSON；声音沿用谱面合成旋律，无人声，并非原唱录音。导出打印空间统计，同时写入视频同名 `.acceptance.json`；其中 PASS/FAIL 是逐帧量测结果，数值不会用布局估计替代。

`spatial.enabled=false` 可回到此前的统一重力/长音滑音轨道后端。旧代码的回归测试显式使用该模式，历史验收保留在 [expressive_rails](../out/expressive_rails/ACCEPTANCE.md)，不代表当前默认规则。

## 可选音符字段

```json
{"n":3,"q":1,"duration_sec":0.6,"pitch_bend":[
  {"time_sec":0,"semitones":0},
  {"time_sec":0.3,"semitones":2},
  {"time_sec":0.6,"semitones":-1}
]}
```

`duration_sec` 是真实 note-off 对应的正持续时间；它不改变后续音符的起音。省略时使用 `q×60/tempo_qpm`，plan 标记 `duration_source=score_q`，仅代表谱面时值推算；显式字段标记为 `note_off`。事件同时保存 `score_dur_sec`。`pitch_bend` 是非空点列表，时间相对本音起音、严格递增且位于 `[0,duration_sec]`，音高以相对本音 MIDI 的半音数表示（最终音高须在 MIDI 0..127）；缺少零时刻点时从 0 半音插值，末点之后保持。所有数值必须有限，休止不允许这两个字段。保留旧 sustain/glissando_to；pitch_bend 与 glissando_to 同时出现会报错。音频使用同一持续时间与滑音点，note-off 后仍有短暂音色释音。

参数及范围分别位于 `config.json` 的 `tracks` 组与 `presentation_limits.json`，lil-gui、缓存、后端校验、编辑器和导出共用。原曲没有 note-off/pitch bend 信息，不将其推算时长冒充实测时长。独立夹具在 `../tests/fixtures/expressive_notes.json`。


## 使用

在 `D:/Letter piano jk` 运行整曲：

```powershell
# 先用 Blender 生成一次木板资产（.blend + .glb）
& "D:/apps/Blender/blender-4.5.3-windows-x64/blender.exe" -b -P ball3d/assets/build_reference_music_machine.py

python ball3d/make_realtime_video.py --input "D:/Downloads/10_notes.json" --style music-machine --output "D:/Letter piano jk/ball3d/out/孤勇者_音乐装置.mp4"
```

默认 `--style music-machine` 加载 `assets/reference_music_machine.glb` 中的彩色木板和金色双轨；木板源模型为 0.30×0.06×0.50m，默认显示为 0.25m 方板，球半径 0.10m。短支撑杆按配置生成固定几何。JSON 继续使用 `jianpu2letter-notes-v1`；休止不生成落点，原合成旋律保持不变。

加 `--style classic` 使用之前的横向踏板跳跃版；`--style wood-drop` 保留旧版木板效果用于对照。默认都是 720×1280、30 fps、约 8 Mbps、开启发光。加 `--seconds 10` 生成前 10 秒。

历史版二维编排预览（仍使用旧 `layout.mjs`；查看当前轨迹请用 `/editor`）：

```powershell
python ball3d/make_layout_preview.py --input "D:/Downloads/10_notes.json" --output "D:/Letter piano jk/ball3d/out/孤勇者_编排2d.html"
```

批量读取一个目录内的 JSON（`--limit` 默认 3，请明确填写要处理的数量）：

```powershell
python ball3d/make_realtime_video.py --batch "D:/歌曲JSON" --limit 100 --out-dir "D:/Letter piano jk/ball3d/out/batch" --clean
```

批量按文件名顺序执行；遇到错误停止并返回非零退出码。`--clean` 成功后删除本次中间文件，保留最终视频；调试时去掉它可保留计划、WAV、浏览器视频和计时。导出失败不会继续合成半成品。命令允许覆盖同名输出视频。

## 安装与验证

当前电脑已安装依赖。另一台机器需 Python（numpy、imageio-ffmpeg）、Node.js、Microsoft Edge，然后：

```powershell
npm ci --prefix ball3d/realtime --ignore-scripts
python -m pytest ball3d/tests -q
node --test ball3d/realtime/tests/*.test.mjs
```

运行不需要联网或下载浏览器。依赖版本锁定在 package-lock.json。

## 实现与边界

- 音符起始时间、音高、q 和休止时长保留。未标注 articulation 时，原合成音频保持不变；明确延音会保持音量到音符结束，明确滑音会连续改变音高。音频是合成旋律，不含原唱和伴奏。
- Blender 源模型经 `build_reference_music_machine.py` 导出，木板使用烘焙木纹与实例颜色；滑道的双轨和挂件使用真实导出网格，根据共用轨迹定位。
- 当前输入的 335 个音符生成 282 块木板、53 条长音轨道、336 段自由飞行，音符和休止数量及起音不变。
- 普通跳跃为统一重力的解析抛物线，滚轨道为能量积分曲线；由音乐时间编排，不运行刚体仿真。
- 独立的逐实例颜色和发光避免其它踏板一起闪烁。场景/相机转换保持原构图；移动物体池关闭缓存范围裁剪，避免长曲后段消失。
- 球的软阴影按轨迹高度解析控制；木板和杆另使用 Three.js 的软阴影。画面与 Blender 不逐像素相同。
- 日志记录实际 WebGL 显卡。此机 RX 6500 XT 用 GPU 绘制，H.264 为软件编码。速度以本机实测为准。
- 编码器队列等待背压，最终 MP4 在浏览器内存中完成后分块（每块 2 MiB，共 N 块，按序校验总数）上传本机回环服务；单次请求体曾是整段视频，浏览器把请求体镜像进 DevTools 协议时 106 MB 会变成约 583 MB 的单条消息，超过 Node 约 512 MiB 的字符串上限（`ERR_STRING_TOO_LONG`），因此改为有界分块。已验证 175.8 秒整曲（60,914,377 字节 = 30 块）及两份不同 JSON 的顺序批量，未做数百首无人值守耐久测试。
- 网页编辑器和默认视频导出共用重力轨迹模块；二维预览保留旧方案。简谱图片需先转换为支持的 JSON。

历史参考模型版使用上传的 `10_notes.json` 导出 175.838 秒、5276 帧的整曲，720×1280、30 fps，H.264 + AAC，完整解码通过。本机端到端用时 45.2 秒；性能会随设置和机器变化。该记录为旧版性能基线；本次验收以上面的 expressive_rails 报告为准。

## 上游代码

- [Three.js](https://github.com/mrdoob/three.js)：MIT
- [canvas-record](https://github.com/dmnsgn/canvas-record)：MIT
- [Mediabunny](https://github.com/Vanilagy/mediabunny)：MPL-2.0，canvas-record 的编码封装依赖
- [Playwright](https://github.com/microsoft/playwright)：Apache-2.0
- [esbuild](https://github.com/evanw/esbuild)：MIT

上游许可证保留在安装包中，打包保留许可证注释。发布分发版本时应一并保留相关许可证。
