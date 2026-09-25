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
 * @param assembly - `system-prompt/assemble` 瀑布拿到的装配结果，**就地**改写。
 * @param config - `sections`/`contexts`/`tools` 三个开关。
 * @param dict - 当前生效的词表。
 */
export function translateAssembly(assembly, config, dict) {
	const notes = { sections: [], contexts: [], tools: [] };

	if (config.sections !== false && Array.isArray(assembly.sections)) {
		for (const section of assembly.sections) {
			if (section === null || typeof section !== 'object' || typeof section.text !== 'string' || section.text.length === 0) continue;
			const original = section.text;
			const result = resolveEntry(dict.sections[section.name], original);
			if (result.status === 'translated') section.text = result.text;
			notes.sections.push(makeNote(section.name, original, result, result.text));
		}
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
