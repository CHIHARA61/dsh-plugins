# dsh-plugins

两个 DeepSeek Harness 插件，一个仓库：

| 目录 | 插件 | 作用 |
|---|---|---|
| `dsh-prompt-zh/` | 中文提示词 | 把模型看到的系统提示词、运行时上下文、工具说明翻成中文 |
| `dsh-preset-interlocutor/` | 思辨模式（诤友） | 一个 agent preset：强对话、弱执行 |
| `mac-extra/prompt-zh/zh.json` | Mac 补充词表 | 见「macOS 注意」 |

两个包都是 DSH 的 **profile bundle**：装进某个 profile 并登记进它的
`dsh.profile.bundles` 才生效。两个包都**没有 `prepare`/构建脚本**
（只有 `test` 和 `build:dict`），所以从 git 或目录安装都不会触发 pnpm 的构建许可门。

---

## 安装

### 方式 1：装 git 源（不用终端）

在 DSH 的插件安装入口里粘贴（按你的 profile 选一条）：

```
github:<你的用户名>/dsh-plugins#path:/dsh-prompt-zh
github:<你的用户名>/dsh-plugins#path:/dsh-preset-interlocutor
```

也支持 `github:owner/repo@<tag-or-commit>` 钉版本，或 `git+https://...`。
本地路径必须写绝对路径（`~` 不展开），例如 `/Users/you/dsh-plugins/dsh-prompt-zh`。

### 方式 2：clone + 装目录（推荐，更新最省事）

```sh
git clone https://github.com/<你的用户名>/dsh-plugins.git ~/dsh-plugins
```

然后在插件安装入口里粘**目录的绝对路径**：

```
/Users/<你>/dsh-plugins/dsh-prompt-zh
/Users/<你>/dsh-plugins/dsh-preset-interlocutor
```

装目录得到的是 `link:`——profile 里的 `node_modules/<包名>` 是指向仓库的符号链接。
**这是后续更新最省事的原因**：`git pull` 直接改到已安装的文件，不需要卸载重装。

> 可以直接把这两句交给 DSH 的 agent 做（它有 shell 工具）：
> 「把 https://github.com/…/dsh-plugins clone 到 ~/dsh-plugins，然后把里面两个子目录
> 用绝对路径装进当前 profile」。

---

## 更新

**方式 2（目录/link:）**——推荐：

```sh
cd ~/dsh-plugins && git pull
```

然后重启 DSH 加载新代码。词表类改动连重启都不用（见下）。

**方式 1（git 源）**——必须先卸载再装：

```
卸载 dsh-prompt-zh → 重新粘贴 github:…#path:/dsh-prompt-zh
```

⚠️ **只"再装一次"不会更新。** pnpm 的锁文件把 commit 钉死了，
同一个 spec 再装会报 `Lockfile is up to date, resolution step is skipped`，
仍停在旧版本。桌面端的插件管理器没有 update 动词（只有
`installBundle` / `removeBundle` / `setBundleEnabled`），所以更新就是卸载 + 再装两步。

---

## macOS 注意

DSH 按平台挂载 shell 工具：Windows 是 `pwsh`，**macOS / Linux 是 `bash`**。
`dsh-prompt-zh` 随包词表只覆盖了 `pwsh`，所以 Mac 上 `tool:bash` 段落和 `bash`
工具描述会退回英文。把补充词表放到位即可：

```sh
mkdir -p ~/.dsh/prompt-zh && cp ~/dsh-plugins/mac-extra/prompt-zh/zh.json ~/.dsh/prompt-zh/zh.json
```

这是插件设计好的用户覆盖层（`$DSH_HOME/prompt-zh/zh.json`），优先级高于随包词表，
只新增 `bash` 条目、不覆盖任何现有译文。**词表按 mtime 失效，改它不用重启宿主。**

装了 DSH 的 agent 也能代劳：「把 mac-extra/prompt-zh/zh.json 拷到 ~/.dsh/prompt-zh/zh.json」。

---

## 维护者笔记

- **`.gitignore` 必须排除 `node_modules/`。** 插件目录里会有 DSH 生成的模块代理
  （指向宿主安装的 junction/symlink），是每台机器自己的，提交上去既无用又会在别人机器上断掉。
  `npm pack` 的 `files` 字段已经把它们排除了，所以用打包内容建仓库是安全的。
- **`.gitattributes` 强制 LF。** 这个仓库在 Windows 上维护、在 macOS 上使用；
  不钉住换行符会在每次提交时产生无意义 diff。
- **隐私**：不要把这个仓库建在一个还放着别的东西的目录里（例如 `~/Documents/dsh`
  下有体检报告和图片）。用独立目录，或者用白名单式 `.gitignore`，push 前先
  `git status` 确认一次。
- **发版**：改完插件代码顺手提一下 `package.json` 的 version。用
  `github:…#<tag>` 钉版本的消费者靠它区分版本。
- **词表维护**：`scripts/translations/*.json` 是人写的一层，`dict/zh.json` 是生成物。
  DSH 升级后跑覆盖率报告，把新条目补进 translations，再
  `node scripts/build-dict.mjs --report <报告>` 重新生成，`node scripts/selftest.mjs` 校验。
- **版本要求**：`dsh-prompt-zh` 声明 `dsh >= 0.1.7-rc.1`；「思辨模式」用的声明行机制
  在 `0.1.7-rc.1` 已就位（该版本含 `dsh-agent-preset` / `dsh-agent-preset-registry` /
  `dsh-client-ui-agent-preset`）。0.1.5 那条线用的是目录式 preset，装不上。
