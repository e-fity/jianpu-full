# 参考模型与 JSON 适配

默认 `music-machine` 视频入口和网页编辑器已换用新模型。

- 木板：参考图的粉色、米白、黄色木板平台（板面朝上，从墙面向外伸出），每个有声音符对应一次准确落板。
- 滑道：金色双轨、7 个下方固定挂件；不含示例滚动球。视频仍有一颗主动画小球。
- 自动分类：按 **q ≥ 2** 判断长音，与歌曲速度无关。长音落板后进入滑道，最后一个长音也生成滑道。休止符不新增模型。
- 原 JSON 的顺序、音高、节拍、休止时长不变，无需转换文件。
- 滑道会利用长音及后续休止期间持续滑行，末端直接接下一段下落。休止仍静音；不在轨道尽头停住等下一音符。出轨前平滑调整速度，与下落的初速度一致。最后一个长音收尾时减速停住。

很长的休止会降低滑行速度。例如此 JSON 的一段休止为 12.46 秒，保留原滑道长度时会缓慢滑行；若希望这类段落也保持较快速度，需要进一步加长轨道。

## 运行

在 `D:/Letter piano jk` 中运行：

```powershell
& "D:/python/python11/python.exe" ball3d/make_realtime_video.py `
  --input "D:/Downloads/10_notes.json" --style music-machine `
  --output "D:/Letter piano jk/ball3d/out/10_notes.mp4"
```

默认 720×1280、30 fps。查看长音段可加 `--start 18 --seconds 10`。
网页编辑器使用同一个资产和布局模块；打开的旧页面应刷新，若此前保存过板长设置，可重置几何参数以使用新默认板长 0.50 m。

## 可选延音与滑音

原文件只有时值，无法区分连音、延音或滑音，所以默认只按 q 判断长音，不自动猜测演奏标记。需要时可添加以下可选字段：

```json
{
  "format": "jianpu2letter-notes-v1",
  "key": "1=C",
  "tempo_qpm": 65,
  "lines": [{"notes": [
    {"n": 1, "o": 0, "q": 1},
    {"n": 3, "o": 0, "q": 2},
    {"n": 5, "o": 0, "q": 1, "articulation": "sustain"},
    {"n": 1, "o": 0, "q": 1, "articulation": "glissando",
     "glissando_to": {"n": 5, "o": 0}},
    {"n": 0, "o": 0, "q": 1}
  ]}]
}
```

`articulation` 可省略，或为 `normal`、`sustain`、`glissando`。后两者即使 q < 2 也使用滑道。`glissando_to` 为目标音级及八度，沿用当前调号；滑音需明确目标。休止符不能带延音/滑音标记。

明确延音的音量保持到音符结束再释放；滑音在音符时长内连续到达目标音高。未加字段时维持原来的合成音频。

## 模型与实现

- 源文件：`assets/reference_planks/reference_planks.blend`、`assets/reference_slide/reference_slide.blend`。
- 集成模型：`assets/reference_music_machine.blend`、`assets/reference_music_machine.glb`。
- 重建：`blender -b --python-exit-code 1 -P ball3d/assets/build_reference_music_machine.py`。
- 输入与音频：`score.py`、`audio.py`；运动：`realtime/src/layout.mjs`；显示：`realtime/src/music_machine.mjs`、`reference_geometry.mjs`。

木板默认尺寸为 0.30 × 0.06 × 0.50 m（宽、厚、深），后沿嵌入墙面 8 mm；底部增加金属支架和墙面圆形固定座，支架位于小球运动区域后方。改变板长时墙面与固定座随模型深度一起缩放。木板使用 Blender 烘焙木纹与三色调色板。滑道采用源模型的宽弧形轮廓，并根据行进方向翻转；实际模型和小球共用曲线坐标。普通跳跃使用重力抛物线，入轨与滑行按音符时间驱动，属于编排动画。镜头保留向下跟随，修正重复计算的俯视偏移，并加入 12° 侧视，让平台上表面、伸出深度及底部支架可见。可在编辑器调整斜视角和缩放。

## 本次验证

输入：`D:/Downloads/10_notes.json`。335 个有声音符、42 个休止符，生成 335 个音符木板和 14 条滑道；总时长 175.838 秒（含片头尾）。

- Python：120 项测试、29 个子测试通过。
- JavaScript：124 项测试通过，覆盖不同速度、最后一个长音、延音/滑音、休止期间不停顿、出轨速度连续性及实际 Blender 网格接触。
- 整曲路径扫描：木板穿透、滑道穿透、木板实体重叠及强制求解均为 0。双轨扫描容差 0.5 mm；本曲最小表面距离 0.0999192 m，球半径 0.1 m。密集段的木板画面投影仍可能遮挡，实体检测与屏幕可见性不同。
- 视频：720×1280 / 30 fps / H.264 + AAC，5276 帧编码和完整解码一致；RX 6500 XT，连续滑行版本实测用时 50.5 秒，详见 `out/smooth_slides/full_render.log`；合成音频与上一版逐字节一致。

最新连续滑行版：`out/smooth_slides/10_notes_smooth.mp4`；前后对比：`out/smooth_slides/comparison.mp4`；10 秒预览：`out/smooth_slides/preview.mp4`。

整曲原有 13 次滑道末端等待已全部取消。位置差分测得出轨速度衔接误差小于 0.000033 m/s；非终止滑道最低速度约 0.142 m/s，持续前进。详细导出与测试记录保存在 `out/smooth_slides/`；旧版保留在 `out/wall_mount/`，用于对比。
