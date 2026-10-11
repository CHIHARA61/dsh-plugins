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
import {
	HAS_CJK,
	THINKING_SECTION_NAME,
	THINKING_SECTION_ORDER,
	THINKING_SECTION_TEXT,
	keepThinkingSection,
	mergeDict,
	problemsOf,
	resolveEntry,
	translateAssembly
} from '../lib/translate.js';
import { apply } from '../index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(HERE, '..');

const reportIndex = process.argv.indexOf('--report');
const reportPath = reportIndex === -1 ? undefined : process.argv[reportIndex + 1];

const dict = mergeDict({ sections: {}, contexts: {}, tools: {} }, JSON.parse(readFileSync(join(PACKAGE_DIR, 'dict', 'zh.json'), 'utf8')));
const failures = [];

// —— 段落注册表替身：`ctx.systemPrompt.section()` 最小桩。———————————————————————
//
// 入口 `index.js` 用注册表把「思考过程用中文」那段交付给 DSH，所以离线测试也得有
// 一个注册表，否则连 `apply()` 都跑不起来（`scripts/replay.mjs` 里另有一份同样用途的桩）。
const SECTION_ORDER_PERSONA_SUFFIX = 10200; // dsh-system-prompt 的 SECTION_ORDERS.DEPLOYMENT_PERSONA_SUFFIX
const registry = [];
/** 造一个只认本插件用到的那几个方法的假 ctx，并按给定配置加载一次插件。 */
function loadPlugin(config) {
	const fake = {
		logger: { info: () => {}, warn: () => {} },
		effect: (callback) => {
			const dispose = callback();
			return typeof dispose === 'function' ? dispose : () => {};
		},
		on: () => {},
		systemPrompt: {
			section: (entry) => {
				registry.push(entry);
				return () => {
					const index = registry.indexOf(entry);
					if (index !== -1) registry.splice(index, 1);
				};
			}
		}
	};
	apply(fake, config);
}
/** 注册表里最后一段的名字与内容，用来断言「注册了什么」。 */
function registeredSection() {
	return registry.at(-1) ?? {};
}
/** 注册表里某个名字出现了几次——同名段落会让 DSH 的装配不变量判失败。 */
function registeredCount(name) {
	return registry.filter((entry) => entry?.name === name).length;
}
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

// —— 中文思考要求：注册在最后 / 别人写过就不显示 / 自己那一段不进覆盖率记录。————
//
// 这一段不是「翻译」而是「插件自己往系统提示词里加的要求」，所以走的是 DSH 的段落
// 注册表（`ctx.systemPrompt.section()`）：注册发生在插件加载时，装配时的判据只有
// 「别人写过没有」。离线测试把这两件事分开验：注册用 `registeredSection()` 检查
// 位置与正文，装配用 `keepThinkingSection()` 检查判据。
const identity = { name: 'harness:identity', text: dict.sections['harness:identity'].en };

// 默认配置加载一次：注册表里应当出现本插件那一段。
loadPlugin(undefined);
const thinking = registeredSection();
if (thinking.name !== THINKING_SECTION_NAME) failures.push(`默认配置下注册的段名是 ${thinking.name}`);
if (thinking.order !== THINKING_SECTION_ORDER) {
	failures.push(`注册的 order 是 ${thinking.order}，与 THINKING_SECTION_ORDER 不符`);
}
if (thinking.text !== THINKING_SECTION_TEXT) failures.push(`注册的正文与 THINKING_SECTION_TEXT 不符：${thinking.text}`);
if (thinking.order <= SECTION_ORDER_PERSONA_SUFFIX) {
	failures.push(`注册位置（${thinking.order}）没有排在 deployment:persona-suffix（${SECTION_ORDER_PERSONA_SUFFIX}）之后`);
}
// 两个开关关掉就不注册：注册表里不留东西，卸载也一样干净。
let offWithSwitch = false;
let offWithSections = false;
for (const [label, config] of [
	['thinkInChinese: false', { ...DEFAULTS, thinkInChinese: false }],
	['sections: false', { ...DEFAULTS, sections: false }]
]) {
	registry.length = 0;
	loadPlugin(config);
	if (registeredCount(THINKING_SECTION_NAME) !== 0) {
		if (label.startsWith('thinkInChinese')) offWithSwitch = true;
		else offWithSections = true;
		failures.push(`${label} 时仍然注册了中文思考要求`);
	}
	if (registry.length !== 0) failures.push(`${label} 时注册表里还留了别的段落`);
}

// 宿主渲染前的装配：注册进来的那一段 + 别人已有的段落。
const asmWithThinking = (sections) => [{ name: THINKING_SECTION_NAME, text: THINKING_SECTION_TEXT }, ...sections];
if (keepThinkingSection(asmWithThinking([{ ...identity }])) !== true) failures.push('没人写过同类要求时，中文思考要求反而被关掉了');
if (keepThinkingSection([{ ...identity }]) !== false) failures.push('自己那一段不在装配里时，判据却说要显示');

// 用户自己在 persona 里写过「用中文思考」——中文、英文各一支，都不该再叠加。
const ownChinese = '你是一个严格的对话者：思考过程必须用中文，回答跟随用户。';
const ownEnglish = 'Always reason in Chinese before answering.';
let failedOwn = false;
for (const [label, text] of [['中文 persona', ownChinese], ['英文 persona', ownEnglish]]) {
	const sections = asmWithThinking([{ name: 'deployment:persona-prefix', text }]);
	if (keepThinkingSection(sections)) {
		failedOwn = true;
		failures.push(`用户已经写过同类要求（${label}）时仍然要显示注入`);
	}
	const translated = translateAssembly({ sections, contexts: [], tools: [] }, DEFAULTS, dict);
	if (sections.find((section) => section.name === 'deployment:persona-prefix')?.text !== text) {
		failures.push(`用户自己写的 ${label} 被改写了`);
	}
	if (translated.keepThinking !== false) failures.push(`translateAssembly 没有把「${label} 已写过」回报出来`);
}

// 插件自己那一段：不走词表、不进覆盖率记录，重复装配也不叠加。
const thinkingOnly = { sections: asmWithThinking([{ ...identity }]), contexts: [], tools: [] };
const firstNotes = translateAssembly(thinkingOnly, DEFAULTS, dict);
const secondNotes = translateAssembly({ sections: asmWithThinking([{ ...identity }]), contexts: [], tools: [] }, DEFAULTS, dict);
if (firstNotes.sections.some((note) => note.path === THINKING_SECTION_NAME)) failures.push('插件自己那一段被算进了覆盖率记录');
if (problemsOf(firstNotes).some((problem) => problem.path === THINKING_SECTION_NAME)) failures.push('插件自己那一段被报成了漏译');
if (problemsOf(secondNotes).some((problem) => problem.path === THINKING_SECTION_NAME)) failures.push('第二遍装配时插件自己那一段被报成了漏译');
if (thinkingOnly.sections.filter((section) => section?.name === THINKING_SECTION_NAME).length !== 1) {
	failures.push('插件自己那一段在装配里出现了不止一次');
}
if (asmWithThinking([{ ...identity }]).filter((section) => section?.name === THINKING_SECTION_NAME).length !== 1) {
	failures.push('对同一份装配重复调用时又插了一段');
}

// 段落注册表里必须只有一段，且名字唯一——注册同名段落会让 DSH 的装配不变量直接判失败。
registry.length = 0;
loadPlugin(undefined);
if (registeredCount(THINKING_SECTION_NAME) !== 1) failures.push('注册表里本插件的段落不是恰好一段');

// 整份内置英文段落都不该触发「已经写过」的判定——否则这段注入会被自己翻译出来的中文关掉。
const wholePrompt = asmWithThinking(
	Object.entries(dict.sections)
		.filter(([, entry]) => typeof entry.en === 'string')
		.map(([pathName, entry]) => ({ name: pathName, text: entry.en }))
);
const wholeNotes = translateAssembly({ sections: wholePrompt, contexts: [], tools: [] }, DEFAULTS, dict);
if (!keepThinkingSection(wholePrompt)) failures.push('内置英文段落被「已写过同类要求」的判定误伤，中文思考要求会消失');
// 真实顺序：扫描发生在翻译之前，所以译文里的「思考」「中文」不参与判定。
if (wholeNotes.keepThinking !== true) failures.push('翻译后的中文译文把自己的注入判成了「别人写过」');

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
	`中文思考要求：默认${thinking.name === THINKING_SECTION_NAME ? `注册 ${THINKING_SECTION_NAME}（order ${thinking.order}，排在 persona 后缀之后）` : '未注册（错）'}` +
		`，thinkInChinese: false ${offWithSwitch ? '仍注册（错）' : '不注册'}` +
		`，sections: false ${offWithSections ? '仍注册（错）' : '不注册'}` +
		`，用户已写过同类要求 ${failedOwn ? '仍显示（错）' : '不显示'}。`
);
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
