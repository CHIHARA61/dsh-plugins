# dsh-plugins

两个 DeepSeek Harness 插件，一个仓库：

| 目录 | 插件 | 作用 |
|---|---|---|
| `dsh-prompt-zh/` | 中文提示词 | 把模型看到的系统提示词、运行时上下文、工具说明翻成中文 |
| `dsh-preset-interlocutor/` | 思辨模式（诤友） | 一个 agent preset：强对话、弱执行 |

两个包都是 DSH 的 **profile bundle**：装进某个 profile 并登记进它的
`dsh.profile.bundles` 才生效。两个包都**没有 `prepare`/install 脚本**（只有 `test`
和 `build:dict`），所以从 git 安装不会触发 pnpm 的构建许可门（`allowBuilds`）。

---

## 前提：git 必须能连上 github.com

`github:` 安装时 pnpm 会调 `git ls-remote` 解析 commit，**这一步走 git 自己，不走浏览器**。
所以浏览器能开 GitHub ≠ 安装能成功。

如果 install 报 `ERR_PNPM_GIT_RESOLVE_FAILED` / `Failed to connect to github.com port 443`，
而你确实在用代理，那是 git 没用上代理（git 不读系统代理设置）。写进 git 全局配置即可：

```sh
git config --global http.proxy  http://127.0.0.1:7890
git config --global https.proxy http://127.0.0.1:7890
```

把端口换成你自己的。写进 `~/.gitconfig` 的好处是不依赖环境变量——macOS 上 GUI 启动的
应用不会继承 shell 里 export 的变量，但任何 git 调用都会读这个配置文件。

另外 `github:` 安装需要机器上有 `git`（macOS 第一次用会提示装 Command Line Tools）。

---

## 安装

在 DSH 的插件安装入口（桌面端：设置 → 插件）里粘两行：

```
github:<你的用户名>/dsh-plugins#path:/dsh-prompt-zh
github:<你的用户名>/dsh-plugins#path:/dsh-preset-interlocutor
```

* `<你的用户名>` 换成 GitHub 用户名；`#path:` 指向 mono-repo 里的子目录。
* 不用终端、不用 clone、不用装 Node/pnpm（桌面端自带）。
* 想钉版本可以把 ref 和 path 一起写：
  `github:owner/repo#v1.2.0&path:/dsh-prompt-zh`。语法是支持的，但如果仓库**根目录**
  有 `prepare`/install 脚本会触发 `allowBuilds` 门；本仓库根目录没有 `package.json`，
  不会遇到这个问题。

---

## 更新

**更新 = 卸载 → 再装同一个 spec。**

```
卸载 dsh-prompt-zh
粘贴 github:<你的用户名>/dsh-plugins#path:/dsh-prompt-zh
```

⚠️ **只"再装一次"不会更新。** 锁文件把 commit 钉死在 codeload 地址里，例如
`tarball: https://codeload.github.com/…/tar.gz/666df7c1…`。用同一个 spec 再装，
pnpm 会报 `Lockfile is up to date, resolution step is skipped` 并停在旧版本。
只有先 `remove` 才会重新解析到分支最新的 commit。

桌面端的插件管理器没有 update 动词（服务只有 `installBundle` / `removeBundle` /
`setBundleEnabled` 这些），所以"卸载 + 再装"是唯一路径——好在两步都在同一个界面里。

**如果更新变得频繁**，改成 clone + 装目录会省事得多：

```sh
git clone https://github.com/<你的用户名>/dsh-plugins.git ~/dsh-plugins
```

然后把两个**目录绝对路径**粘进安装入口。装目录得到 `link:`，profile 里的
`node_modules/<包名>` 变成指向仓库的符号链接，之后 `git pull` 直接改到已安装的文件，
不需要卸载重装（重启 DSH 加载新代码；纯词表改动连重启都不用）。

---

## macOS 注意

**不需要做任何事。** DSH 按平台挂载 shell 工具：Windows 是 `pwsh`，**macOS / Linux 是
`bash`**。`dsh-prompt-zh` 的随包词表同时覆盖了这两套——`tool:pwsh` / `pwsh` 与
`tool:bash` / `bash`——所以 Mac 上开箱就是中文，不用额外放词表文件。

两条平台相关的事实，方便排查：

- `dsh-base` 在非 win32 上挂 `bash-sandbox`（win32 上挂 `pwsh-sandbox`），
  两套都是受沙箱约束的执行器，所以 macOS 上 `bash` 的描述**包含**沙箱提权那一段，
  与词表里的 `en` 基线一致。
- 若某个部署改用不受约束的执行器（`dsh-bash-local`），`bash` 描述会少掉提权段，
  这条会被报成 `drift` 而**保留英文**——它不会静默：插件默认会向宿主日志警告一次，
  覆盖率报告里也点得到。这是词表带 `en` 基线的固有取舍（`pwsh` 条目同理）。

---

## 维护者笔记

- **`.gitignore` 必须排除 `node_modules/`。** 插件目录里会有 DSH 生成的模块代理
  （指向宿主安装的 junction/symlink），是每台机器自己的，提交上去既无用又会在别人机器上断掉。
  `npm pack` 的 `files` 字段已经排除了它们，所以用打包内容建仓库是安全的。
- **`.gitattributes` 强制 LF。** 这个仓库在 Windows 上维护、在 macOS 上使用；
  不钉住换行符会在每次提交时产生无意义 diff。
- **仓库根目录不要放 `prepare`/install 脚本。** 会触发 pnpm 的 `allowBuilds` 门，
  让安装多一步。保持根目录没有 `package.json` 最省事。
- **隐私**：不要把这个仓库建在一个还放着别的东西的目录里（例如 `~/Documents/dsh`
  下有体检报告和图片）。用独立目录，push 前先 `git status` 确认一次。
- **发版**：改完插件代码顺手提一下 `package.json` 的 version。不钉 ref 的消费者
  靠分支最新 commit 更新，但版本号是排查问题时的抓手。
- **词表维护**：`scripts/translations/*.json` 是人写的一层，`dict/zh.json` 是生成物。
  DSH 升级后跑覆盖率报告，把新条目补进 translations，再
  `node scripts/build-dict.mjs --report <报告>` 重新生成，`node scripts/selftest.mjs` 校验。
  `en` 基线有两条来源：不带 `--report` 时会从现有 `dict/zh.json` **继承**（所以重新生成
  不会丢漂移检测），或者由 `--report` 写入。对报告覆盖不到的条目——例如只在
  macOS 上存在的 `bash`，Windows 上抓的报告里没有它——可以直接在 translations 源里
  写成 `{ "en": "...", "zh": "..." }`，`build-dict` 会原样透传。
  注意 `en` 只对「无条件替换」的条目生效；带 `exact`/`match`/`capture`/`variants` 的条目
  不要写它。
- **`en` 与原文不符的后果是"保留英文"而不是"乱译"**：无条件条目的 `en` 一旦与宿主实际
  发出的原文不同，`resolveEntry` 判为 `drift`，译文**不会被应用**。所以给条件性文本
  （如 `bash`/`pwsh` 的描述）写基线时，要基线与该平台默认装配产出的原文一致。
- **改完记得跑 `node scripts/selftest.mjs`。** 它会对着 `en` 基线逐条校验，
  并模拟上游改动；`build-dict` 在不带 `--report` 时**不会**报告"某工具缺 description"
  这类遗漏——`selftest` 会。
- **版本要求**：`dsh-prompt-zh` 声明 `dsh >= 0.1.7-rc.1`；「思辨模式」用的声明行机制
  在 `0.1.7-rc.1` 已就位（该版本含 `dsh-agent-preset` / `dsh-agent-preset-registry` /
  `dsh-client-ui-agent-preset`）。0.1.5 那条线用的是目录式 preset，装不上。
