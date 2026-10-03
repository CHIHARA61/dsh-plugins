/**
 * 纯 JS 的 PDF 文本抽取入口：不依赖任何第三方库，也不需要外部进程。
 *
 *   const result = extractPdf(buffer, { pages: '1-5' })
 *   // → { totalPages, pages: [{ number, lines, chars, undecodable }], warnings, meta }
 *
 * 覆盖范围与取舍见同目录 README。抽不到文字时（扫描件、纯图 PDF）返回空行并给出
 * 明确警告，绝不假装成功。
 */

import { PdfDocument, dictGet, isName, deref } from './objects.js';
import { extractRuns, assembleText, pageContentBytes } from './content.js';

const MAX_PAGE_TREE_DEPTH = 64;

/** 把 "1-5,8" 这类页范围解析成 1 起的页码数组；非法输入抛中文 Error。 */
export function parsePageRange(spec, totalPages) {
	if (spec === undefined || spec === null || spec === '') return Array.from({ length: totalPages }, (_, index) => index + 1);
	const pages = [];
	for (const part of String(spec).split(',')) {
		const trimmed = part.trim();
		if (trimmed === '') continue;
		const range = /^(\d+)\s*-\s*(\d+)$/u.exec(trimmed);
		if (range !== null) {
			const start = Number.parseInt(range[1], 10);
			const end = Number.parseInt(range[2], 10);
			if (start < 1 || end < start) throw new Error(`页范围 "${trimmed}" 不合法`);
			for (let page = start; page <= end; page += 1) pages.push(page);
			continue;
		}
		if (!/^\d+$/u.test(trimmed)) throw new Error(`页范围 "${trimmed}" 不合法（形如 3、10-20、2,5-7）`);
		pages.push(Number.parseInt(trimmed, 10));
	}
	const unique = [...new Set(pages)].filter((page) => page >= 1 && page <= totalPages).sort((a, b) => a - b);
	if (unique.length === 0) throw new Error(`页范围超出了文档的 ${totalPages} 页`);
	return unique;
}

/** 收集页面字典（按文档顺序），并把可继承属性（Resources/MediaBox/Rotate）压平。 */
function collectPages(doc) {
	const catalog = doc.catalog();
	const root = deref(doc, dictGet(catalog, 'Pages'));
	const pages = [];
	const visited = new Set();
	const walk = (node, inherited, depth) => {
		if (depth > MAX_PAGE_TREE_DEPTH || !node || typeof node !== 'object') return;
		const key = node;
		if (visited.has(key)) return;
		visited.add(key);
		const resources = deref(doc, dictGet(node, 'Resources')) ?? inherited.resources;
		const mediaBox = deref(doc, dictGet(node, 'MediaBox')) ?? inherited.mediaBox;
		const rotate = deref(doc, dictGet(node, 'Rotate')) ?? inherited.rotate;
		const nextInherited = { resources, mediaBox, rotate };
		const type = dictGet(node, 'Type');
		const typeName = isName(type) ? type.name : undefined;
		const kids = deref(doc, dictGet(node, 'Kids'));
		if (Array.isArray(kids) && typeName !== 'Page') {
			for (const kid of kids) walk(deref(doc, kid), nextInherited, depth + 1);
			return;
		}
		pages.push({ dict: node, resources, mediaBox, rotate });
	};
	walk(root, { resources: undefined, mediaBox: undefined, rotate: undefined }, 0);
	if (pages.length === 0 && root && typeof root === 'object' && !Array.isArray(deref(doc, dictGet(root, 'Kids')))) {
		// 没有 /Pages 树：退化为「整份文档只有一页」
		pages.push({ dict: root, resources: deref(doc, dictGet(root, 'Resources')), mediaBox: deref(doc, dictGet(root, 'MediaBox')), rotate: 0 });
	}
	return pages;
}

/**
 * 只统计页数等基本信息，不做内容流解析（用于先看文档规模再决定读哪几页）。
 * @returns {{ totalPages: number, reconstructed: boolean }}
 */
export function probePdf(buffer) {
	const doc = new PdfDocument(buffer).load();
	if (doc.encrypted) {
		const error = new Error('这份 PDF 是加密的，当前实现不支持解密（不猜密码）');
		error.code = 'PDF_ENCRYPTED';
		throw error;
	}
	return { totalPages: collectPages(doc).length, reconstructed: doc.reconstructed };
}

/**
 * 抽取 PDF 文本。
 * @param buffer 文件字节
 * @param options `{ pages, includeInvisible, maxPages, maxRuns }`
 */
export function extractPdf(buffer, options = {}) {
	const doc = new PdfDocument(buffer).load();
	if (doc.encrypted) {
		const error = new Error('这份 PDF 是加密的，当前实现不支持解密（不猜密码）');
		error.code = 'PDF_ENCRYPTED';
		throw error;
	}
	const pages = collectPages(doc);
	const totalPages = pages.length;
	if (totalPages === 0) {
		const error = new Error('这份 PDF 里没有找到任何页面（页树可能损坏）');
		error.code = 'PDF_NO_PAGES';
		throw error;
	}
	const selected = parsePageRange(options.pages, totalPages);
	const maxPages = options.maxPages ?? 200;
	if (selected.length > maxPages) {
		const error = new Error(`一次最多抽取 ${maxPages} 页，请求了 ${selected.length} 页；请用 pages 缩小范围`);
		error.code = 'PDF_TOO_MANY_PAGES';
		throw error;
	}

	const warnings = [];
	if (doc.reconstructed) warnings.push('交叉引用表不可用，已用全文扫描定位对象');
	if (doc.warnings.length > 0) warnings.push(...doc.warnings.slice(0, 3));

	const result = [];
	let totalUndecodable = 0;
	for (const pageNumber of selected) {
		const page = pages[pageNumber - 1];
		const contentBytes = pageContentBytes(doc, dictGet(page.dict, 'Contents'));
		let runs = [];
		let undecodable = 0;
		let truncated = false;
		if (contentBytes.length > 0 && page.resources !== undefined) {
			try {
				const extracted = extractRuns(doc, contentBytes, page.resources, {
					includeInvisible: options.includeInvisible,
					maxRuns: options.maxRuns
				});
				runs = extracted.runs;
				undecodable = extracted.undecodable;
				truncated = extracted.truncated;
			} catch (error) {
				warnings.push(`第 ${pageNumber} 页内容流解析失败：${error.message}`);
			}
		} else if (page.resources === undefined) {
			warnings.push(`第 ${pageNumber} 页没有 /Resources，跳过`);
		}
		const lines = assembleText(runs, options);
		const chars = lines.reduce((sum, line) => sum + line.replace(/\s/gu, '').length, 0);
		totalUndecodable += undecodable;
		result.push({ number: pageNumber, lines, chars, undecodable, truncated });
	}

	if (totalUndecodable > 0) {
		warnings.push(`有 ${totalUndecodable} 个字形无法解码（字体缺少 ToUnicode/编码表），这些位置输出为 U+FFFD`);
	}
	const emptyPages = result.filter((page) => page.chars === 0).map((page) => page.number);
	if (emptyPages.length === result.length && result.length > 0) {
		warnings.push('所有选中页面都没有文字层：这多半是扫描件或纯图 PDF，需要 OCR 或文字版');
	} else if (emptyPages.length > 0) {
		warnings.push(`这些页面没有文字层（可能是图片页）：第 ${emptyPages.slice(0, 10).join('、')}${emptyPages.length > 10 ? ' 等' : ''} 页`);
	}

	return {
		totalPages,
		pages: result,
		warnings,
		meta: {
			reconstructed: doc.reconstructed,
			undecodable: totalUndecodable,
			requestedPages: selected.length
		}
	};
}
