/**
 * 生成随包发布的词表 `dict/zh.json`。
 *
 * 输入：
 *   - `scripts/translations/*.json`：人写的译文表，只有 key → 中文（按文件名顺序合并，后写覆盖先写）；
 *   - `--report <path>`：可选的覆盖率报告（插件配置 `reportPath` 产出）。报告里有每条
 *     英文原文，脚本据此给词表写入 `en` 字段——它是**漂移检测的基线**：上游改写英文
 *     措辞后，覆盖率报告会把这条标成 `drift`，提醒维护者复核译文。
 *
 * 用法：
 *   node scripts/build-dict.mjs --report /path/to/report.json
 *   node scripts/build-dict.mjs                 # 不写 en，仅合并译文
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(HERE, '..');
const TRANSLATIONS_DIR = join(HERE, 'translations');
const OUTPUT = join(PACKAGE_DIR, 'dict', 'zh.json');

/** 读取命令行上的 `--report <path>`。 */
function reportPathFrom(argv) {
	const index = argv.indexOf('--report');
	return index === -1 ? undefined : argv[index + 1];
}

/** 合并一份译文表到累积结果。 */
function merge(target, source) {
	for (const kind of ['sections', 'contexts']) {
		if (source[kind] === undefined) continue;
		target[kind] = { ...target[kind], ...source[kind] };
	}
	if (source.tools !== undefined) {
		for (const [name, entry] of Object.entries(source.tools)) {
			const previous = target.tools[name] ?? {};
			target.tools[name] = {
				...previous,
				...entry,
				parameters: { ...(previous.parameters ?? {}), ...(entry.parameters ?? {}) }
			};
		}
	}
	return target;
}

/**
 * 用报告里的英文原文给一条译文补上 `en`。
 * `en` 只在「无条件替换」的条目上作漂移基线，所以带 `exact`/`match`/`capture`
 * 的条目（尤其是 `variants`）不写它——那些条目自己就是基线，写了反而会拿一种
 * 变体或一次动态取值去比对另一种，产生假漂移。
 */
function withBaseline(value, english) {
	if (typeof value === 'string') return english === undefined ? { zh: value } : { en: english, zh: value };
	if (value === null || typeof value !== 'object') return undefined;
	if (typeof value.zh !== 'string' && !Array.isArray(value.variants)) return undefined;
	const dynamic = Array.isArray(value.variants) || value.exact !== undefined || value.match !== undefined || value.capture !== undefined;
	return english === undefined || dynamic ? { ...value } : { en: english, ...value };
}

const path = reportPathFrom(process.argv);
const report = path === undefined ? undefined : JSON.parse(readFileSync(path, 'utf8'));

/**
 * 英文基线来源，优先级从低到高：已有 `dict/zh.json` 里的 `en` → 报告里的英文原文。
 * 继承这一层很重要：不带 `--report` 重新生成时，若直接丢掉 `en`，漂移检测就没了。
 */
const english = { sections: {}, contexts: {}, tools: {} };
let inherited = 0;
try {
	const previous = JSON.parse(readFileSync(OUTPUT, 'utf8'));
	for (const kind of ['sections', 'contexts']) {
		for (const [name, entry] of Object.entries(previous[kind] ?? {})) {
			if (typeof entry.en === 'string') {
				english[kind][name] = entry.en;
				inherited += 1;
			}
		}
	}
	for (const [name, tool] of Object.entries(previous.tools ?? {})) {
		const parameters = {};
		if (typeof tool.description?.en === 'string') inherited += 1;
		for (const [parameter, entry] of Object.entries(tool.parameters ?? {})) {
			if (typeof entry.en === 'string') {
				parameters[parameter] = entry.en;
				inherited += 1;
			}
		}
		english.tools[name] = { description: typeof tool.description?.en === 'string' ? tool.description.en : undefined, parameters };
	}
} catch {
	// 还没有生成过，或旧文件坏了：没有可继承的基线。
}
let fromReport = 0;
if (report !== undefined) {
	for (const section of report.sections ?? []) {
		english.sections[section.path] = section.en;
		fromReport += 1;
	}
	for (const context of report.contexts ?? []) {
		english.contexts[context.path] = context.en;
		fromReport += 1;
	}
	for (const tool of report.tools ?? []) {
		const parameters = { ...english.tools[tool.name]?.parameters };
		for (const parameter of tool.parameters ?? []) parameters[parameter.path] = parameter.en;
		english.tools[tool.name] = { description: tool.description?.en ?? english.tools[tool.name]?.description, parameters };
		fromReport += 1;
	}
}

const translations = { sections: {}, contexts: {}, tools: {} };
for (const file of readdirSync(TRANSLATIONS_DIR).filter((name) => name.endsWith('.json')).sort()) {
	merge(translations, JSON.parse(readFileSync(join(TRANSLATIONS_DIR, file), 'utf8')));
}

const output = { sections: {}, contexts: {}, tools: {} };
const problems = [];
for (const kind of ['sections', 'contexts']) {
	for (const [name, value] of Object.entries(translations[kind])) {
		const entry = withBaseline(value, english[kind][name]);
		if (entry === undefined) {
			problems.push(`${kind}.${name}：条目缺少 zh 字符串`);
			continue;
		}
		if (report !== undefined && english[kind][name] === undefined) problems.push(`${kind}.${name}：报告里没有这个 ${kind === 'sections' ? '段落' : '上下文'}，可能已改名或删除`);
		output[kind][name] = entry;
	}
}
for (const [name, entry] of Object.entries(translations.tools)) {
	const record = { parameters: {} };
	if (entry.description !== undefined) record.description = withBaseline(entry.description, english.tools[name]?.description);
	else if (report !== undefined) problems.push(`tools.${name}：缺少 description 译文`);
	for (const [parameter, value] of Object.entries(entry.parameters ?? {})) {
		const translated = withBaseline(value, english.tools[name]?.parameters?.[parameter]);
		if (translated === undefined) {
			problems.push(`tools.${name}.parameters.${parameter}：条目缺少 zh 字符串`);
			continue;
		}
		if (report !== undefined && english.tools[name]?.parameters?.[parameter] === undefined) problems.push(`tools.${name}.parameters.${parameter}：报告里没有这个参数路径`);
		record.parameters[parameter] = translated;
	}
	output.tools[name] = record;
}

writeFileSync(OUTPUT, `${JSON.stringify(output, undefined, 2)}\n`);

if (report !== undefined) {
	for (const section of report.sections ?? []) if (translations.sections[section.path] === undefined) problems.push(`漏译 sections.${section.path}`);
	for (const context of report.contexts ?? []) if (translations.contexts[context.path] === undefined) problems.push(`漏译 contexts.${context.path}`);
	for (const tool of report.tools ?? []) {
		if (translations.tools[tool.name]?.description === undefined) problems.push(`漏译 tools.${tool.name}.description`);
		for (const parameter of tool.parameters ?? []) {
			if (translations.tools[tool.name]?.parameters?.[parameter.path] === undefined) problems.push(`漏译 tools.${tool.name}.parameters.${parameter.path}`);
		}
	}
}

const counts = {
	sections: Object.keys(output.sections).length,
	contexts: Object.keys(output.contexts).length,
	tools: Object.keys(output.tools).length,
	parameters: Object.values(output.tools).reduce((sum, tool) => sum + Object.keys(tool.parameters).length, 0)
};
console.log(`写入 ${OUTPUT}`);
console.log(`段落 ${counts.sections} · 上下文 ${counts.contexts} · 工具 ${counts.tools} · 参数 ${counts.parameters}`);
console.log(`en 基线：继承 ${inherited} 条${report === undefined ? '（未提供 --report）' : ` ＋ 报告覆盖 ${fromReport} 条`}`);
if (report === undefined && inherited === 0) {
	console.log('\n注意：既没有 --report 也没有可继承的基线，生成的词表不带漂移检测。');
}
if (problems.length > 0) {
	console.log(`\n需要处理 ${problems.length} 项：`);
	for (const problem of problems) console.log(`  - ${problem}`);
	process.exitCode = 1;
}
