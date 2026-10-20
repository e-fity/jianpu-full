# ball3d 独立审核报告

日期：2026-10-09。策划与审核：Codex。实现：Claude Code，后端为用户 CC Switch 配置的 DeepSeek。

## 结论

通过原型验收：现有 jianpu2letter-notes-v1 JSON 可自动生成真正的 3D 小球踏板动画、合成旋律和竖屏 MP4；支持顺序批量输入。未宣称达到参考视频的美术完成度或成熟批量生产系统的稳定性。

## 本机环境

Blender 4.5.3 LTS 免安装版位于 D:/apps/Blender/blender-4.5.3-windows-x64/blender.exe，来自官方下载地址，SHA256 与官方校验文件一致。Python 使用 D:/python/python11/python.exe。未更改 CC Switch 供应商配置；凭证仅通过子进程环境传递，没有写入本目录。新增功能在 ball3d 目录，原项目已有的未提交修改未由本任务编辑。

## 已执行的验证

- 最终 pytest：66 passed，0 failed。覆盖音高与调号、八度、休止、重复音、绝对时间累计、非法输入、运动连续性、坐标转换、长曲目地面覆盖、输出路径和批量冲突。
- 最终样片：out/guyongzhe_final_preview.mp4，360x640，30fps，360 帧，12.000 秒，H.264/yuv420p + AAC。FFmpeg 全片解码成功。
- 批量验证：两份不同调号和速度的合成测试简谱，含休止与重复音；输出位于 out/qa_batch。分别为 46 帧与 48 帧，12fps，约 3.833 秒与 4.000 秒；均含 AAC 且完整解码成功。这不是多首真实歌曲的大规模验证。
- 整曲数据：D:/Downloads/10_notes.json；13 行，377 事件，335 发声音符，42 休止符，188 四分音符拍，65 QPM。谱面时长 173.538461538 秒；含 1.2 秒片头与 1.1 秒尾部，计划时长 175.838461538 秒。
- 整曲独立运动检查：335 个落点全部核对；最大位置误差约 1.39e-17，区间边界位置差为 0。生成完整 44.1kHz 单声道 WAV，7754476 个采样，时长 175.838458050 秒。
- 视觉检查：核对最终版本的落点、跳跃中间画面及 0.8、1.2、4、7、10、11.9 秒抽帧。确认 3D 踏板、支架、投影、跟随镜头和落点彩色光。见 out/final_contact.jpg。

## 审核发现并修复

1. 停留区间缺失导致小球瞬移到最后一块踏板，已补连续 hold 区间及回归验证。
2. 计划 Y 轴向上与 Blender Z 轴向上混用，已统一渲染边界坐标转换，并清空默认场景。
3. 固定工作目录可能使短视频编码混入旧帧，改为每次独立临时目录并核对帧数和帧名。
4. Blender 脚本失败可能被当作成功，添加非零脚本退出码及编码前帧完整性检查。
5. 增补数值参数、输出别名与批量重名冲突检查；地面改为随曲目范围计算。
6. 首版镜头太近、曝光过白，已调整为较宽的正交镜头和中性灰背景、彩色接触光。
7. 发光节点按实际 Blender 4.5 接口直接设置，删除不必要的版本兼容封装和对应模拟测试。

## 边界

- 未渲染完整约 176 秒的 720x1280 成片；整曲时间轴和音频已验证，高清完整渲染耗时与运行稳定性尚未验证。
- 批量为有上限的顺序 CLI 任务，不含后台服务、任务恢复或图形界面。
- 音频为合成旋律，不含原唱、伴奏，也不是钢琴采样音源；本次未做主观听感验收。
- 不显示歌词；不识别图片；直接消费已有 JSON。OCR 正确性、反复记号、连音与变速不在本轮支持范围。
- 画面仍是初版：支架与琴板造型较简单，低采样阴影可见噪点，美术效果需要用户确认。

## 复现

在 D:/Letter piano jk 下运行：

```powershell
python -m pytest ball3d/tests -q
python ball3d/make_ball_video.py --input "D:/Downloads/10_notes.json" --seconds 12 --samples 16 --output "D:/Letter piano jk/ball3d/out/my_preview.mp4"
```

批量：把同格式简谱 JSON 放入单独目录，使用 --batch "D:/你的简谱目录" --limit 3 --seconds 12。去掉 --seconds 可请求整曲；使用 --width 720 --height 1280 请求高清。更多参数见 README.md 和 --help。

机器可读证据：out/video_audit.json、out/full_score_audit.json；运行日志：out/final_render.log、out/batch_render.log；开发任务与返工要求：TASK.md、REVIEW_1.md、REVIEW_2.md、REVIEW_3.md。
