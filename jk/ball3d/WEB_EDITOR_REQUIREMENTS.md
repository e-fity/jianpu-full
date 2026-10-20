# 网页 3D 调节与同场景视频导出：实施需求
2026-10-12。策划/审核 Codex，实现外部 Claude Code（DeepSeek-V4.1-Flash）。用户已明确授权开始。开发者负责实际代码、测试、样片。

## 范围与现状
项目 D:/Letter piano jk，进程 cwd=ball3d。修改 ../webapp.py、../web/library.html、必要 ../web/ 新页和 ball3d 源/测试/模型/构建。根目录有既有未提交用户改动：先备份涉及文件到 out/web_editor/before/，不覆盖旧视频、歌词/OCR逻辑。不安装、不读凭证/全局配置、不发布。
先读 NATURAL_FALL_SPACING_REQUIREMENTS.md 和 out/natural_fall_spacing/NATURAL_FALL_SPACING_HANDOFF.md；当前生产已是窄板自然下降且整曲通过，保留默认回归。
Blender 资产 assets/music_machine_compact.blend/glb 与 assets/build_music_machine.py 复用；允许额外 reference/editor GLB 不覆盖旧 compact。实际模型、碰撞尺寸、球、支架与接触点一致，禁止只缩碰撞盒。

## 已观察参考
D:/微信文件存储/xwechat_files/wxid_m81o5g1ycsde22_7a76/msg/video/2026-09/30751dd7dbf219c0245ecd2a378b2219.mp4
7.87s720x1280，抽帧 out/web_editor/reference_0..3.jpg/reference_contact.jpg。
参考长条圆角木板、细暗金属支架、深灰暖色墙面、彩色板与击中彩色光晕、反光球、柔和阴影。不复制手机/抖音界面、歌词，不承诺像素级复刻。按实际画面供用户审核。

## 第一版流程与真实可用控制
- 曲库添加“3D 调节/小球视频编辑”入口，直接生成按钮和原视频保留。中文独立编辑页，竖屏实时3D预览+面板，桌面能看全。
- 选择曲库已有歌，也可导入 jianpu2letter-notes-v1 JSON；从当前曲库选歌进入带入选择，清晰空态。图片识谱用原入口。
- 播放/暂停/从头、时间轴拖动/时间显示、试听开关。试听相同合成旋律；seek 和暂停调参后同时间显示确定状态，音频同步且不重复播放。
- 几何：板宽、板深（长条比例）、球大小、间距偏好、长音弹跳高度偏好；全部必须实质改变真实布局/碰撞/采样，可行范围实测。不只改变展示比例或tempo。高度调节至少用一个长音用例证明不同apex、onset不变。
- 视觉：板色/色彩强度、木纹强度、支架颜色、墙色、主光强度、曝光、击中光晕/辉光、阴影、相机缩放与斜视角；控件真实生效且全部影响导出。
- 几何变化防抖重新求解，视觉无需求物理。不每帧求布局。每页面/任务配置隔离，禁止可变模块全局常量导致串参数。轨迹求解不通过要说明，禁用导出，保留最近有效预览；不能假装调成功，参数联动要可见。
- 恢复默认、保存/载入设置JSON（简单复用），安全默认保持已通过335音的布局。给参考外观起点，几何不通过先保持安全尺寸。
- “导出10秒样片”（从当前时间起，范围明确）和“导出整曲”，MP4带音轨；720x1280/1080x1920、30/60fps、匹配码率可选。本机后台生成，非录屏，显示生成/耗时/真实日志/完成播放下载；失败可再试。
- 点击导出冻结歌曲+全部参数快照；预览与导出共用同一布局、GLB、场景、相机、灯光、绝对时间采样。报告保留配置/时间范围/几何。不得丢设置转默认CLI，不得含控制面板/歌词。
- 不做逐音手工拖动、不新换物理引擎、不做账号云端。

## 必须保留与验证
自然连续下降，斜板引导水平反射，空中恒定重力与水平匀速，长音真实高弹/明确接触停留，准确在下一音onset落板。无右端跨行到左端/空中转向/Z绕行。音高、tempo、onset、休止不改，滑槽只合理长休止，无歌词。
几何/间距/弹跳配置重求并检查forced/clearance/板重叠/全路径，失败配置不能导出。小球与板可辨、支架相连。实例池与材质复用；配置变化清理旧场景，不积累WebGLcontext/RAF/音频，旧异步结果不覆盖新操作。
输入/设置必须验证非有限数、尺寸、码率、时间范围、路径穿越、不支持格式；单导出任务互斥与唯一目录；失败不能返回旧视频。原 classic/wood-drop 与根网页回归保留。

## 本机工具
Python D:/python/python11/python.exe
Node D:/node/node.exe
Blender D:/apps/Blender/blender-4.5.3-windows-x64/blender.exe
Edge C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe
realtime/node_modules 有 three/playwright-core/esbuild/canvas-record，不另安装。
Flask 默认8010，测试可独立8011，不强杀占端口未知进程。后台进程必须隐藏窗口。只清理自己启动的进程。
ffmpeg用已有Python imageio_ffmpeg。不要 Bash 里裸python指向错误版本。

## 必须交付实际可审结果
1. 真实unit/API回归：非法配置、隔离、参数改变、尺寸一致、长音apex不同但onset不变、任务忙冲突、冻结设置与选歌真正进导出、失败不下载旧视频。
2. Playwright真正访问编辑页，选真实歌/导入JSON、播放暂停seek、调视觉与几何、重置/保存加载，断言实际布局/渲染变而非只文字变化，无控制台错误。
3. 由网页发起非默认配置的1080p30样片、真实《孤勇者》密接段，以及完整默认720p30整曲端到端5276帧；确认音轨/可播放/尺寸/帧数、记录本轮真实耗时。
4. 同设置同绝对时间同分辨率预览PNG与导出QA PNG，给Codex独立比较（压缩视频不要求逐像素一致）。
5. out/web_editor/ 实际产物：preview_editor.png、preview_frame.png/export_frame.png、edited_sample.mp4、dense_sample.mp4、full_song.mp4、editor_settings.json、delivery.json、WEB_EDITOR_HANDOFF.md。
交接含绝对路径、页面地址、真实测试结果、精确命令、控制范围与局限。不抄旧统计/耗时，不造假/弱化物理测试，不只交命令或计划。实施完整功能后实际生成并交回。
