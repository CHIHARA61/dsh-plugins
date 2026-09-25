/**
 * dsh-prompt-zh — DeepSeek Harness 中文提示词插件。
 *
 * 挂在 `system-prompt/assemble` 瀑布钩子的出口，把模型实际看到的英文文本
 * 换成中文，不改动任何 DSH 源码，卸载即还原：
 *
 *   - sections  系统提示词段落（开场白、persona 前缀/后缀、每个工具的使用指导、
 *               harness 源码位置、Web 表层说明……）
 *   - contexts  运行时上下文快照（沙箱策略、审批策略、子代理委派……）
 *   - tools     工具描述与参数说明（含嵌套 schema）
 *
 * 与「按英文原文匹配词表」的方案不同，这里按**稳定标识符**匹配：段落名
 * （`tool:read`、`harness:identity`……）、上下文名、工具名、参数路径。上游改写
 * 英文措辞不会让译文失效；只有新增段落、新增工具或新增参数才会漏译，而漏译会在
 * 覆盖率报告里被点名（`reportPath`），默认还会向宿主日志警告一次。
 *
 * 另外两条安全规则：
 *   - 原文已经含中文时默认不动（尊重用户在 agent preset 里自己写的中文 persona）；
 *   - `zh` 里可以写 `{{model}}`、`{{cwd}}` 这类提示词变量：插值发生在本钩子之后，
 *     变量照常解析。
 *
 * 词表从磁盘惰性读取并按 mtime 失效，所以**改词表不用重启宿主**，改代码才要。
 *
 * @module dsh-prompt-zh
 */
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import z from '@deepseek-ai/schemastery';
import { DEFAULTS, buildConfig, safeConfig } from './lib/config.js';
import {
	createDictLoader,
	dictFilesFor,
	problemsOf,
	renderReport,
	summarize,
	translateAssembly,
	writeReportFile
} from './lib/translate.js';

/** 插件名。 */
export const name = 'prompt-zh';
/** 依赖系统提示词注册表；它是本插件唯一的挂载点。 */
export const inject = ['systemPrompt'];

let configError;

/**
 * 插件配置 schema（dsh ≥0.1.7 由宿主据此生成「设置 → 插件 → 插件配置」页面）。
 * 构造失败时降级为 `undefined`：丢设置页，但绝不让宿主起不来。
 */
export const Config = safeConfig(
	() => buildConfig(z),
	(error) => {
		configError = error;
	}
);

const HERE = dirname(fileURLToPath(import.meta.url));
const DICT_DIR = join(HERE, 'dict');
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh');

/** 警告里最多列几个名字，其余用数量带过。 */
const WARN_SAMPLES = 6;

/** Cordis 插件入口。 */
export function apply(ctx, config) {
	const settings = { ...DEFAULTS, ...(config ?? {}) };
	const logger = ctx.logger;
	const loader = createDictLoader(dictFilesFor(DICT_DIR, { home: DSH_HOME }));
	/** 已经报过的问题（`status:path`），避免每次装配都刷同一批警告。 */
	const reported = new Set();

	if (configError !== undefined && logger !== undefined) {
		logger.warn(
			`[prompt-zh] Config schema 构造失败（设置页会缺失，翻译不受影响）：${configError instanceof Error ? configError.message : String(configError)}`
		);
	}

	ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
		const result = await next();
		try {
			const dict = loader.current(logger);
			const notes = translateAssembly(result, settings, dict);

			if (settings.warnUntranslated !== false && logger !== undefined) {
				const fresh = problemsOf(notes).filter((problem) => {
					const key = `${problem.status}:${problem.path}`;
					if (reported.has(key)) return false;
					reported.add(key);
					return true;
				});
				if (fresh.length > 0) {
					const samples = fresh.slice(0, WARN_SAMPLES).map((problem) => `${problem.path}(${problem.status})`).join('、');
					logger.warn(
						`[prompt-zh] ${fresh.length} 条文本没有中文译文，本轮按英文原文发给模型：${samples}` +
							(fresh.length > WARN_SAMPLES ? ` 等 ${fresh.length} 条` : '') +
							`。补词表见插件 README；把 reportPath 指到一个文件可拿到完整清单。`
					);
				}
			}

			if (settings.verbose && logger !== undefined) {
				const counts = summarize(notes);
				logger.info(
					`[prompt-zh] 已译 ${counts.translated ?? 0}，漏译 ${counts.missing ?? 0}，漂移 ${counts.drift ?? 0}，跳过（原文已含中文）${counts['skipped-cjk'] ?? 0}`
				);
			}
			if (typeof settings.reportPath === 'string' && settings.reportPath.length > 0) {
				writeReportFile(
					settings.reportPath,
					renderReport(notes, { dictFiles: loader.existing(), problems: loader.problems }),
					logger
				);
			}
		} catch (error) {
			if (logger !== undefined) logger.warn(`[prompt-zh] 翻译失败，本轮保持英文：${error instanceof Error ? error.message : String(error)}`);
		}
		return result;
	});
}

export default { name, inject, Config, apply };
