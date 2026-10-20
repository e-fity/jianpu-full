# 自然下落与倾斜木板反弹：Claude Code 开发需求包

日期：2026-10-10。委托对象：外部 Claude Code，DeepSeek-V4.1-Flash。Codex 负责策划和独立审核；本轮实现、测试、样片生成均由受委托开发者执行。完成时必须交回真实 MP4 文件路径，而不只是渲染命令。

## 用户原始要求

“我现在希望小球是自然下落，而不是从右边最后一个木板跳跃到下一行的最左边的木板，要符合自然规律，如果要实现这种远距离跳跃，就把木板斜着放；同理若是有的音比较长，可以让小球弹得高好在小球触碰下一个木板时刚好响起下一个音。”

## 目标与优先级

1. 优先让木板位置适应球的下落轨迹和歌曲时间。取消每排向右走完后大幅向左重置的布局；下一块优先在当前球附近的下方，用自然连续的路线组织整曲。必要折返只能在碰撞时发生，倾斜板面给出可见原因。
2. 自由飞行使用统一重力的解析抛体：p(t)=p0+v0*t+0.5*g*t²。水平匀速、竖直加速度固定，不可在空中 smoothstep 横移、突然改方向、绕前景 Z 偏移穿板或随意按插值控制点拉球。
3. 音符时间不可改。根据相邻发声音符的真实 onset 间隔反求飞行初速度、目标板位置与板面法线。长间隔允许更高的反弹和更长腾空；到达下一块板的时刻恰好是下一音 onset。不要在板上停住很久再快速赶路。
4. 对远距离横移或明显折返，真实倾斜承托面，不能只绕竖轴 yaw 装饰性旋转。记录碰撞前后速度和板面法线；接触点、球半径、显示姿态、碰撞检测使用同一数据。倾斜板与支架连接不能脱开。
5. 音乐同步优先但不可假称严格被动真实物理：任意不规则音长与有限画幅下，单靠固定被动木板未必可实现所有定时弹跳。优先用布局和下降高度解决；若需要供能，明确建模为有弹性的主动击板（轻微可见弹动），记录速度增益和限制，不允许静止木板无说明无限增能。报告采用何种碰撞模型。困难输入应有明确可审计处理，不能悄悄改音频或恢复空中转向。

## 长音、休止与滑槽

- 本次“长音高弹”优先于上一轮“长音候选滑槽”。长音不必自动配滑槽；不改变音频包络、音高、音符个数和休止静音。
- 滑槽仍可用于确实需要的长休止或过渡，不得按固定音符周期生成，不得作为掩盖不连续运动的装饰。保留时须验证入口/出口位置和速度合理衔接、球贴合槽底、不穿侧沿。若本轮有理由减少滑槽，报告规则及实际数量。
- 长音高度与下一音间隔相关：同等端点条件下较长间隔应有更高顶点；不得统一低跳靠慢放凑时间。设置能容纳真实曲目长音的镜头，而非简单截断高度造成节拍错误。

## 画面、输入及兼容

- 保留现有 Blender GLB 彩色木板、细支臂、圆底座、木纹、命中同色亮起、反光球；不加歌词。
- 2D 预览与 3D 共用布局和运动；2D 应能看出板倾角和球路径。相机容纳高弹顶点和落点，下降跟随平滑，无突然追球导致眩晕。
- 新行为更新 `music-machine`，网页已有“小球弹跳视频”自动使用新版。保留 `classic`、`wood-drop` 及原音频/JSON 接口。
- 局限修改于 ball3d；不改根目录网页/歌词未提交工作，不安装软件、不联网取素材、不更改全局供应商或读取凭证、不提交或发布。只有开发调用可连接已配置模型服务。
- 可使用 Read/Edit/Write/Glob/Grep/Bash 执行项目代码与本机 Python/Node/Blender/Edge。禁止清理其他工作目录、删除旧视频、修改原曲谱。保留上一版用于审核对照。

## 验收与测试（必须实际执行）

1. 新增能重现旧缺陷的测试：跨排大回跳、空中变速/转向、长音低跳停顿；改为验证新版规则，不能简单删除不通过的测试或放宽穿透阈值。
2. 统一重力、飞行水平速度、有限差分竖直加速度；所有 onset 触点和相邻段位置连续；碰撞法线/反弹方向一致；倾斜板球面接触和全程 sphere/OBB 检查。记录主动供能（如有）。
3. 实际歌曲 `D:/Downloads/10_notes.json` 的完整 335 音符路径与整曲后段；密集短音、明显长音、休止、单音、混合节奏。检查球、倾斜板、支架、保留滑槽与相机可见范围。声明检查范围，不能声称有限采样证明所有输入。
4. Python 和 JS 测试都运行；更新过时的旧 music-machine 断言以新需求为准，classic/wood-drop 测试继续通过。
5. 生成 15–25 秒代表性样片（含自然下降、倾斜反弹、长音高弹、下一音精确触板），真实曲目前段样片，以及真实整曲。样片必须是本轮代码真实渲染，非旧 MP4 复制或静态图。整曲难以完成时如实交付样片和具体阻碍，不假报成功。
6. 默认 720×1280/30fps，报告实际帧数、解码验证、耗时；不把之前 50 秒结果当本次实测。不要把“用户视觉通过”记为事实。

## 工具、入口及输出

工作目录 `D:/Letter piano jk/ball3d`。Python `D:/python/python11/python.exe`；Node `D:/node/node.exe`；Blender `D:/apps/Blender/blender-4.5.3-windows-x64/blender.exe`；Edge 已安装。Git Bash 下工具用正斜杠绝对路径。环境已经有依赖，不需要安装。

主要文件：`realtime/src/layout.mjs`、`music_machine.mjs`、`preview2d.mjs`、`realtime/tests/layout.test.mjs`、`tests/test_realtime_video.py`。现有说明 `MUSIC_MACHINE_REPORT.md`。基线备份 `out/natural_fall/before.zip`。样片 JSON 可参考 `out/music_machine_v2/mixed.json`，需自行构造充分展示本轮变化的新例。

命令示例（Bash，当前目录 ball3d）：

```sh
D:/python/python11/python.exe -m pytest tests -q
D:/node/node.exe --test realtime/tests/*.test.mjs
D:/python/python11/python.exe make_realtime_video.py --input out/natural_fall/demo.json --node D:/node/node.exe --style music-machine --output out/natural_fall/deepseek_sample.mp4 --timing out/natural_fall/sample_timing.json
D:/python/python11/python.exe make_realtime_video.py --input D:/Downloads/10_notes.json --seconds 20 --node D:/node/node.exe --output out/natural_fall/song_sample.mp4
D:/python/python11/python.exe make_realtime_video.py --input D:/Downloads/10_notes.json --node D:/node/node.exe --output out/natural_fall/full_song.mp4 --timing out/natural_fall/full_timing.json
```

交回 `NATURAL_FALL_HANDOFF.md`：改动清单、运动/碰撞模型、实际测试与渲染命令及结果、已知不足、样片绝对路径。生成 `out/natural_fall/delivery.json`，列出实际存在的视频、时长、帧数、测试结果与当前模型。最终回复必须给出样片绝对路径，供 Codex 读取和展示给用户；不联系其他人，不外发上传视频。
