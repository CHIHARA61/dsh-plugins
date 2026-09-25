# dsh-prompt-zh

English | [中文](README.zh.md)

Turns **the prompt the model actually sees** in DeepSeek Harness into Chinese: system-prompt sections, the runtime-context snapshot, tool descriptions, and tool parameter descriptions. It patches nothing in DSH itself and uninstalls clean.

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
| `warnUntranslated` | `true` | Log one warning per newly seen untranslated/drifted/broken entry |
| `reportPath` | `''` | When set, write the coverage report to this absolute path (per assembly, only when it changed) |
| `verbose` | `false` | Log a one-line count per assembly |

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
- Tool names, parameter names, and enum values stay as they are — they are part of the calling protocol.
- Prompts only. UI copy belongs to `@deepseek-ai/dsh-client-locale`.
- `@deepseek-ai/schemastery` is used only to build the settings-page Config schema, and its construction is wrapped in `safeConfig()`: if the schema cannot be built, you lose the settings page but translation keeps working, and the host never fails to boot. It is the plugin's only third-party import.

## License

MIT
