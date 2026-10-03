# dsh-preset-interlocutor

「思辨模式」（诤友）——一个 DeepSeek Harness **agent preset**，外加它自带的只读文档读取工具。
装进某个 profile 并登记进 `dsh.profile.bundles` 后，新会话的 preset 选择器里会多出「思辨模式」。

包里有两部分：

| 部分 | 位置 | 作用 |
|---|---|---|
| preset 声明 | `cordis.patch.yml` | 声明 `interlocutor` preset：persona + 子插件行 |
| 文档读取工具 | `index.js` + `lib/` | 给这个 preset 注册 `read_doc` 工具（Word / PDF / 幻灯片 / 表格） |

## 为什么需要 `read_doc`

「思辨模式」刻意裁掉了 shell、jobs、skills、目标、计划、待办与交付语汇，只留下**读本地材料、
联网取证、开一路独立对辩视角**。但裁剪之后出现一个洞：

- DSH 内置的 `read` **只读 UTF-8 文本**（二进制直接失败），PDF/音频/视频被明确列为不做；
- `web_fetch` 对 `application/pdf` 直接报错；
- `read_image` 只吃 PNG/JPEG/WebP/GIF；
- 而这条 preset 里没有 shell，也没有 skills——旧 persona 里那句
  「用 `python bin/pdftext.py` 抽文本」根本执行不了。

于是「对方把稿子存成 Word 发过来」这件最普通的事变成了做不到。`read_doc` 只补这一件事：
**把文档只读地抽成带行号的文本**。它不执行命令、不写文件、不联网，也不引入任何第三方依赖。

## 安装

多包仓库，子目录用 `#path:` 片段（`#path:` 不能省；只粘仓库根地址装出来的是空壳）：

```
https://github.com/<用户名>/dsh-plugins#path:/dsh-preset-interlocutor
```

本机开发时更省事的做法是装目录（得到 `link:`，改代码直接生效，重启 DSH 即可）：

```
C:\Users\you\dsh-plugins\dsh-preset-interlocutor
```

更新 = **卸载 → 再装同一个 spec**（只"再装一次"不会更新，锁文件把 commit 钉死了）。

## `read_doc`

| 格式 | 说明 |
|---|---|
| `.docx` | 一个段落一行；表格一行一条记录，单元格用 ` \| ` 连接；修订保留插入、丢弃删除；默认只**报告**页眉/页脚/脚注/批注/图片的数量 |
| `.pdf` | 每页以 `===== page N =====` 分隔；可用 `pages` 只读某几页；识别不到文字层时明确报告 |
| `.pptx` | 每张幻灯片 `===== slide N =====`，备注页以 `[备注]` 附在当页后面 |
| `.xlsx` | 每张工作表 `===== sheet "名字" =====`，一行一条记录、单元格按列对齐用制表符分隔 |
| `.txt` / `.md` / `.csv` … | 直通（内置 `read` 同样能读，这里省一次往返） |

参数：

| 参数 | 说明 |
|---|---|
| `file_path` | 必填。相对路径按会话工作目录解析 |
| `offset` / `limit` | 从第几行开始、最多多少行。**长文档必须分窗口读** |
| `pages` | 仅 PDF：`"3"`、`"10-20"`、`"2,5-7"` |

输出沿用内置 `read` 的外壳（`<path>` / `<format>` / `<content>`，行号前缀），末尾给续读提示：

```
<path>C:\Docs\paper.pdf</path>
<format>pdf，第 4-5 页（共 23 页）</format>
<content>
1: ===== page 4 =====
2: 3 Method
...
</content>
（本次显示 1-300 行，共 612 行；用 offset=301 继续）
```

**抽不到文字就说抽不到。** 扫描件会得到明确警告，而不是一段编出来的正文。

## 配置

在 preset 的 `tool-doc` 行里写 `config`（都在 `cordis.patch.yml` 里，有注释）：

| 字段 | 默认 | 含义 |
|---|---|---|
| `lineLimit` | `300` | 一次返回的最大行数 |
| `charBudget` | `6000` | 一次返回的最大字符数 |
| `maxFileBytes` | `64 MiB` | 单次调用允许的最大文件 |
| `pdfPageBatch` | `25` | 未指定 `pages` 时 PDF 一次先抽多少页 |
| `maxPdfPages` | `200` | 单次抽取的页数上限 |
| `includePdfInvisibleText` | `true` | 是否包含 PDF 里的不可见文字（扫描件的 OCR 文字层常是 `3 Tr`） |
| `docxExtras` | `false` | 是否把 docx 的页眉/页脚/脚注展开到正文之后 |
| `pptxNotes` | `true` | 是否展开幻灯片备注 |
| `xlsxRowsPerSheet` / `xlsxMaxSheets` | `2000` / `20` | 每张表展开多少行、最多展开几张表 |

默认的 `lineLimit`/`charBudget` 刻意低于 preset 里 `tool-result-pruner` 的 8192 字符阈值：
一次读取若超过它，结果会被截成「头 4096 + 尾 1024」，中间正文就丢了。

## 实现

零第三方依赖：只用 `node:zlib`、`node:buffer`、`node:fs` 这些内置模块与相对路径。
因此它**不 import 任何 `@deepseek-ai/*` 包**，不依赖 profile 里是否生成了模块代理——
这同时也是「preset 插件」的最小写法示例（`export function apply` / `inject` / 由
`ctx.tools.register` 注册的普通对象定义）。

| 文件 | 职责 |
|---|---|
| `index.js` | 工具定义：路由（魔数优先）、分窗口、输出渲染、错误措辞 |
| `lib/zip.js` | 最小 ZIP 读取器（中央目录、store/deflate、CRC、zip 炸弹上限） |
| `lib/ooxml.js` | docx / pptx / xlsx 的结构化文本抽取（自带 XML 解析，不做正则剥标签） |
| `lib/pdf/objects.js` | 词法与对象、经典 xref 表 / xref 流 / 对象流、过滤器（Flate/LZW/A85/AHx/RL + 预测器）、xref 损坏时全文扫描 |
| `lib/pdf/fonts.js` | 编码与字体：WinAnsi/MacRoman/Standard、`/Differences`、内嵌 Type1 内建编码、ToUnicode CMap、CID 字宽 |
| `lib/pdf/content.js` | 内容流状态机（CTM / 文本矩阵 / 间距 / 可见性 / Form XObject），按行聚簇与按 x 重排 |
| `lib/pdf/index.js` | 页树、页范围、逐页抽取与告警 |

## 测试

```sh
node test/pdf.test.mjs     # 合成 PDF（文本 / 纯图 / 加密 / xref 损坏）+ 真实语料
node test/ooxml.test.mjs   # docx / pptx / xlsx，需先生成素材
node test/tool.test.mjs    # read_doc 的行为：外壳、分窗口、pages、失败路径
```

`test/make-fixtures.py` 用 DSH 自带 Python 生成 docx/pptx/xlsx 素材（python-docx /
python-pptx / openpyxl），素材放在仓库外的 `_research/doc-fixtures/`。真实 PDF 语料不在
仓库里，缺失时 `pdf.test.mjs` 会跳过并打印获取方式。

## 已知边界

PDF：

- **只取文字层，不渲染页面。** 扫描件（无文字层）读不出正文——DSH 自带 LibreOffice kit 的
  `render` 能把页面渲成 PNG 再交给 `read_image`，这条路**没有实现**（它要找到 kit CLI 的
  绝对路径、依赖图像输入路由，也要考虑每张图都是永久的 token 成本）。
- 加密 PDF 一律拒绝，不猜密码。
- 右起横排、竖排文字会退化；内容流顺序被打乱的文件可能读起来跳跃（实现跟随内容流顺序，
  因为 LaTeX/Word 排多栏时那正是阅读顺序）。
- 数学符号字体里，子集编码没覆盖到的码位输出 `U+FFFD` 并计数（pdfium 在这类码位上同样
  抽不出字符）。CFF（`/FontFile3`）字体的内建编码不解析，Type1（`/FontFile`）会解析。

Office：

- `.doc` / `.ppt` / `.xls` / `.rtf` / `.odt` 不支持，会提示另存为新格式。
- docx：文本框（`w:drawing` 内的 `w:txbxContent`）与批注正文不抽取，只计数；页眉/脚注默认
  不展开（`docxExtras: true` 可展开）。
- pptx：图表与 SmartArt 里的文字不抽取。
- xlsx：不做日期/数字格式化（日期是序列号），合并单元格只取左上角，图表工作表跳过。
- Zip64、加密 Office 文件、分卷 ZIP 一律明确报错。

工具本身：

- 只读：不写文件、不改格式、不执行命令。
- 单文件上限 64 MiB（可配）；调用 sandbox 化的 `ctx.fs`，路径受宿主文件策略约束。

## 版本

声明 `dsh >= 0.1.7-rc.1`（preset 声明行机制从该版本起可用）。`read_doc` 用到
`ctx.fs.resolve` / `stat` / `readBytes` 与 `ctx.tools.register` 的普通对象定义，
在 DSH Desktop `0.2.0-rc.2` 上开发与验证；`readBytes` 这类 seam 在 `0.1.5-rc.3` 就已存在。

## 许可

MIT。
