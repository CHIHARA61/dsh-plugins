# dsh-prompt-zh

English | [中文](README.zh.md)

Turns **the prompt the model actually sees** in DeepSeek Harness into Chinese: system-prompt sections, the runtime-context snapshot, tool descriptions, and tool parameter descriptions — and gets the model's own thinking into Chinese with it. It patches nothing in DSH itself and uninstalls clean.

## Why not an English-phrase translation table

The usual Chinese-prompt plugin keys a big table on the English source text. That does not survive contact with DSH: upstream rewords a sentence, adds a tool, or documents one more parameter every few days, and each of those silently reverts that line to English. That is how such a plugin ends up "only partly Chinese".

This plugin keys on **stable identifiers** instead:

| Kind | Key | Example |
|---|---|---|
| Prompt section | section name | `tool:read`, `harness:identity`, `deployment:persona-prefix` |
| Runtime context | context name | `sandbox:policy`, `approval:policy` |
| Tool | tool name | `read`, `pwsh`, `workflow` |
| Tool parameter | parameter path | `edit.parameters.properties.old_string.description` |

Section and tool names are part of DSH's own plugin-facing contract, so upstream rewording does not invalidate a translation. What it does mean is that newly added sections, tools, and parameters stay English until translated — and that is never silent: every assembly counts them, and the coverage report names each one.

Two safety rules:

- **Text that is already Chinese is left alone.** A persona you wrote yourself in an agent preset is never overwritten by a bundled translation. Add `"force": true` to an entry to override that.
- **Prompt variables still interpolate.** Write `{{model}}` or `{{cwd}}` in a translation; interpolation happens after this plugin runs.

## Install

```sh
dsh plugin --profile web add dsh-prompt-zh
```

Then restart `dsh web`. The first system prompt of a new session is already Chinese.

## Configuration

The settings appear under **Settings → Plugins → Plugin configuration** (dsh ≥ 0.1.7 derives them from the plugin's own Config schema), or in the profile's `cordis.patch.yml`:

| Field | Default | Meaning |
|---|---|---|
| `sections` | `true` | Translate system-prompt sections |
| `contexts` | `true` | Translate the runtime-context snapshot |
| `tools` | `true` | Translate tool descriptions and parameter descriptions |
| `thinkInChinese` | `true` | Register one section telling the model to think in Chinese (last in the section list; inactive while `sections` is off) |
| `warnUntranslated` | `true` | Log one warning per newly seen untranslated/drifted/broken entry |
| `reportPath` | `''` | When set, write the coverage report to this absolute path (per assembly, only when it changed) |
| `verbose` | `false` | Log a one-line count per assembly |

## Making the model think in Chinese

The prompt turns Chinese but the thinking stays English — because the DSH DeepSeek adapter **sends no thinking-language instruction at all**: the only thinking-related request fields are `output_config.effort` and `thinking.type`, with no language switch. The only lever left is the system prompt, which is present every single turn.

So while `sections` is on (and `thinkInChinese` is not off), the plugin registers one section, `prompt-zh:thinking-language`, with order 20000 — right after `deployment:persona-suffix`:

> 无论用户使用什么语言，你的思考过程都必须用中文。回答用什么语言不变，照旧跟随用户。

(No matter what language the user writes in, your thinking must be in Chinese. The answer language does not change; it still follows the user.)

That section is the plugin's own — it shadows no DSH-registered section, and it is not a dictionary entry or a coverage-report row, because it is not a translation of any English text. Three choices are worth stating:

- **Why a new section instead of hooking onto an existing one.** DSH has no section about the model's own thinking language: the persona belongs to the user, and `harness:identity` is a statement of identity. Attaching to either would be rewriting someone else's words.
- **Why `ctx.systemPrompt.section()` instead of pushing a section inside the assembly hook.** Registering is what the DSH plugin-writing rules require ("Add prompt text with `ctx.systemPrompt.section()`"). This plugin's translate hook does only one thing for it — deciding whether someone else already asked — and blanks its own section in place for that turn, so both stay compliant. A registered section is visible to `system-prompt/change` and can be overridden wholesale by a preset or another plugin using the same name.
- **Why last rather than first.** The prompt still opens with DSH's own `harness:identity`, and more importantly the prefix KV cache survives: appending leaves every earlier section byte-identical, while prepending would invalidate every user's whole cached prefix on each plugin release.

Two guards:

- **Someone already asked for it, so it is not shown.** If your own persona already contains a requirement like "用中文思考" or "think in Chinese" (both languages are recognized; the word for thinking and the word for Chinese must land in the same sentence), the plugin blanks its own section for that turn (DSH drops empty sections when rendering) and keeps your wording. The check reads only the **pre-translation** text, so the plugin's own Chinese output cannot trip it. To word it yourself, turn `thinkInChinese` off and write it in the persona.
- **The section name stays unique.** A duplicate section name fails DSH's whole assembly invariant, so the plugin registers exactly one section and never inserts a second.

Two ways to turn it off: `thinkInChinese: false` (this sentence only), or `sections: false` (this sentence together with section translation).

## Untranslated text is never silent

Every **newly seen** problem (`missing`, `drift`, or a broken regex) is warned about once in the host log, and never repeated:

```
[prompt-zh] 3 条文本没有中文译文，本轮按英文原文发给模型：tool:brand-new(missing)、
brand_new_tool.description(missing)、brand_new_tool.properties.thing.description(missing)。
补词表见插件 README；把 reportPath 指到一个文件可拿到完整清单。
```

Set `reportPath` (or `verbose: true`) for the full picture. The report is a **complete census** of the current assembly — one entry per section, context, tool description, and parameter description, each with a `status`: `translated`, `unchanged` (the translation equals the English, e.g. an enum literal), `missing` (no entry), `drift` (an entry exists but its rule did not match, or upstream reworded the text), `skipped-cjk` (the source is already Chinese), or `invalid` (a broken regex in the dictionary).

Run it after a DSH upgrade and it tells you exactly what needs translating — that is what keeps this plugin from becoming the thing it replaces.

## Dictionaries

The bundled dictionary is `dict/zh.json`. An entry may be a bare string, or an object with `zh` plus one matcher: `exact` (verbatim match), `match` (whole-text regex replace, `$1` allowed), or `capture` (regex used only to extract values, substituted into `zh`). `variants` tries several rules in order; `en` is a drift baseline written back by the build script and never used for matching; `force` bypasses the already-Chinese rule.

The bundled dictionary is calibrated against the prompt DSH `0.2.1-rc.5` actually emits (Windows desktop profile): 25 sections, 6 contexts, 60 tools, and 244 parameter descriptions, with 0 `missing` and 0 `drift` in that assembly — reproduce with `scripts/selftest.mjs` and `scripts/replay.mjs`.

Eight of those entries translate the third-party `dsh-ops` bundle (`ops_*` tools and its `dsh-ops:discovery-tools` section) and live in `scripts/translations/80-third-party-dsh-ops.json`: they never match unless that bundle is installed, and then they localize it too.

DSH 0.2.1 split the checkout path and the Web UI URL out of their sections: the static explanation keeps the `harness:source` / `app:web-surface` section names, while the dynamic value became a same-named **context** (`Current DeepSeek Harness implementation checkout: "…"`). The dictionary covers both — a plain translation for the section, a `match` regex for the context.

Dictionaries merge in this order, later winning: bundled `dict/*.json` (sorted by filename), `$DSH_HOME/prompt-zh/zh.json`, then any files listed in `DSH_PROMPT_ZH_DICT` (`;`-separated on Windows, `:` elsewhere).

Dictionaries are read as data and invalidated by mtime, so **editing a dictionary needs no host restart** — only editing code does. One override entry is enough to change a single sentence into your own wording.

## Maintaining the dictionary

```sh
node scripts/build-dict.mjs --report dsh-zh-report.json   # regenerate dict/zh.json
node scripts/selftest.mjs   --report dsh-zh-report.json   # verify every entry offline
node scripts/replay.mjs --with-missing                    # see a whole assembly rendered, and the warning
```

`scripts/translations/*.json` is the hand-written layer (key → Chinese); `dict/zh.json` is generated and additionally carries the `en` baselines. The self-test needs no host: it replays every English string from the report through the matching rules, including the variant branches the report does not currently exercise. Without a report it falls back to the dictionary's own `en` baselines and adds an upstream-churn simulation — rewording, a new tool, a renamed parameter, a regex that stops matching — asserting how each one degrades.

## What happens when DSH updates

| Upstream change | Is the Chinese still there? | Reported status |
|---|---|---|
| Reworded text (same section/tool) | Yes (the translation may be slightly stale) | `drift` |
| A new tool / parameter / section | Everything else stays Chinese; only that item is English | `missing` |
| A dynamic section changed shape | That one falls back to English | `drift` |
| A section or tool was renamed | That one falls back to English | `missing` (rebuilding also names the orphaned entries) |
| The assembly hook itself changed shape | Needs a code change (~30 lines, all in `lib/translate.js`) | — |

Degradation is per entry, never the whole prompt — which is the difference from an English-phrase table.

## Known limits

- The fixed first line of the runtime-context snapshot (`Current runtime context. This snapshot supersedes earlier runtime-context snapshots.`) is joined **after** the assembly waterfall, so this plugin cannot reach it.
- **Since DSH 0.2.1 the whole runtime-context snapshot is out of reach.** The text the model sees is re-resolved by `SystemPrompt.refreshContext()` from the registered providers *after* the assembly waterfall (`step()` in `dsh-agent-loop` renders it that way), so any `context.text` this plugin rewrote is discarded there. The coverage report still says `translated`, because it reports what happened inside the waterfall. Affected: `sandbox:policy`, `approval:policy`, `working-directory:current`, `team:identity`, `harness:source`, `app:web-surface`. Sections and tool descriptions are rendered from the assembly itself, so they stay translated. Fixing it needs a later hook (an `agent/pre-step` message rewrite), which is a separate change; the path did work on 0.1.7.
- **There is no thinking-language switch to flip.** Neither DSH nor the DeepSeek adapter sends such an instruction (the request carries only `output_config.effort` and `thinking.type`), so "think in Chinese" can only ride the system prompt — it is a request, not an enforcement, and the model may still occasionally think in English.
- With an agent preset that sets `complete: true`, DSH replaces the whole section list with that one section (the copy taken **before** the waterfall), so the section this plugin registers (including the Chinese-thinking one) and all section translation stop applying; contexts and tool descriptions are unaffected.
- The Chinese-thinking section has a fixed position (last, order 20000). DSH's scoped layer shadows the global layer by section name, so any agent preset or plugin that registers a `prompt-zh:thinking-language` section of its own replaces both its position and its wording.
- The skill-catalog reminder (the `<system-reminder>` block carrying the `available_skills` list) is injected as a user message after assembly as well, so the plugin cannot reach that either: it stays English and never appears in the coverage report.
- Tool names, parameter names, and enum values stay as they are — they are part of the calling protocol.
- Prompts only. UI copy belongs to `@deepseek-ai/dsh-client-locale`.
- `@deepseek-ai/schemastery` is used only to build the settings-page Config schema, and its construction is wrapped in `safeConfig()`: if the schema cannot be built, you lose the settings page but translation keeps working, and the host never fails to boot. It is the plugin's only third-party import.

## License

MIT
