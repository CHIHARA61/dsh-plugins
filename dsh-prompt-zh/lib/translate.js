/**
 * 译文解析与应用的纯逻辑。
 *
 * 这里刻意不 import 任何 `@deepseek-ai/*` 包：宿主进程通过 profile 的模块解析
 * 层拿到它们，而 `scripts/selftest.mjs` 之类的离线测试不需要。入口 `index.js`
 * 只负责 Config 与挂钩子。
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

/** 是否为「原文已经是中文」——命中则默认跳过替换。 */
export const HAS_CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3000-\u303f]/;

/**
 * 「思考过程用中文」这一段的名字、正文与位置。
 *
 * DSH 与 DeepSeek 适配器都不下发任何「思考语言」指令——请求体里与思考有关的只有
 * `output_config.effort` 与 `thinking.type`，没有语言开关——所以唯一办法是在每一轮
 * 都出现的系统提示词里显式要求一次。DSH 没有内容匹配「模型自身行为要求」的注册段落
 * （persona 属于用户、`harness:identity` 是身份声明），所以这里新增一段，用
 * `prompt-zh:` 前缀与 DSH 自己的段落名区分开。
 *
 * 段落由入口 `index.js` 通过 `ctx.systemPrompt.section()` 注册（DSH 的插件开发规范
 * 要求「加提示词文本用注册表」，而不是在装配钩子里塞段落），本文件只提供它的名字、
 * 正文、位置与「要不要显示」的判据。
 */
export const THINKING_SECTION_NAME = 'prompt-zh:thinking-language';

/**
 * 段落的 order：排在 `deployment:persona-suffix`（10200）之后。
 *
 * DSH 的 first-party 位置落在 -1000..10200 之间，官方文档说外部贡献者可以用任意有限
 * 数值，所以取一个在它们之上的整数。选「最后」而不是「最前」有两个理由：
 *   - 提示词布局仍以 DSH 自己的 `harness:identity` 开场；
 *   - 前缀 KV cache 不被破坏——往末尾追加，前面的段落逐字节不变；往最前插入，
 *     本插件每升一版都会让所有用户的整段前缀缓存失效一次。
 */
export const THINKING_SECTION_ORDER = 20000;

/** 注入的正文；回答语言不跟着变，避免把「用中文思考」误读成「只准说中文」。 */
export const THINKING_SECTION_TEXT = '无论用户使用什么语言，你的思考过程都必须用中文。回答用什么语言不变，照旧跟随用户。';

/**
 * 「已经写过同类要求」的识别规则：中英文都认，要求「思考/推理」与「中文/汉语/Chinese」
 * 落在同一句里（中间不超过 24 个字符）。只对**原文**跑这条规则：内置译文是插件自己写的，
 * 不该反过来把自己的注入关掉。
 */
export const THINKING_REQUEST =
	/(?:思考|推理|思维|reason\w*|think\w*)[^\n。；;!?]{0,24}?(?:中文|汉语|Chinese)|(?:中文|汉语|Chinese)[^\n。；;!?]{0,24}?(?:思考|推理|思维|reason\w*|think\w*)/i;

/**
 * 本轮该不该显示 {@link THINKING_SECTION_NAME} 那一段。
 *
 * 判据只有一条：**别人**已经写过同类要求就不再叠加。用户在自己的 agent preset 里
 * 写中文 persona 时经常会带上这句话，此时插件的注入属于多余，去掉它，尊重用户原文。
 * 传进 `assembly.sections` 必须来自 `translateAssembly` 返回的 `sections`（该函数扫的是
 * 翻译**之前**的原文），否则插件自己写的中文译文会把自己判成「有人写过了」。
 * @param sections - 本轮装配的段落列表（已含本插件注册的那一段）。
 * @returns 需要显示返回 `true`；本插件那一段不在列表里、或别人已写过时返回 `false`。
 */
export function keepThinkingSection(sections) {
	if (!Array.isArray(sections)) return false;
	const own = sections.find((section) => section !== null && typeof section === 'object' && section.name === THINKING_SECTION_NAME);
	if (own === undefined) return false;
	return !sections.some(
		(section) => section !== own && section !== null && typeof section === 'object' && typeof section.text === 'string' && THINKING_REQUEST.test(section.text)
	);
}

/** 一条译文条目：`{ zh, exact?/match?/capture?/en?/variants? }`，也接受直接写字符串。 */
function normalizeEntry(entry) {
	if (typeof entry === 'string') return { zh: entry };
	if (entry === null || typeof entry !== 'object') return undefined;
	if (typeof entry.zh === 'string' || Array.isArray(entry.variants)) return entry;
	return undefined;
}

/** 随包发布的词表文件，按文件名升序（`00-`、`10-` 这样的前缀用来定序）。 */
export function bundledDictFiles(dictDir) {
	try {
		return readdirSync(dictDir)
			.filter((file) => file.endsWith('.json'))
			.sort()
			.map((file) => join(dictDir, file));
	} catch {
		return [];
	}
}

/**
 * 需要监视的词表文件：内置 → 用户覆盖 → `DSH_PROMPT_ZH_DICT` 追加，后写覆盖先写。
 * @param dictDir - 随包发布的词表目录。
 * @param options - `home`（DSH home 目录）与 `env`（进程环境）。
 */
export function dictFilesFor(dictDir, options = {}) {
	const env = options.env ?? process.env;
	const home = options.home;
	const extra = (env.DSH_PROMPT_ZH_DICT ?? '')
		.split(delimiter)
		.map((part) => part.trim())
		.filter((part) => part.length > 0)
		.map((part) => (isAbsolute(part) ? part : resolve(part)));
	const user = home === undefined ? [] : [join(home, 'prompt-zh', 'zh.json')];
	return [...bundledDictFiles(dictDir), ...user, ...extra];
}

/** 合并一份词表到累积结果，后者覆盖前者。 */
export function mergeDict(target, source) {
	if (source === null || typeof source !== 'object') return target;
	for (const kind of ['sections', 'contexts']) {
		if (source[kind] === null || typeof source[kind] !== 'object') continue;
		target[kind] = { ...target[kind], ...source[kind] };
	}
	if (source.tools !== null && typeof source.tools === 'object') {
		for (const [toolName, entry] of Object.entries(source.tools)) {
			if (entry === null || typeof entry !== 'object') continue;
			const previous = target.tools[toolName] ?? {};
			target.tools[toolName] = {
				...previous,
				...entry,
				parameters: { ...(previous.parameters ?? {}), ...(entry.parameters ?? {}) }
			};
		}
	}
	return target;
}

/**
 * 建一个词表加载器：任何被监视文件的大小或 mtime 变了就整体重读。
 * 词表是**数据**，所以改词表不需要重启宿主；改代码才需要。
 * @param files - 要监视并合并的词表文件，按优先级从低到高。
 */
export function createDictLoader(files) {
	let stamp;
	let dict = { sections: {}, contexts: {}, tools: {} };
	let problems = [];
	const loader = {
		get files() {
			return files;
		},
		get problems() {
			return problems;
		},
		/** 当前真实存在的词表文件，供报告记录。 */
		existing() {
			return files.filter((file) => existsSync(file));
		},
		/** 返回当前生效的词表，必要时重读。 */
		current(logger) {
			const next = files
				.map((file) => {
					try {
						const stats = statSync(file);
						return `${file}:${stats.size}:${stats.mtimeMs}`;
					} catch {
						return `${file}:-`;
					}
				})
				.join('|');
			if (next === stamp) return dict;
			const merged = { sections: {}, contexts: {}, tools: {} };
			const found = [];
			for (const file of files) {
				if (!existsSync(file)) continue;
				let parsed;
				try {
					parsed = JSON.parse(readFileSync(file, 'utf8'));
				} catch (error) {
					found.push(`无法解析词表 ${file}：${error instanceof Error ? error.message : String(error)}`);
					continue;
				}
				mergeDict(merged, parsed);
			}
			if (found.length > 0 && logger !== undefined) for (const problem of found) logger.warn(`[prompt-zh] ${problem}`);
			stamp = next;
			dict = merged;
			problems = found;
			return dict;
		}
	};
	return loader;
}

/**
 * 应用一条匹配规则。规则字段：
 *   - `exact`   原文必须逐字等于它，命中才用 `zh`；
 *   - `match`   正则整体替换（`zh` 里可用 `$1`）；
 *   - `capture` 正则只用来取值，命中的捕获组填进 `zh` 的 `$1`/`$2`；
 *   - 三者都没有  无条件用 `zh` 替换（`en` 仅作漂移基线）。
 * @returns 译文、`undefined`（没命中）或 `'invalid'`（正则写错）。
 */
export function applyRule(rule, original) {
	if (rule === null || typeof rule !== 'object' || typeof rule.zh !== 'string') return undefined;
	if (typeof rule.exact === 'string') return rule.exact === original ? rule.zh : undefined;
	if (typeof rule.match === 'string' && rule.match.length > 0) {
		let pattern;
		try {
			pattern = new RegExp(rule.match, rule.matchFlags ?? '');
		} catch {
			return 'invalid';
		}
		return pattern.test(original) ? original.replace(pattern, rule.zh) : undefined;
	}
	if (typeof rule.capture === 'string' && rule.capture.length > 0) {
		let pattern;
		try {
			pattern = new RegExp(rule.capture, rule.matchFlags ?? '');
		} catch {
			return 'invalid';
		}
		const matched = pattern.exec(original);
		if (matched === null) return undefined;
		return rule.zh.replace(/\$(\d+)/g, (_whole, index) => matched[Number(index)] ?? '');
	}
	return rule.zh;
}

/**
 * 解析一条译文条目。
 * @returns `{ text, status }`，`status` 为 `translated` | `missing` | `unchanged` | `skipped-cjk` | `drift` | `invalid`。
 */
export function resolveEntry(rawEntry, original) {
	const entry = normalizeEntry(rawEntry);
	if (entry === undefined) return { text: original, status: 'missing' };
	if (entry.force !== true && HAS_CJK.test(original)) return { text: original, status: 'skipped-cjk' };
	const rules = Array.isArray(entry.variants) ? entry.variants : [entry];
	for (const rule of rules) {
		const applied = applyRule(rule, original);
		if (applied === 'invalid') return { text: original, status: 'invalid' };
		if (applied === undefined) continue;
		if (applied === original) return { text: original, status: 'unchanged' };
		// 只有「无条件替换」才拿 `en` 当漂移基线：带 exact/match/capture 的条目，
		// 规则本身就是基线——正则没命中会走上面的 continue，最终报 drift。
		const matched = typeof rule === 'object' && rule !== null && (rule.exact !== undefined || rule.match !== undefined || rule.capture !== undefined);
		const baseline = typeof rule === 'object' && rule !== null && typeof rule.en === 'string' ? rule.en : entry.en;
		const status = !matched && typeof baseline === 'string' && baseline !== original ? 'drift' : 'translated';
		return { text: applied, status };
	}
	return { text: original, status: 'drift' };
}

/** 记录一条可上报的条目。 */
function makeNote(path, original, result, zh) {
	return {
		path,
		status: result.status,
		en: original,
		zh: result.status === 'translated' ? zh : undefined
	};
}

/** 递归翻译 JSON Schema 里的 `description`，路径形如 `properties.questions.items.properties.id.description`。 */
function translateSchema(node, entry, path, notes) {
	if (node === null || typeof node !== 'object') return;
	if (Array.isArray(node)) {
		node.forEach((child, index) => translateSchema(child, entry, `${path}[${index}]`, notes));
		return;
	}
	for (const [key, value] of Object.entries(node)) {
		const childPath = path.length > 0 ? `${path}.${key}` : key;
		if (key === 'description' && typeof value === 'string') {
			const described = resolveEntry(entry !== undefined ? entry[childPath] : undefined, value);
			if (described.status === 'translated') node[key] = described.text;
			// 报告是完整清单：即使译文与原文一致（例如枚举字面量）也记一条。
			notes.push(makeNote(childPath, value, described, described.text));
			continue;
		}
		translateSchema(value, entry, childPath, notes);
	}
}

/**
 * 对本轮装配应用翻译，并返回覆盖率记录。
 *
 * 顺带回报「本插件的 {@link THINKING_SECTION_NAME} 这一段本轮该不该显示」：那一段
 * 由入口 `index.js` 注册进 DSH 的段落注册表，**不在本函数里注入**——本函数只负责
 * 在翻译过程中扫一遍原文，回答「别人是不是已经写过同样的要求」。扫描必须发生在
 * 翻译之前，否则插件自己写的中文译文会把「别人写过」判成真。
 * @param assembly - `system-prompt/assemble` 瀑布拿到的装配结果，**就地**改写。
 * @param config - `sections`/`contexts`/`tools` 三个翻译开关。
 * @param dict - 当前生效的词表。
 * @returns `{ sections, contexts, tools, keepThinking }`：前三项是覆盖率记录，
 *   `keepThinking` 交给 {@link keepThinkingSection} 决定那一段留不留。
 */
export function translateAssembly(assembly, config, dict) {
	const notes = { sections: [], contexts: [], tools: [], keepThinking: true };

	if (config.sections !== false && Array.isArray(assembly.sections)) {
		for (const section of assembly.sections) {
			if (section === null || typeof section !== 'object' || typeof section.text !== 'string' || section.text.length === 0) continue;
			// 插件自己注册的那一段不走词表、也不进覆盖率记录：同一份装配被重放时
			// （`scripts/replay.mjs --with-missing` 就是这么干的），它不该被报成漏译。
			if (section.name === THINKING_SECTION_NAME) continue;
			const original = section.text;
			const result = resolveEntry(dict.sections[section.name], original);
			if (result.status === 'translated') section.text = result.text;
			notes.sections.push(makeNote(section.name, original, result, result.text));
		}
		notes.keepThinking = keepThinkingSection(assembly.sections);
	}
	if (config.contexts !== false && Array.isArray(assembly.contexts)) {
		for (const context of assembly.contexts) {
			if (context === null || typeof context !== 'object' || typeof context.text !== 'string' || context.text.length === 0) continue;
			const original = context.text;
			const result = resolveEntry(dict.contexts[context.name], original);
			if (result.status === 'translated') context.text = result.text;
			notes.contexts.push(makeNote(context.name, original, result, result.text));
		}
	}
	if (config.tools !== false && Array.isArray(assembly.tools)) {
		for (const tool of assembly.tools) {
			if (tool === null || typeof tool !== 'object') continue;
			const entry = dict.tools[tool.name];
			const record = { name: tool.name, description: undefined, parameters: [] };
			if (typeof tool.description === 'string' && tool.description.length > 0) {
				const original = tool.description;
				const result = resolveEntry(entry?.description, original);
				if (result.status === 'translated') tool.description = result.text;
				record.description = makeNote(`${tool.name}.description`, original, result, result.text);
			}
			if (tool.parameters !== null && typeof tool.parameters === 'object') {
				translateSchema(tool.parameters, entry?.parameters, '', record.parameters);
			}
			notes.tools.push(record);
		}
	}
	return notes;
}

/** 汇总一次装配的各类状态数量。 */
export function summarize(notes) {
	const counts = {};
	const bump = (status) => {
		counts[status] = (counts[status] ?? 0) + 1;
	};
	for (const group of [notes.sections, notes.contexts]) for (const note of group) bump(note.status);
	for (const tool of notes.tools) {
		if (tool.description !== undefined) bump(tool.description.status);
		for (const parameter of tool.parameters) bump(parameter.status);
	}
	return counts;
}

/**
 * 需要有人处理的状态。`skipped-cjk` 是刻意跳过、`unchanged` 无需翻译，都不算问题。
 */
export const PROBLEM_STATUSES = new Set(['missing', 'drift', 'invalid']);

/**
 * 从覆盖率记录里挑出「该有人管」的条目，并把路径补成全局唯一、可直接写进词表的样子
 * （段落/上下文名原样，参数前面补工具名）。
 * @param notes - `translateAssembly` 的返回值。
 * @returns 问题条目数组，元素形如 `{ path, status, en }`。
 */
export function problemsOf(notes) {
	const problems = [];
	for (const group of [notes.sections, notes.contexts]) {
		for (const note of group) if (PROBLEM_STATUSES.has(note.status)) problems.push(note);
	}
	for (const tool of notes.tools) {
		if (tool.description !== undefined && PROBLEM_STATUSES.has(tool.description.status)) problems.push(tool.description);
		for (const parameter of tool.parameters) {
			if (PROBLEM_STATUSES.has(parameter.status)) problems.push({ ...parameter, path: `${tool.name}.${parameter.path}` });
		}
	}
	return problems;
}

/** 生成覆盖率报告的 JSON 文本——它同时是维护者的待办清单。 */
export function renderReport(notes, meta = {}) {
	return `${JSON.stringify(
		{
			generatedAt: new Date().toISOString(),
			plugin: 'dsh-prompt-zh',
			...meta,
			...notes
		},
		undefined,
		2
	)}\n`;
}

/** 把报告落盘；内容与上次相同就不写。 */
export function writeReportFile(reportPath, body, logger) {
	if (body === writeReportFile.last) return;
	writeReportFile.last = body;
	try {
		writeFileSync(reportPath, body);
	} catch (error) {
		if (logger !== undefined) logger.warn(`[prompt-zh] 写覆盖率报告失败：${error instanceof Error ? error.message : String(error)}`);
	}
}
