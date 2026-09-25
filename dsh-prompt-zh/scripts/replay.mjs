/**
 * 离线重放：把英文输入喂给插件入口 `index.js`，看它吐出来的中文并观察日志。
 *
 *   node scripts/replay.mjs [--report <覆盖率报告.json>] [--header <request-header.json>]
 *                           [--reportPath out.json] [--with-missing] [--json result.json]
 *
 * 它不启动宿主，只是拿一个最小的 ctx 替身注册 `system-prompt/assemble` 处理器，
 * 再按宿主的方式调用它。用来在没有 DSH 进程的情况下验证「插件真的会改这份装配」，
 * 而不只是验证词表本身。
 *
 * 输入来源：段落与上下文优先用覆盖率报告（真实英文），没给就用词表自己的 `en` 基线；
 * 工具 schema 优先用会话日志里的 `request/header`（带完整 parameters 结构），
 * 没给就按词表里的参数路径重建一个只含描述的骨架。
 *
 * `--with-missing` 会往装配里塞两样词表肯定没有的东西，用来看漏译在日志里长什么样。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeDict } from '../lib/translate.js';
import { apply } from '../index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(HERE, '..');

/** 读 `--flag <value>`。 */
function flag(name) {
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
}

const reportPath = flag('--report');
const report = reportPath === undefined ? undefined : JSON.parse(readFileSync(reportPath, 'utf8'));
const headerPath = flag('--header');
const header = headerPath === undefined ? undefined : JSON.parse(readFileSync(headerPath, 'utf8'));
const dict = mergeDict({ sections: {}, contexts: {}, tools: {} }, JSON.parse(readFileSync(join(PACKAGE_DIR, 'dict', 'zh.json'), 'utf8')));

/** 把 `properties.a.items.properties.b.description` 这样的路径还原成嵌套 schema（只含描述，够走通翻译）。 */
function schemaFromParameters(parameters) {
	const root = { type: 'object', properties: {} };
	for (const [path, entry] of Object.entries(parameters ?? {})) {
		if (typeof entry.en !== 'string') continue;
		const keys = path.split('.');
		let node = root;
		for (let index = 0; index < keys.length; index += 1) {
			const key = keys[index];
			if (index === keys.length - 1) {
				node[key] = entry.en;
				break;
			}
			node[key] ??= {};
			node = node[key];
		}
	}
	return root;
}

/** 复刻宿主的那份装配：瀑布拿到的段落文本尚未插值，工具 schema 是独立对象。 */
const assembly = {
	sections: (report?.sections ?? Object.entries(dict.sections).map(([pathName, entry]) => ({ path: pathName, en: entry.en })))
		.filter((section) => typeof section.en === 'string')
		.map((section) => ({ name: section.path, text: section.en })),
	contexts: (report?.contexts ?? [])
		.filter((context) => typeof context.en === 'string')
		.map((context) => ({ name: context.path, text: context.en })),
	tools: header === undefined
		? Object.entries(dict.tools).map(([name, tool]) => ({
				name,
				description: tool.description?.en,
				parameters: schemaFromParameters(tool.parameters)
			}))
		: header.header.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
	variables: {}
};

const handlers = [];
const ctx = {
	logger: {
		info: (message) => console.log(`[info] ${message}`),
		warn: (message) => console.warn(`[warn] ${message}`)
	},
	on(event, handler) {
		if (event === 'system-prompt/assemble') handlers.push(handler);
	}
};
apply(ctx, { verbose: true, reportPath: flag('--reportPath') ?? '' });
if (handlers.length !== 1) {
	console.error(`入口没有注册唯一的 system-prompt/assemble 处理器（拿到 ${handlers.length} 个）`);
	process.exit(1);
}

// `--with-missing` 往装配里塞两样词表肯定没有的东西，用来看「漏译」在日志里长什么样，
// 也顺便验证警告只报一次（下面会走第二遍装配）。
if (process.argv.includes('--with-missing')) {
	assembly.sections.push({ name: 'tool:brand-new', text: 'A brand new first-party guidance line.' });
	assembly.tools.push({
		name: 'brand_new_tool',
		description: 'Does something new.',
		parameters: { type: 'object', properties: { thing: { type: 'string', description: 'The new thing.' } } }
	});
}

const before = JSON.stringify(assembly);
const result = await handlers[0](assembly, {}, async () => assembly);
if (result !== assembly) console.error('处理器返回了另一个对象；宿主只采纳返回值，请检查。');

if (process.argv.includes('--with-missing')) {
	console.log('\n—— 第二遍装配：同样的漏译不该再警告一次 ——');
	await handlers[0](assembly, {}, async () => assembly);
}

const rendered = result.sections.map((section) => section.text).join('\n\n');
const untouched = result.sections.filter((section) => !/[\u4e00-\u9fff]/.test(section.text)).map((section) => section.name);
const toolsUntouched = result.tools.filter((tool) => tool.description !== undefined && !/[\u4e00-\u9fff]/.test(tool.description)).map((tool) => tool.name);

const dynamic =
	Object.values(dict.sections).filter((entry) => typeof entry.en !== 'string').length +
	Object.values(dict.contexts).filter((entry) => typeof entry.en !== 'string').length;

console.log(`\n段落 ${result.sections.length} 个，其中未含中文：${untouched.length === 0 ? '无' : untouched.join(', ')}`);
console.log(`工具 ${result.tools.length} 个，其中描述未含中文：${toolsUntouched.length === 0 ? '无' : toolsUntouched.join(', ')}`);
console.log(`上下文 ${result.contexts.length} 个 → ${result.contexts.map((context) => context.text.slice(0, 24)).join(' | ') || '（无）'}`);
if (dynamic > 0) console.log(`另有 ${dynamic} 个动态条目（靠正则取值，没有静态英文基线）不在本重放里，由 selftest 的变体分支覆盖。`);
console.log(`\n──────── 渲染后的系统提示词（前 1200 字）────────\n${rendered.slice(0, 1200)}\n…`);

const out = flag('--json');
if (out !== undefined) {
	writeFileSync(out, `${JSON.stringify({ assembly: result, rendered, before }, undefined, 2)}\n`);
	console.log(`\n完整结果写入 ${out}`);
}
if (before === JSON.stringify(result)) {
	console.error('\n警告：装配结果一个字都没变。');
	process.exitCode = 1;
}
