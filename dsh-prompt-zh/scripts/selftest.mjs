/**
 * 离线自检：不启动宿主，直接验证「词表 × 真实英文原文 → 中文」这条链路。
 *
 *   node scripts/selftest.mjs [--report <覆盖率报告.json>]
 *
 * 有报告时，用它记录的英文原文逐条断言全部译出；没有报告时只做结构与规则自检。
 * 报告由插件配置 `reportPath` 产出，见 README。
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FIELDS, DEFAULTS, buildConfig, safeConfig } from '../lib/config.js';
import { HAS_CJK, mergeDict, problemsOf, resolveEntry } from '../lib/translate.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(HERE, '..');

const reportIndex = process.argv.indexOf('--report');
const reportPath = reportIndex === -1 ? undefined : process.argv[reportIndex + 1];

const dict = mergeDict({ sections: {}, contexts: {}, tools: {} }, JSON.parse(readFileSync(join(PACKAGE_DIR, 'dict', 'zh.json'), 'utf8')));
const failures = [];
const notes = [];

/** 断言一条输入被译出（或与原文一致——例如枚举字面量无需翻译）。 */
function expectTranslated(kind, path, english, entry) {
	const result = resolveEntry(entry, english);
	if (result.status !== 'translated' && result.status !== 'unchanged') {
		failures.push(`${kind} ${path}：${result.status}`);
		return;
	}
	notes.push(`  ${kind.padEnd(7)} ${path} → ${result.text}`);
}

if (reportPath !== undefined) {
	const report = JSON.parse(readFileSync(reportPath, 'utf8'));
	for (const section of report.sections ?? []) expectTranslated('section', section.path, section.en, dict.sections[section.path]);
	for (const context of report.contexts ?? []) expectTranslated('context', context.path, context.en, dict.contexts[context.path]);
	for (const tool of report.tools ?? []) {
		if (tool.description !== undefined) expectTranslated('tool', tool.name, tool.description.en, dict.tools[tool.name]?.description);
		for (const parameter of tool.parameters ?? []) {
			expectTranslated('param', `${tool.name}.${parameter.path}`, parameter.en, dict.tools[tool.name]?.parameters?.[parameter.path]);
		}
	}
} else {
	// 没有报告时用词表自己的 `en` 基线当输入。带 `capture` 的动态条目没有基线，
	// 它们的各个分支在上面 explicit 的 variants 列表里单独覆盖。
	for (const [pathName, entry] of Object.entries(dict.sections)) {
		if (typeof entry.en === 'string') expectTranslated('section', pathName, entry.en, entry);
	}
	for (const [pathName, entry] of Object.entries(dict.contexts)) {
		if (typeof entry.en === 'string') expectTranslated('context', pathName, entry.en, entry);
	}
	for (const [toolName, tool] of Object.entries(dict.tools)) {
		if (tool.description === undefined) failures.push(`tools.${toolName}：缺少 description 译文`);
		else expectTranslated('tool', toolName, tool.description.en ?? tool.description, tool.description);
		for (const [parameter, entry] of Object.entries(tool.parameters ?? {})) {
			if (typeof entry.en !== 'string') continue;
			expectTranslated('param', `${toolName}.${parameter}`, entry.en, entry);
		}
	}
}

// —— 变体与动态文本：报告只含当前生效的那一种，这里把其余分支也过一遍。——————
const variants = [
	[
		'context',
		'sandbox:policy / read-only',
		'Current DSH file policy: read-only. Any available operation enforced by the DSH file sandbox cannot modify files in the standing mode. Do not refuse a required modification from this policy alone: try an available tool normally and follow any denial and escalation guidance it returns.'
	],
	[
		'context',
		'sandbox:policy / workspace-write',
		'Current DSH file policy: workspace-write. Any available operation enforced by the DSH file sandbox may modify files under the session workspace: "C:\\\\work\\\\ws". Some platform temporary areas may also be writable.'
	],
	[
		'context',
		'sandbox:policy / danger-full-access',
		'Current DSH file policy: danger-full-access. The DSH file sandbox does not restrict file modifications by available operations.'
	],
	[
		'context',
		'approval:policy / ask',
		'Approval policy: ask. Operations that require approval may ask through the configured answerers; without an available answerer, the request fails closed.'
	],
	[
		'context',
		'approval:policy / never',
		'Approval prompts are disabled in this session: actions that require approval are rejected automatically — do not request sandbox escalation (do not set `sandbox_permissions`).'
	],
	[
		'section',
		'harness:source',
		'The DeepSeek Harness implementation checkout is at C:\\Users\\me\\dsh-checkout. The checkout location and current working directory are separate values and may differ; never infer the working directory from this path. Use pwd to determine the current working directory. Use this checkout only to inspect or extend DSH itself.'
	],
	[
		'section',
		'app:web-surface',
		'You are interacting with the user through the DeepSeek Harness Web GUI at http://127.0.0.1:3080. When the user refers to "this page", "this GUI", or "this app" without naming another target, they mean this GUI. The browser provides no implicit DOM, route, or screenshot context. The client-plugin HMR receiver is active, but client-plugin changes reload without a refresh only while `pnpm run dev:web` is also running from this same checkout to rebuild their bundles; verify that watcher before promising automatic updates. Every other change — the apps/web shell and plain packages — requires rebuilding the affected Web artifacts and verifying this existing URL after a page refresh. Starting another server does not update this GUI. The apps/web Vite entry builds the shell but is not a standalone application because only dsh web injects window.__DSH_BOOT__. Do not start a replacement server unless the user asks; if one is needed, use a managed background job and verify its exact URL.'
	]
];
for (const [kind, pathName, english] of variants) {
	const table = kind === 'context' ? dict.contexts : dict.sections;
	expectTranslated(kind, pathName, english, table[pathName.split(' / ')[0]]);
}

// —— 配置：字段表、缺省值、schema 三者不许漂移；schemastery 换 API 时必须降级。——
function checkConfig() {
	/** 记录每次字段声明的假 schemastery：只认 buildConfig 用到的那几个方法。 */
	const fakeZ = {
		boolean: () => ({ kind: 'boolean', default: (value) => ({ kind: 'boolean', value }) }),
		string: () => ({ kind: 'string', default: (value) => ({ kind: 'string', value }) }),
		object: (fields) => ({ kind: 'object', fields })
	};
	const schema = buildConfig(fakeZ);
	const fields = schema.fields ?? {};
	for (const name of Object.keys(CONFIG_FIELDS)) {
		if (!Object.hasOwn(DEFAULTS, name)) failures.push(`CONFIG_FIELDS.${name} 在 DEFAULTS 里没有对应项`);
		if (!Object.hasOwn(fields, name)) failures.push(`CONFIG_FIELDS.${name} 没有出现在 Config schema 里`);
	}
	for (const [name, value] of Object.entries(DEFAULTS)) {
		if (!Object.hasOwn(CONFIG_FIELDS, name)) failures.push(`DEFAULTS.${name} 没有写进 CONFIG_FIELDS`);
		const field = fields[name];
		if (field === undefined) continue;
		if (field.kind !== typeof value) failures.push(`字段 ${name} 的 schema 类型 ${field.kind} 与默认值类型 ${typeof value} 不符`);
		if (field.value !== value) failures.push(`字段 ${name} 的 schema 默认值 ${JSON.stringify(field.value)} 与 DEFAULTS 不符`);
	}
	if (safeConfig(() => ({ ok: true })) === undefined) failures.push('safeConfig 吞掉了正常返回值');
	let caught;
	const degraded = safeConfig(
		() => {
			throw new Error('schemastery 换了 API');
		},
		(error) => {
			caught = error;
		}
	);
	if (degraded !== undefined) failures.push('safeConfig 没有在构造失败时降级为 undefined');
	if (caught === undefined) failures.push('safeConfig 没有把失败原因交出来');
	return Object.keys(fields).length;
}
const configFields = checkConfig();

// —— 漏译可见性：只有 missing/drift/invalid 才算「要人管」，且参数带上工具名。—————
const problemNotes = problemsOf({
	sections: [
		{ path: 'tool:read', status: 'translated' },
		{ path: 'tool:new', status: 'missing' },
		{ path: 'deployment:persona-prefix', status: 'skipped-cjk' }
	],
	contexts: [{ path: 'sandbox:policy', status: 'drift' }],
	tools: [
		{ name: 'read', description: { path: 'read.description', status: 'unchanged' }, parameters: [{ path: 'properties.limit.description', status: 'missing' }] },
		{ name: 'grep', description: { path: 'grep.description', status: 'translated' }, parameters: [{ path: 'properties.pattern.description', status: 'invalid' }] }
	]
});
const problemPaths = problemNotes.map((problem) => `${problem.status}:${problem.path}`).sort();
const expectedPaths = ['missing:tool:new', 'drift:sandbox:policy', 'missing:read.properties.limit.description', 'invalid:grep.properties.pattern.description'].sort();
if (problemPaths.join('|') !== expectedPaths.join('|')) failures.push(`problemsOf 挑错了条目：${problemPaths.join(', ')}`);

// —— 安全规则：原文已经是中文时不动它（尊重用户自己的中文 persona）。————————
const chinesePersona = '你是一个严格的对话者，由 {{model}} 驱动。';
const guarded = resolveEntry(dict.sections['deployment:persona-prefix'], chinesePersona);
if (guarded.status !== 'skipped-cjk' || guarded.text !== chinesePersona) failures.push('安全规则失效：中文 persona 被改写了');
if (!HAS_CJK.test(chinesePersona)) failures.push('CJK 检测失效');

// —— 未收录的名字应当明确报成 missing，而不是静默通过。——————————————————
if (resolveEntry(dict.sections['tool:从没见过的段落'], 'Some new guidance.').status !== 'missing') failures.push('未收录条目的状态不是 missing');

// —— 上游改动模拟：DSH 换了措辞 / 加了新东西 / 改了动态段落的结构，
//    它分别退化成什么样。这是本插件「不用跟着每次更新同步」这一说法的证据。——————
const churn = [];
/** 断言一次模拟退化的方式。 */
function expectDegrade(label, expectation, entry, input) {
	const result = resolveEntry(entry, input);
	const chinese = HAS_CJK.test(result.text);
	const ok = result.status === expectation.status && chinese === expectation.chinese;
	if (!ok) failures.push(`退化模拟「${label}」不符预期：status=${result.status} 含中文=${chinese}`);
	churn.push(
		`  ${ok ? '✓' : '✗'} ${label.padEnd(30)} status=${result.status.padEnd(12)} 译文仍为中文=${chinese ? '是' : '否'}`
	);
}

const readSection = dict.sections['tool:read'];
expectDegrade(
	'改写已有段落的措辞',
	{ status: 'drift', chinese: true },
	readSection,
	`${readSection.en} Also switch to read_image when the file is not UTF-8 text.`
);
expectDegrade(
	'新增一个工具',
	{ status: 'missing', chinese: false },
	dict.tools['read_v2']?.description,
	'Read a file from the new backend.'
);
expectDegrade(
	'参数换名（old_string → before）',
	{ status: 'missing', chinese: false },
	dict.tools.edit?.parameters?.['properties.before.description'],
	'Literal text to replace.'
);
expectDegrade(
	'动态段落改了结构（正则不再命中）',
	{ status: 'drift', chinese: false },
	dict.sections['harness:source'],
	'The DeepSeek Harness source tree lives at C:\\elsewhere. Check pwd instead.'
);
expectDegrade(
	'新的沙箱模式取值',
	{ status: 'drift', chinese: false },
	dict.contexts['sandbox:policy'],
	'Current DSH file policy: network-deny. The DSH file sandbox also blocks sockets.'
);

if (process.argv.includes('--show')) console.log(notes.join('\n'));

const counts = {
	sections: Object.keys(dict.sections).length,
	contexts: Object.keys(dict.contexts).length,
	tools: Object.keys(dict.tools).length,
	parameters: Object.values(dict.tools).reduce((sum, tool) => sum + Object.keys(tool.parameters ?? {}).length, 0)
};
console.log(`词表：段落 ${counts.sections} · 上下文 ${counts.contexts} · 工具 ${counts.tools} · 参数 ${counts.parameters}`);
console.log(`配置：${configFields} 个字段，字段表/缺省值/schema 一致，构造失败会降级。`);
console.log(
	reportPath === undefined
		? `未提供报告：已按词表自己的 en 基线 + 变体分支校验 ${notes.length} 项。`
		: `已按报告逐条校验 ${notes.length} 项。`
);
console.log('\n上游改动模拟（status 由覆盖率报告给出；译文仍为中文=退化时用户看到什么）：');
console.log(churn.join('\n'));
if (failures.length > 0) {
	console.log(`\n失败 ${failures.length} 项：`);
	for (const failure of failures) console.log(`  - ${failure}`);
	process.exitCode = 1;
} else {
	console.log('\n全部通过。');
}
