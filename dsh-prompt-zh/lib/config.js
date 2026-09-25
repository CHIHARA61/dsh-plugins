/**
 * 配置字段、缺省值与 schema 构造。
 *
 * 和 `translate.js` 一样，这里不 import 任何 `@deepseek-ai/*` 包：schemastery 由
 * 入口 `index.js` 作为参数传进来，这样离线测试既能验证字段表，也能模拟
 * 「schemastery 换了 API」时的降级路径。
 */

/**
 * 配置字段与中文含义。它是字段表的单一来源：`DEFAULTS` 必须与它同键，
 * `buildConfig` 必须为每个键建一个 schema 字段，测试会对着它核对。
 */
export const CONFIG_FIELDS = {
	sections: '翻译系统提示词段落',
	contexts: '翻译运行时上下文快照',
	tools: '翻译工具描述与参数说明',
	warnUntranslated: '出现漏译/漂移时向宿主日志警告一次',
	reportPath: '非空时把覆盖率报告写到这个绝对路径',
	verbose: '每次装配记一行统计'
};

/** 配置缺省值；即便 schema 未参与校验也按这套默认值工作。 */
export const DEFAULTS = {
	sections: true,
	contexts: true,
	tools: true,
	warnUntranslated: true,
	reportPath: '',
	verbose: false
};

/** 每个字段的 schema 类型。 */
const TYPES = {
	sections: 'boolean',
	contexts: 'boolean',
	tools: 'boolean',
	warnUntranslated: 'boolean',
	reportPath: 'string',
	verbose: 'boolean'
};

/**
 * 用给定的 schema 工厂构造 Config。
 * 单独抽出来是为了可测：测试可以喂一个记录调用的假 `z`。
 * @param schema - schemastery 命名空间（`z`）。
 * @returns `schema.object({...})` 的结果。
 */
export function buildConfig(schema) {
	const fields = {};
	for (const name of Object.keys(CONFIG_FIELDS)) {
		fields[name] = schema[TYPES[name]]().default(DEFAULTS[name]);
	}
	return schema.object(fields);
}

/**
 * 构造 Config 并把失败降级掉。
 *
 * DSH 的启动是全有全无：插件模块在导入期抛错，整个宿主就起不来。schemastery
 * 换了 API 不该有这个后果——它只该让我们丢掉「设置 → 插件 → 插件配置」那一页，
 * 而翻译照常工作（`apply` 里的 `DEFAULTS` 兜底）。失败原因交给 `onError`，
 * 由入口在首次装配时记一条警告。
 * @param build - 真正构造 schema 的零参函数。
 * @param onError - 可选；收到失败原因。
 * @returns schema，或 `undefined`（降级）。
 */
export function safeConfig(build, onError) {
	try {
		return build();
	} catch (error) {
		if (onError !== undefined) onError(error);
		return undefined;
	}
}
