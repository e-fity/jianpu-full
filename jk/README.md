# Letter piano jk

把**中文简谱图片**认成**键盘字母谱**，并做成三种跟练／解压视频。网页操作，全部在本机跑。

```
简谱图片 ──识别──▶ 逐音数据（行号/数字/音区/字母/时值/歌词/像素框）
                      ├─▶ 原位替换图（数字盖成字母，版式不动）
                      ├─▶ 网页：选曲、改曲名/调号/拍号/J、看结果
                      └─▶ 视频 ×3 风格（落块 / 跟弹 / 小球下坡）+ 合成主旋律
```

## ⚠ 先记住两件事

**1. 用系统 Python：`D:\python\python11\python.exe`**

有 cv2 / PIL / numpy / flask / imageio-ffmpeg。`D:\Letter piano11\.venv` 里**没有 cv2**，
用它一跑就 `ModuleNotFoundError: No module named 'cv2'`。

命令行里 `python` 已经指向对的那个 ✓。**在 PyCharm 里要手动把解释器设过去**
（Settings → Project → Python Interpreter）—— 直接右键运行默认会挑到错的。

**2. 本工程是 `D:\Letter piano11` 的薄接口层 —— 所以 clone 下来不能直接用**

识别代码一个字没有，全靠 import 那边（`ocr_jianpu` / `overlay_letters` / `mapping`）。
位置不对就用环境变量 `JIANPU_PIANO11` 指过去。

⚠ **别人 clone 这个仓库跑不起来**，缺两样：

1. **`D:\Letter piano11` 那套识别代码**（不在这个仓库里）→ 第一条命令就 `ImportError`
2. **所有数据**：`out/`（曲库）、`视频/`（成品）、`web_out/`（上传临时区）**都是生成物、
   没进仓库** → 就算补齐了识别代码，也是空壳 —— 得先把图片转一遍，曲库和视频才有内容

想让它"clone 就能用"，得**连 piano11 一起给**（那个仓库已经有 git 了 ✓，但它故意不收
原谱图 `piano/`，所以对方还得自己准备图片）。更彻底的办法是**合并成一个仓库**，
但那要往 piano11 里加东西，得单独决定。

## 三块能力

### ① 图片 → 字母谱 —— `jianpu_api.py`

```bash
python -c "import jianpu_api; jianpu_api.convert(r'D:\Letter piano11\piano\7.png', outdir='out')"
```

产物两份：`out/7_overlay.png`（**原位替换图**：数字原位盖成字母，歌词/减音线/连音弧保持原样，
没认出来的画红框）+ `out/7_notes.json`（逐音对照表）。
函数收 `title / key / meter / tempo` 四个可手填项。

### ② 网页 —— `webapp.py`

```bash
python webapp.py
```

| 地址 | 干什么 |
|---|---|
| http://127.0.0.1:8010/ | **上传图片**识别（可先填曲名/调号/拍号/拍速）|
| http://127.0.0.1:8010/library | **曲库**：选一首 → 改那 4 项 → 生成视频 → 页面里直接播 |

一次只能识别一张 / 一次只能渲一个视频（都有排队或拦截）。只监听本机。

### ③ 视频 —— `make_video.py`

**三种风格共用一条管线**（读 JSON → 排时间轴 → 逐帧画 → 合成主旋律 → mux 成 mp4），
只有"画一帧"的函数不同：

```bash
python make_video.py out/9_notes.json                    # 落块（默认），输出到 视频/
python make_video.py out/9_notes.json --style play       # 谱面跟弹
python make_video.py out/9_notes.json --style roll       # 小球下坡
python make_video.py out/9_notes.json --stills 10,45     # 只出静止帧（快速试版式，不编码）
```

| `--style` | 画面 | 输出 |
|---|---|---|
| `tiles` | **落块音游**：7 车道，块高=时值，块底边碰「现在」线=该弹的时刻；块上挂歌词标签，最底部一条整句字幕带（当前字高亮）| `<曲名>_试演奏.mp4` |
| `play` | **谱面跟弹**：上半 = 字母谱 + 粉色游标压在当前音；下半 = **电脑键盘**，当前音要按的键按下去高亮 | `<曲名>_跟弹.mp4` |
| `roll` | **小球下坡**：蛇形下坡楼梯，弹珠一路往右滚、碰到边缘换行反向；木板只降不升 | `<曲名>_小球下坡.mp4` |

常用参数：`--size 1920x1080`（默认竖屏 `1080x1920`）、`--bpm`（不给就用 JSON 里的）、
`--fps 30`。风格专属旋钮见 `--help`。

**拍速**取 JSON 里的 `tempo_qpm`（没有就用 100）。**音频是合成的**（正弦叠谐波 + 包络），不是钢琴。

## 目录

| 路径 | 是什么 | 进仓库？ |
|---|---|---|
| `jianpu_api.py` | 图片 → overlay + JSON 的接口 | ✓ |
| `make_video.py` | 三种视频风格的渲染器 | ✓ |
| `webapp.py` | 网页服务（上传页 + 曲库页 + 生成视频）| ✓ |
| `sync_corpus.py` | 改了 piano11 识别代码后，重跑全库 | ✓ |
| `web/` | 两个页面（`index.html` / `library.html`）| ✓ |
| `使用说明.md` | 手册：`jianpu_api` 的详尽说明 + 网页/视频/sync 章节 | ✓ |
| `out/` | **曲库**：每首的 `_overlay.png` + `_notes.json` | ✗ 生成物 |
| `视频/` | 渲染出来的 mp4（每首几 MB，随时能重渲）| ✗ 生成物 |
| `web_out/` | 网页上传的临时工作区（原图 + 中间产物 + 渲染日志）| ✗ 生成物 |

## 三条常见流程

**给一首新图做视频**

```bash
python -c "import jianpu_api; jianpu_api.convert(r'D:\Letter piano11\piano\42.jpg', outdir='out')"
python make_video.py out/42_notes.json --style tiles
```

**改了 `D:\Letter piano11` 的识别代码之后**

```bash
python sync_corpus.py --dry-run     # 先看会重跑什么、顺便核对依赖签名
python sync_corpus.py               # 全库重跑（会保住手填的曲名/调号/拍号/拍速）
```

**某首歌的拍速填错了，视频速度不对**

打开 http://127.0.0.1:8010/library ，选那首，改 J 后保存（**不重跑识别，秒存**），再生成视频。

## 已知做不到的（都还没做）

| 边界 | 后果 |
|---|---|
| **反复记号 `:||` 不展开** | 所有视频都是**"一遍过"**，比真演奏短 |
| **多段歌词只留第一段** | 一行底下叠着多段歌词时，只认最上面那段（piano11 那边丢的）|
| **谱面印的 ♩= 没自动读** | 拍速要手填，没填就用默认 100 |

## 更多细节

`使用说明.md` —— `jianpu_api` 的 JSON 字段逐条说明、网页版、视频、全量同步，
以及踩过的坑（缓存、数据被覆盖、验证方法的陷阱）都在那里。
