/**
 * dsh-preset-interlocutor 的「读文档」工具插件。
 *
 * 为什么存在：DSH 自带的 `read` 只读 UTF-8 文本，`web_fetch` 明确拒绝 PDF，而「思辨模式」
 * 这条 preset 刻意裁掉了 shell 与 skills —— 于是 .docx / .pdf 这类二进制文档在这个会话里
 * 没有任何读取路径（旧的 persona 让人去跑 `python bin/pdftext.py`，但那条 preset 里根本
 * 没有能执行命令的工具）。
 *
 * 这里补上的就是这一件事：**只读地把文档变成文本**。不执行命令、不写文件、不联网、
 * 不引入任何第三方依赖。抽取实现全在本包的 `lib/` 里：
 *
 *   - `lib/zip.js` + `lib/ooxml.js`：docx / pptx / xlsx（OOXML 就是 ZIP + XML）
 *   - `lib/pdf/*`：PDF（交叉引用、对象流、ToUnicode CMap、内容流状态机）
 *
 * 顺带也是「preset 插件」的最小写法示例：不 import 任何 `@deepseek-ai/*` 包，只用 Node
 * 内置模块与相对路径，因此不依赖 profile 里有没有生成模块代理。
 *
 * @module dsh-preset-interlocutor/tool-doc
 */

import { extractDocx, extractPptx, extractXlsx } from './lib/ooxml.js';
import { extractPdf, probePdf } from './lib/pdf/index.js';
import { openZip } from './lib/zip.js';

/** Cordis 插件身份（Loader 的行 id 另取）。 */
export const name = 'tool-doc';

/** 依赖的服务：工具注册表 + 沙箱化的文件系统 seam。 */
export const inject = ['tools', 'fs'];

const DEFAULTS = {
	/** 一次返回的最大行数。 */
	lineLimit: 300,
	/** 一次返回的最大字符数；默认低于 preset 里 8192 的结果修剪阈值，避免被截成两段。 */
	charBudget: 6000,
	/** 单次调用允许的最大文件字节数。 */
	maxFileBytes: 64 * 1024 * 1024,
	/** 未指定 pages 时，PDF 一次先抽多少页。 */
	pdfPageBatch: 25,
	/** 单次抽取的 PDF 页数上限。 */
	maxPdfPages: 200,
	/** 是否包含 PDF 里的不可见文字（扫描件的 OCR 文字层常常是 Tr 3）。 */
	includePdfInvisibleText: true,
	/** 是否把 docx 的页眉/页脚/脚注展开到正文之后（默认只报告数量）。 */
	docxExtras: false,
	/** 是否展开 pptx 的备注页（讲稿）。 */
	pptxNotes: true,
	/** xlsx：每个工作表最多展开多少行、最多展开多少张表。 */
	xlsxRowsPerSheet: 2000,
	xlsxMaxSheets: 20
};

const TEXT_EXTENSIONS = new Set([
	'.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.yaml', '.yml',
	'.xml', '.html', '.htm', '.log', '.ini', '.toml', '.rst', '.tex', '.srt', '.vtt', '.org'
]);

const LEGACY_OFFICE = new Map([
	['.doc', '旧版二进制 Word（.doc）'],
	['.ppt', '旧版二进制 PowerPoint（.ppt）'],
	['.xls', '旧版二进制 Excel（.xls）'],
	['.rtf', 'RTF'],
	['.odt', 'OpenDocument 文本（.odt）'],
	['.ods', 'OpenDocument 表格（.ods）'],
	['.odp', 'OpenDocument 演示（.odp）']
]);

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff']);

function normalizeConfig(raw) {
	const config = raw !== null && typeof raw === 'object' ? raw : {};
	const number = (key, fallback, min, max) => {
		const value = config[key];
		if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
		return Math.max(min, Math.min(max, Math.trunc(value)));
	};
	const flag = (key, fallback) => (typeof config[key] === 'boolean' ? config[key] : fallback);
	return {
		lineLimit: number('lineLimit', DEFAULTS.lineLimit, 1, 5000),
		charBudget: number('charBudget', DEFAULTS.charBudget, 500, 200000),
		maxFileBytes: number('maxFileBytes', DEFAULTS.maxFileBytes, 4096, 1 << 30),
		pdfPageBatch: number('pdfPageBatch', DEFAULTS.pdfPageBatch, 1, 500),
		maxPdfPages: number('maxPdfPages', DEFAULTS.maxPdfPages, 1, 2000),
		includePdfInvisibleText: flag('includePdfInvisibleText', DEFAULTS.includePdfInvisibleText),
		docxExtras: flag('docxExtras', DEFAULTS.docxExtras),
		pptxNotes: flag('pptxNotes', DEFAULTS.pptxNotes),
		xlsxRowsPerSheet: number('xlsxRowsPerSheet', DEFAULTS.xlsxRowsPerSheet, 1, 100000),
		xlsxMaxSheets: number('xlsxMaxSheets', DEFAULTS.xlsxMaxSheets, 1, 200)
	};
}

function extensionOf(path) {
	const index = path.lastIndexOf('.');
	return index <= 0 ? '' : path.slice(index).toLowerCase();
}

function splitLines(text) {
	const lines = String(text).replace(/\r\n?/gu, '\n').split('\n');
	while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
	return lines;
}

/** 按魔数（优先）与扩展名判定文档类型。 */
function detectFormat(bytes, extension) {
	const isPdf = bytes.length > 5 && bytes.toString('latin1', 0, 5) === '%PDF-';
	if (isPdf) return { kind: 'pdf' };
	const isOle = bytes.length > 8 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
	if (isOle) {
		throw new Error(
			`不是本工具支持的格式：文件是 OLE/CFB 容器，通常是${LEGACY_OFFICE.get(extension) ?? '旧版二进制 Office 文档'}或设置了密码的加密 Office 文件。`
			+ '请让用户用 Word / Excel / WPS 另存为 .docx / .xlsx / .pdf 后再读。'
		);
	}
	const isZip = bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05);
	if (isZip) {
		const zip = openZip(bytes);
		if (zip.has('word/document.xml')) return { kind: 'docx', zip };
		if (zip.has('ppt/presentation.xml')) return { kind: 'pptx', zip };
		if (zip.has('xl/workbook.xml')) return { kind: 'xlsx', zip };
		throw new Error('这是一个 ZIP 包，但里面没有 Word / PowerPoint / Excel 的部件（不是 Office 文档）');
	}
	if (LEGACY_OFFICE.has(extension)) {
		throw new Error(
			`不支持的格式：${LEGACY_OFFICE.get(extension)}。请让用户另存为 .docx / .pptx / .xlsx / .pdf 后再读。`
		);
	}
	return { kind: 'unknown' };
}

function decodeUtf8(bytes, displayPath) {
	const text = bytes.toString('utf8');
	const replacements = (text.match(/\uFFFD/gu) ?? []).length;
	if (replacements > 20 && replacements > text.length * 0.05) {
		throw new Error(`"${displayPath}" 看来不是 UTF-8 文本（大量字节无法解码）`);
	}
	return text;
}

/** 计算本次要显示的行范围：先按行数，再按字符预算截断，至少给一行。 */
function windowLines(lines, config, offsetInput, limitInput) {
	const offset = Number.isInteger(offsetInput) && offsetInput > 0 ? offsetInput : 1;
	const limit = Number.isInteger(limitInput) && limitInput > 0
		? Math.min(limitInput, config.lineLimit * 10)
		: config.lineLimit;
	if (lines.length === 0) return { shownFrom: 1, shownTo: 0, nextOffset: undefined };
	if (offset > lines.length) {
		throw new Error(`offset ${offset} 超出了文档的 ${lines.length} 行（行号从 1 开始）`);
	}
	let chars = 0;
	let shownTo = offset - 1;
	while (shownTo < lines.length && shownTo - (offset - 1) < limit) {
		const cost = lines[shownTo].length + 6; // 行号前缀的粗略开销
		if (shownTo >= offset && chars + cost > config.charBudget) break;
		chars += cost;
		shownTo += 1;
	}
	return { shownFrom: offset, shownTo, nextOffset: shownTo < lines.length ? shownTo + 1 : undefined };
}

/**
 * 渲染模型看到的文本结果：`<path>` / `<format>` / `<content>` 三段，
 * 行号 + 分窗口脚注，末尾附抽取器给出的提示。
 */
function renderResult({ path, summary, lines, notes, window, continuation }) {
	const body = [];
	for (let index = window.shownFrom; index <= window.shownTo; index += 1) {
		body.push(`${index}: ${lines[index - 1]}`);
	}
	const trailer = [`（本次显示 ${window.shownFrom}-${window.shownTo} 行，共 ${lines.length} 行）`];
	if (continuation !== undefined) trailer[0] = continuation;
	const tail = [];
	for (const note of notes ?? []) tail.push(`注：${note}`);
	return [
		`<path>${path}</path>`,
		`<format>${summary}</format>`,
		'<content>',
		...body,
		'</content>',
		...trailer,
		...tail
	].join('\n');
}

function continuationOf(window, total, kind) {
	if (window.nextOffset === undefined) return `（已到${kind}末尾，共 ${total} 行）`;
	return `（本次显示 ${window.shownFrom}-${window.shownTo} 行，共 ${total} 行；用 offset=${window.nextOffset} 继续）`;
}

function apply(ctx, rawConfig) {
	const config = normalizeConfig(rawConfig);

	ctx.tools.register({
		name: 'read_doc',
		description:
			'读取本地文档，返回带行号的纯文本：Word（.docx）、PDF、PowerPoint（.pptx）、Excel（.xlsx）以及 .txt/.md/.csv 这类纯文本。'
			+ '这是本会话里唯一能读 PDF 与 Office 文档的工具——内置的 read 只吃 UTF-8 文本、read_image 只吃图片，对这类文件反复重试没有意义。'
			+ `长文档用 offset / limit 分窗口读；PDF 可以用 pages 只读某几页（如 "3"、"10-20"、"2,5-7"）。`
			+ '扫描件（没有文字层的 PDF）读不出正文，会明确报告而不是编造内容。',
		parameters: {
			type: 'object',
			properties: {
				file_path: {
					type: 'string',
					description: '文件路径；相对路径按会话工作目录解析。'
				},
				offset: {
					type: 'integer',
					description: '从第几行开始返回（从 1 开始）。续读时用上一次结果里给出的 offset。'
				},
				limit: {
					type: 'integer',
					description: `最多返回多少行，默认 ${config.lineLimit}。`
				},
				pages: {
					type: 'string',
					description: '仅对 PDF 有效：只读这些页，例如 "3"、"10-20"、"2,5-7"。'
				}
			},
			required: ['file_path'],
			additionalProperties: false
		},
		output: {
			schema: { type: 'string' },
			render: (_args, value) => [{ type: 'text', text: value }]
		},
		isConcurrencySafe: () => true,
		presentCall: (args) => ({
			card: 'generic',
			title: `读取文档 ${args.file_path}`,
			kind: 'read'
		}),
		async execute(args, exec) {
			const requestedPath = typeof args.file_path === 'string' ? args.file_path.trim() : '';
			if (requestedPath === '') throw new Error('file_path 必须是非空字符串');

			const cwd = exec.agent?.session?.header?.cwd;
			const target = await ctx.fs.resolve(requestedPath, {
				...(cwd === undefined ? {} : { cwd }),
				signal: exec.signal
			});
			const info = await ctx.fs.stat(target, exec.signal);
			if (info === undefined) throw new Error(`读不到 "${target.displayPath}"：文件不存在（相对路径按会话工作目录解析）`);
			if (info.type !== 'file') throw new Error(`读不到 "${target.displayPath}"：不是普通文件`);
			if (typeof info.size === 'number' && info.size > config.maxFileBytes) {
				throw new Error(
					`"${target.displayPath}" 约 ${Math.round(info.size / 1024 / 1024)} MiB，超过本工具 ${Math.round(config.maxFileBytes / 1024 / 1024)} MiB 的上限`
				);
			}

			const extension = extensionOf(target.displayPath);
			const bytes = await ctx.fs.readBytes(target, exec.signal, config.maxFileBytes);
			const format = detectFormat(bytes, extension);

			if (format.kind === 'unknown') {
				if (TEXT_EXTENSIONS.has(extension) || !bytes.includes(0)) {
					const lines = splitLines(decodeUtf8(bytes, target.displayPath));
					const window = windowLines(lines, config, args.offset, args.limit);
					return renderResult({
						path: target.displayPath,
						summary: `纯文本，${lines.length} 行`,
						lines,
						notes: ['这是纯文本；内置 read 工具也能读它（输出格式相同）。'],
						window,
						continuation: continuationOf(window, lines.length, '文件')
					});
				}
				if (IMAGE_EXTENSIONS.has(extension)) {
					throw new Error(`"${target.displayPath}" 是图片：用 read_image 读它，read_doc 只处理文档`);
				}
				throw new Error(`不认识 "${extension === '' ? '无扩展名' : extension}" 这种格式；read_doc 支持 .docx / .pdf / .pptx / .xlsx 与纯文本`);
			}

			if (format.kind === 'pdf') {
				const requestedPages = typeof args.pages === 'string' && args.pages.trim() !== '' ? args.pages.trim() : undefined;
				const { totalPages } = probePdf(bytes);
				let result;
				const notes = [];
				if (requestedPages !== undefined) {
					result = extractPdf(bytes, {
						pages: requestedPages,
						maxPages: config.maxPdfPages,
						includeInvisible: config.includePdfInvisibleText
					});
				} else if (totalPages > config.pdfPageBatch) {
					const batch = Array.from({ length: config.pdfPageBatch }, (_, index) => index + 1).join(',');
					result = extractPdf(bytes, {
						pages: batch,
						maxPages: config.maxPdfPages,
						includeInvisible: config.includePdfInvisibleText
					});
					notes.push(`这份 PDF 共 ${totalPages} 页，本次只抽了前 ${config.pdfPageBatch} 页；读后面用 pages="26-50" 这类范围。`);
				} else {
					result = extractPdf(bytes, { maxPages: config.maxPdfPages, includeInvisible: config.includePdfInvisibleText });
				}
				notes.push(...result.warnings);
				if (result.pages.every((page) => page.chars === 0)) {
					notes.push('一页正文都没抽到：这多半是扫描件或纯图 PDF。本工具不渲染页面，请让对方给文字版，或用能 OCR 的环境处理。');
				}
				const lines = [];
				for (const page of result.pages) {
					lines.push(`===== page ${page.number} =====`);
					for (const line of page.lines) lines.push(line);
				}
				const window = windowLines(lines, config, args.offset, args.limit);
				const selected = result.pages.length === totalPages
					? `全部 ${totalPages} 页`
					: `第 ${result.pages[0].number}-${result.pages[result.pages.length - 1].number} 页（共 ${totalPages} 页）`;
				return renderResult({
					path: target.displayPath,
					summary: `pdf，${selected}`,
					lines,
					notes,
					window,
					continuation: continuationOf(window, lines.length, '结果')
				});
			}

			let extracted;
			if (format.kind === 'docx') {
				const result = extractDocx(format.zip, { includeHeaders: config.docxExtras, includeFootnotes: config.docxExtras });
				extracted = { lines: splitLines(result.text), notes: result.notes, summary: docxSummary(result.meta) };
			} else if (format.kind === 'pptx') {
				const result = extractPptx(format.zip, { includeNotes: config.pptxNotes });
				extracted = { lines: splitLines(result.text), notes: result.notes, summary: `${result.meta?.slides ?? '?'} 张幻灯片` };
			} else {
				const result = extractXlsx(format.zip, {
					maxRowsPerSheet: config.xlsxRowsPerSheet,
					maxSheets: config.xlsxMaxSheets
				});
				extracted = { lines: splitLines(result.text), notes: result.notes, summary: `${result.meta?.sheets ?? '?'} 张工作表` };
			}
			const window = windowLines(extracted.lines, config, args.offset, args.limit);
			const summary = [format.kind, extracted.summary, `${extracted.lines.length} 行`].filter((part) => part !== undefined).join('，');
			return renderResult({
				path: target.displayPath,
				summary,
				lines: extracted.lines,
				notes: extracted.notes,
				window,
				continuation: continuationOf(window, extracted.lines.length, '文件')
			});
		}
	});
}

function docxSummary(meta) {
	if (meta === undefined) return undefined;
	const parts = [];
	if (typeof meta.paragraphs === 'number') parts.push(`${meta.paragraphs} 段`);
	if (typeof meta.tables === 'number' && meta.tables > 0) parts.push(`${meta.tables} 个表格`);
	return parts.length > 0 ? parts.join('、') : undefined;
}

export { apply };
