# dsh-prompt-zh

[English](README.md) | 中文

把 DeepSeek Harness 里**模型看到的那份提示词**换成中文：系统提示词段落、运行时上下文快照、工具描述与参数说明，并让模型的思考过程也跟着用中文。不修改任何 DSH 源码，卸载即还原。

## 它和「按英文原文查词表」有什么不同

中文提示词插件的常见做法是拿英文原文当 key 查一张大表。这在 DSH 上撑不久：上游每隔几天就会改一次措辞、加一个工具、给某个参数补一句说明，而每改一次，对应那句就**静默退回英文**——用久了就成了"只有一部分是中文"。

这个插件按键查表，key 是**稳定标识符**：

| 类别 | key | 例子 |
|---|---|---|
| 提示词段落 | 段落名 | `tool:read`、`harness:identity`、`deployment:persona-prefix` |
| 运行时上下文 | 上下文名 | `sandbox:policy`、`approval:policy` |
| 工具 | 工具名 | `read`、`pwsh`、`workflow` |
| 工具参数 | 参数路径 | `edit.parameters.properties.old_string.description` |

段落名和工具名由 DSH 自己固定（它们是插件之间的公开契约），所以上游改写措辞**不会**让译文失效。代价是新增的段落/工具/参数会漏译——而漏译不会静默：每次装配都会统计，并由覆盖率报告逐条点名（见下文）。

另外两条规则：

- **原文已经是中文就不动它。** 你在 agent preset 里写了自己的中文 persona，插件不会拿内置译文盖掉。要强制覆盖，在词表条目上加 `"force": true`。
- **变量照常插值。** 译文里可以写 `{{model}}`、`{{cwd}}`；插值发生在插件之后，所以 `你是一个由 {{model}} 模型驱动的编码 agent。` 里的模型名会正常替换。

## 安装

```sh
dsh plugin --profile web add dsh-prompt-zh
```

然后重启 `dsh web`。装完可以直接看效果：新会话的第一条系统提示词已经是中文。

## 配置

配置项会出现在 **设置 → 插件 → 插件配置**（dsh ≥ 0.1.7 从插件自己的 Config schema 派生），也可以写在 profile 的 `cordis.patch.yml`：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `sections` | `true` | 翻译系统提示词段落 |
| `contexts` | `true` | 翻译运行时上下文快照 |
| `tools` | `true` | 翻译工具描述与参数说明 |
| `thinkInChinese` | `true` | 注册一段「思考过程必须用中文」（在段落列表末尾；`sections` 关闭时不生效） |
| `warnUntranslated` | `true` | 出现漏译/漂移/坏正则时，向宿主日志警告一次 |
| `reportPath` | `''` | 非空时把覆盖率报告写到这个绝对路径（每次装配，内容有变化才写） |
| `verbose` | `false` | 每次装配向宿主日志打一行统计 |

```yaml
- id: prompt-zh
  name: "dsh-prompt-zh"
  config:
    reportPath: "C:/Users/me/dsh-zh-report.json"
```

## 让模型用中文思考

提示词是中文了，模型的思考过程却还是英文——因为 DSH 的 DeepSeek 适配器**不下发任何「思考语言」指令**：请求体里与思考有关的只有 `output_config.effort` 与 `thinking.type`，没有语言开关。所以唯一可行的办法是在**每一轮都会出现**的系统提示词里显式要求一次。

插件在 `sections` 开着（且 `thinkInChinese` 没关）时，注册一段 `prompt-zh:thinking-language`（order 20000，排在 `deployment:persona-suffix` 之后）：

> 无论用户使用什么语言，你的思考过程都必须用中文。回答用什么语言不变，照旧跟随用户。

这一段是插件新增的，不覆盖 DSH 的任何注册段落，也不进词表与覆盖率报告（它不是某段英文的译文）。三处取舍写在下面：

- **为什么新加一段，而不是挂在现成段落上。** DSH 没有一段专讲「模型自身的思考语言」：persona 属于用户、`harness:identity` 是身份声明，往哪一段上挂都是在改别人的话。
- **为什么走 `ctx.systemPrompt.section()` 注册，而不是在装配钩子里塞段落。** 注册是 DSH 插件开发规范要求的写法（"Add prompt text with `ctx.systemPrompt.section()`"）。本插件的翻译钩子只做「别人写过没有」这一个判断，并在装配里就地清空自己那一段，所以两边都合规。注册的段落进注册表：`system-prompt/change` 事件看得见它，preset 或别的插件也能用同名段落整体遮蔽它。
- **为什么排在最后而不是最前。** 提示词仍以 DSH 自己的 `harness:identity` 开场；更重要的是前缀 KV cache——往末尾追加时前面的段落逐字节不变，往最前插入则本插件每升一版都会让所有用户的整段前缀缓存失效一次。

两条防呆：

- **别人写过就不显示。** 你自己的 persona 里已经写了「用中文思考」「think in Chinese」这类要求（中英文都认，要求「思考/推理」与「中文/Chinese」落在同一句里），插件那一轮就把自己这段清空（DSH 渲染时会丢掉空段落），替你保留原话。判断只看**翻译之前**的原文，所以插件自己译出来的中文不会误伤这条。想要自己的措辞，推荐关掉 `thinkInChinese`、在 persona 里自己写。
- **段落名唯一。** 同一段落名在装配里出现两次会让 DSH 的装配不变量直接判失败，所以插件只注册一段，也不会在装配里重复插入。

关掉它的两种方式：`thinkInChinese: false`（只关这一句）或 `sections: false`（连同段落翻译一起关掉）。两种情况下都是**根本不注册**这一段；卸载插件则由 `ctx.effect` 的 disposer 摘掉，都不留痕迹。

## 覆盖率报告：漏译看得见

漏译默认不会静默。每个**新出现**的漏译（`missing`／`drift`／`invalid`，按 `状态:名字` 去重）都会往宿主日志警告一次，之后不再重复：

```
[prompt-zh] 3 条文本没有中文译文，本轮按英文原文发给模型：tool:brand-new(missing)、
brand_new_tool.description(missing)、brand_new_tool.properties.thing.description(missing)。
补词表见插件 README；把 reportPath 指到一个文件可拿到完整清单。
```

想看得更细就设 `reportPath`（或加 `verbose: true` 看每次装配的统计）。报告是一份**完整清单**：本轮装配里每一个段落、上下文、工具描述、参数说明各占一条，带 `status`：

| status | 含义 | 该怎么办 |
|---|---|---|
| `translated` | 已译 | — |
| `unchanged` | 译文与原文相同（例如 `edit \| pause \| resume` 这种枚举字面量），无需翻译 | — |
| `missing` | 词表里没有这个名字 | 补条目 |
| `drift` | 有基线但对不上：正则没命中，或上游改了这句 | 复核译文 |
| `skipped-cjk` | 原文已含中文，按规则跳过 | 想覆盖就加 `force: true` |
| `invalid` | 词表里的正则写错了 | 修词表 |

DSH 升级之后跑一遍报告，就知道这次有哪些新东西需要翻译——这是本插件不重演"只有一部分是中文"的关键。

## 词表

随包词表按 DSH `0.2.1-rc.5` 实际发出的提示词校准（Windows 桌面 profile）：段落 25、上下文 6、工具 60、参数说明 244，本轮装配 0 漏译、0 漂移——可用 `scripts/selftest.mjs` 与 `scripts/replay.mjs` 复现。

其中 8 条是第三方组合包 `dsh-ops`（`ops_*` 工具与 `dsh-ops:discovery-tools` 段落）的译文，单放在 `scripts/translations/80-third-party-dsh-ops.json` 里：没装那个包时这些条目永远匹配不到，装了就能一起变中文。

0.2.1 把「实现代码位置」与「Web 界面地址」拆开了：静态说明仍叫 `harness:source` / `app:web-surface` 段落，动态取值改成同名**上下文**（`Current DeepSeek Harness implementation checkout: "…"`）。词表两种都收，段落用静态译文，上下文用 `match` 正则。

内置词表在 `dict/zh.json`，条目形状：

```jsonc
{
  "sections": {
    "tool:read": { "en": "Use the read tool …", "zh": "查看文本文件请用 read 工具……" },
    "harness:source": {
      "capture": "^The DeepSeek Harness implementation checkout is at (.*?)\\. ",
      "zh": "DeepSeek Harness 的实现代码位于 $1。……"
    }
  },
  "contexts": {
    "sandbox:policy": {
      "variants": [
        { "exact": "Current DSH file policy: read-only. ……", "zh": "当前 DSH 文件策略：read-only。……" }
      ]
    }
  },
  "tools": {
    "read": {
      "description": "……",
      "parameters": { "properties.limit.description": "最多返回多少行。默认为 2000。" }
    }
  }
}
```

一条条目可以写成裸字符串（等于 `{ "zh": … }`），也可以用这些字段：

| 字段 | 作用 |
|---|---|
| `zh` | 译文，或配合 `exact`/`match`/`capture` 的模板 |
| `exact` | 原文必须逐字等于它，命中才用 `zh` |
| `match` | 正则**整体**替换，`zh` 里可用 `$1` |
| `capture` | 正则只用来取值，捕获组填进 `zh` 的 `$1`/`$2`；原文其余部分不用重现 |
| `variants` | 一个条目多套规则，按顺序试；都没命中就报 `drift` |
| `en` | 仅作漂移基线（由 `scripts/build-dict.mjs` 从报告里写回），不参与匹配 |
| `force` | `true` 时连"原文已含中文"的跳过规则也绕过 |

### 不改插件也能加词表

插件按这个顺序合并词表，**后者覆盖前者**：

1. 包内 `dict/*.json`（文件名排序）
2. `$DSH_HOME/prompt-zh/zh.json`
3. `DSH_PROMPT_ZH_DICT` 环境变量里列出的文件（Windows 上用 `;` 分隔，其它平台用 `:`）

词表是当数据读的，按 mtime 失效——**改词表不用重启宿主**，改代码才要。所以你可以只放一条覆盖条目，就把某段译文改成自己的说法。

## 自己维护词表（升级 DSH 之后）

```sh
# 1. 生成一份覆盖率报告（插件配置 reportPath，或跑一轮会话）
# 2. 报告里 status 不是 translated/unchanged 的，补进 scripts/translations/*.json
# 3. 重新生成随包词表，并逐条校验
node scripts/build-dict.mjs --report dsh-zh-report.json
node scripts/selftest.mjs    --report dsh-zh-report.json

# 不启动宿主也能看整份装配翻出来是什么样，以及漏译时的警告长相
node scripts/replay.mjs --with-missing
```

`scripts/translations/*.json` 是人写的那一层（只有 key → 中文），`dict/zh.json` 是生成物（多了 `en` 基线）。`selftest` 不需要启动宿主，它直接拿报告里的英文原文逐条跑一遍规则，包括报告里没有的那些变体分支；没有报告时改用词表自己的 `en` 基线，再加一段「上游改动模拟」——改写措辞、新增工具、参数换名、正则不再命中，各自退化成什么样，都在那里断言着。

## 升级 DSH 时会怎样

| DeepSeek 改了什么 | 中文还在吗 | 报告里的 status |
|---|---|---|
| 改了措辞（同一段落/工具） | 在（译文可能略旧） | `drift` |
| 加了新工具/参数/段落 | 其余都在，只有那一项是英文 | `missing` |
| 动态段落换了结构 | 那一条回英文 | `drift` |
| 段落/工具被改名 | 那一条回英文 | `missing`（重建词表时还会点出孤儿条目） |
| 装配钩子的结构变了 | 需要改代码（约 30 行，都在 `lib/translate.js`） | — |

退化单位是**单个条目**，不是整份提示词——这是它和按英文原文查表的方案的根本区别。

## 已知边界

- 运行时上下文快照的固定首句（`Current runtime context. This snapshot supersedes earlier runtime-context snapshots.`）是在装配瀑布**之后**拼接的，本插件管不到它。
- **DSH 0.2.1 起，整份运行时上下文快照都不受本插件影响。** 模型看到的那段文字由 `SystemPrompt.refreshContext()` 在装配瀑布**之后**按注册的 provider 重新解析（`dsh-agent-loop` 的 `step()` 就是这样取上下文的），本插件在瀑布里改写的 `context.text` 会被那一步丢掉；覆盖率报告仍会把它记成 `translated`，因为报告记的是瀑布里发生的事。受影响的是 `sandbox:policy`、`approval:policy`、`working-directory:current`、`team:identity`、`harness:source`、`app:web-surface` 这几条上下文；段落与工具说明走的是装配结果本身，翻译照常生效。要修只能在 `agent/pre-step` 这类更晚的钩子上改消息，那是另一件事。0.1.7 时代这条路径是通的。
- **思考语言没有开关可用。** DSH 与 DeepSeek 适配器都不下发这类指令（请求体里只有 `output_config.effort` 与 `thinking.type`），所以「用中文思考」只能靠提示词——它是请求，不是强制，模型仍可能偶尔用英文思考。
- 用了 `complete: true` 的 agent preset 时，DSH 会把整份段落列表换成 preset 那一段（取的是瀑布**之前**的副本），本插件注册的段落（含中文思考要求）与所有段落翻译都会随之失效；上下文与工具描述不受影响。
- 「用中文思考」那一段的位置是固定的（末尾，order 20000）。DSH 的 scoped 层按段名遮蔽全局层，所以某个 agent preset 或别的插件只要注册一段同名的 `prompt-zh:thinking-language`，就能整体替换掉它的位置与措辞。
- skill 目录提醒（`<system-reminder>` 加 `available_skills` 清单）同样是宿主在装配**之后**以 user 消息注入的，插件也够不到：它是英文的，且不会出现在覆盖率报告里。
- 工具名、参数名、枚举值不译——它们是调用协议的一部分。
- 只翻提示词，不翻界面文案。界面语言由 `@deepseek-ai/dsh-client-locale` 负责。
- Agent preset 里自带的段落（例如 `standard` 的 persona）会被翻，前提是它还是英文；用户自己写的中文不会被覆盖。
- `@deepseek-ai/schemastery` 只用来生成设置页的 Config schema。它的构造被包在 `safeConfig()` 里：schema 建不出来时只丢设置页，翻译照常工作，也**不会**让宿主启动失败。这是插件唯一的第三方 import。

## 许可

MIT
