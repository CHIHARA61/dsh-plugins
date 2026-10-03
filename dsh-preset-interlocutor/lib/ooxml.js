/**
 * 零依赖 OOXML 文本抽取（docx / pptx / xlsx）。
 *
 * 设计要点：
 *   - 自带一个够用的 XML 解析器（元素 / 属性 / 文本 / 实体 / CDATA / 注释 / PI / DOCTYPE），
 *     把部件解析成轻量树，再**按 OOXML 结构**逐层取文本 —— 绝不用正则剥标签。
 *   - 所有元素按「本地名」匹配（忽略 w: / a: / x: 等命名空间前缀），因为不同生产者
 *     有的用前缀、有的用默认命名空间（spreadsheetML 常见无前缀）。
 *   - 缺关键部件时抛中文 Error；缺可选部件时降级并在 notes 里说明。
 *
 * 抽取出来的 text 是「一行一条有意义的内容」：段落、表格行、幻灯片、工作表行为单位，
 * 调用方按行做窗口读取。
 */

import { openZip } from './zip.js';

/* ------------------------------------------------------------------ *
 * 轻量 XML 解析
 * ------------------------------------------------------------------ */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** 解析 XML 文本实体与数字字符引用。 */
function decodeEntities(s) {
	if (s.indexOf('&') < 0) return s;
	return s.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (match, body) => {
		if (body.charCodeAt(0) === 35 /* # */) {
			const hex = body[1] === 'x' || body[1] === 'X';
			const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
			if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
			try {
				return String.fromCodePoint(code);
			} catch {
				return match;
			}
		}
		const named = ENTITIES[body];
		return named === undefined ? match : named;
	});
}

/** 找到标签的 '>'，跳过引号内的 '>'。 */
function findTagEnd(src, from) {
	let quote = 0;
	for (let i = from; i < src.length; i++) {
		const c = src[i];
		if (quote) {
			if (c === quote) quote = 0;
			continue;
		}
		if (c === '"' || c === "'") quote = c;
		else if (c === '>') return i;
	}
	return -1;
}

/** 解析 `<name a="b"/>` 的内部部分。 */
function parseTagBody(inner) {
	let i = 0;
	const len = inner.length;
	while (i < len && !/\s/.test(inner[i])) i++;
	const name = inner.slice(0, i);
	const attrs = Object.create(null);
	while (i < len) {
		while (i < len && /\s/.test(inner[i])) i++;
		if (i >= len) break;
		const start = i;
		while (i < len && !/[\s=]/.test(inner[i])) i++;
		const attrName = inner.slice(start, i);
		while (i < len && /\s/.test(inner[i])) i++;
		if (inner[i] === '=') {
			i++;
			while (i < len && /\s/.test(inner[i])) i++;
			const quote = inner[i];
			if (quote === '"' || quote === "'") {
				const end = inner.indexOf(quote, i + 1);
				const value = end < 0 ? inner.slice(i + 1) : inner.slice(i + 1, end);
				attrs[attrName] = decodeEntities(value);
				i = end < 0 ? len : end + 1;
			}
		} else {
			attrs[attrName] = ''; // 无值属性（XML 里不常见，容错）
		}
	}
	return { name, attrs };
}

/**
 * 把 XML 文本解析成树。根节点是合成的 `#root`。
 * 节点：{ name, attrs, kids, text }，text 只装该元素的直接字符数据。
 */
function parseXml(src) {
	const root = { name: '#root', attrs: Object.create(null), kids: [], text: '' };
	const stack = [root];
	const n = src.length;
	let i = 0;

	const pushText = (s) => {
		if (s) stack[stack.length - 1].text += decodeEntities(s);
	};

	while (i < n) {
		const lt = src.indexOf('<', i);
		if (lt < 0) {
			pushText(src.slice(i));
			break;
		}
		if (lt > i) pushText(src.slice(i, lt));
		i = lt;

		if (src.startsWith('<!--', i)) {
			const end = src.indexOf('-->', i + 4);
			i = end < 0 ? n : end + 3;
			continue;
		}
		if (src.startsWith('<![CDATA[', i)) {
			const end = src.indexOf(']]>', i + 9);
			const stop = end < 0 ? n : end;
			stack[stack.length - 1].text += src.slice(i + 9, stop);
			i = end < 0 ? n : end + 3;
			continue;
		}
		if (src.startsWith('<?', i)) {
			const end = src.indexOf('?>', i + 2);
			i = end < 0 ? n : end + 2;
			continue;
		}
		if (src.startsWith('<!', i)) {
			// DOCTYPE（可能带内部子集 [...]）
			let depth = 0;
			let j = i;
			for (; j < n; j++) {
				const c = src[j];
				if (c === '[') depth++;
				else if (c === ']') depth--;
				else if (c === '>' && depth <= 0) break;
			}
			i = j < n ? j + 1 : n;
			continue;
		}
		if (src[i + 1] === '/') {
			const end = src.indexOf('>', i);
			const name = src.slice(i + 2, end < 0 ? n : end).trim();
			for (let k = stack.length - 1; k > 0; k--) {
				if (stack[k].name === name) {
					stack.length = k;
					break;
				}
			}
			i = end < 0 ? n : end + 1;
			continue;
		}

		const end = findTagEnd(src, i + 1);
		if (end < 0) {
			// 没有闭合的 '>'：剩下的当文本处理，避免死循环
			pushText(src.slice(i));
			break;
		}
		let inner = src.slice(i + 1, end);
		let selfClosing = false;
		if (inner.endsWith('/')) {
			selfClosing = true;
			inner = inner.slice(0, -1);
		}
		const { name, attrs } = parseTagBody(inner);
		const node = { name, attrs, kids: [], text: '' };
		stack[stack.length - 1].kids.push(node);
		if (!selfClosing) stack.push(node);
		i = end + 1;
	}
	return root;
}

/* ------------------------------------------------------------------ *
 * 树工具
 * ------------------------------------------------------------------ */

/** 去掉命名空间前缀，取本地名。 */
function local(name) {
	const idx = name.indexOf(':');
	return idx < 0 ? name : name.slice(idx + 1);
}

/** 按本地名取属性（属性名同样可能带前缀，如 r:id / w:val）。 */
function attr(node, name) {
	const direct = node.attrs[name];
	if (direct !== undefined) return direct;
	for (const key of Object.keys(node.attrs)) {
		if (local(key) === name) return node.attrs[key];
	}
	return undefined;
}

/** 直接子元素里本地名匹配的第一个。 */
function child(node, name) {
	for (const kid of node.kids) if (local(kid.name) === name) return kid;
	return undefined;
}

/** 直接子元素里本地名匹配的全部。 */
function children(node, name) {
	return node.kids.filter((kid) => local(kid.name) === name);
}

/** 深度优先找第一个本地名匹配的后代。 */
function descendant(node, name) {
	for (const kid of node.kids) {
		if (local(kid.name) === name) return kid;
		const found = descendant(kid, name);
		if (found) return found;
	}
	return undefined;
}

/** 递归收集所有本地名为 `name` 的后代（含自身之外的层级）。 */
function descendants(node, name, out = []) {
	for (const kid of node.kids) {
		if (local(kid.name) === name) out.push(kid);
		descendants(kid, name, out);
	}
	return out;
}

/** 拼接某元素下所有 `t` 元素的文本（用于 xlsx 共享串 / 内联串）。 */
function gatherT(node) {
	const parts = [];
	const walk = (cur) => {
		for (const kid of cur.kids) {
			const ln = local(kid.name);
			if (ln === 'rPh') continue; // 日文注音，不算正文
			if (ln === 't') {
				parts.push(kid.text);
				continue;
			}
			walk(kid);
		}
	};
	walk(node);
	return parts.join('');
}

/* ------------------------------------------------------------------ *
 * 大部件的增量扫描
 *
 * 工作表可能有几十万行、共享串表可能有几万条。为了不被 maxRowsPerSheet 之外的
 * 内容拖垮内存/耗时，这里不把整个部件建成一棵树，而是先按标签切出**单个**
 * `<row>` / `<si>` 片段，再对片段调用真正的 XML 解析器。
 * 这仍然是结构化解析（不是正则剥标签），只是把解析粒度降到元素级。
 * ------------------------------------------------------------------ */

/** 找到 `tag` 容器的内容区间 [start, end)。 */
function findContainerRange(xml, tag) {
	const openRe = new RegExp(`<([A-Za-z_][\\w.-]*:)?${tag}(?=[\\s/>])`);
	const match = openRe.exec(xml);
	if (!match) return null;
	const gt = findTagEnd(xml, match.index + 1);
	if (gt < 0) return null;
	if (xml[gt - 1] === '/') return [gt + 1, gt + 1];
	const closeRe = new RegExp(`</([A-Za-z_][\\w.-]*:)?${tag}\\s*>`);
	const close = closeRe.exec(xml.slice(gt + 1));
	return [gt + 1, close ? gt + 1 + close.index : xml.length];
}

/**
 * 惰性切出 [from, to) 内所有 `tag` 元素片段的区间（该标签不嵌套时用）。
 * 用生成器是为了让调用方 break 之后不再继续扫描后面的内容。
 * 标签允许带命名空间前缀（`<row>` 与 `<x:row>` 都能识别）。
 */
function* elementRanges(xml, tag, from, to) {
	const openRe = new RegExp(`<([A-Za-z_][\\w.-]*:)?${tag}(?=[\\s/>])`, 'g');
	const closeRe = new RegExp(`</([A-Za-z_][\\w.-]*:)?${tag}(?=[\\s>])`, 'g');
	openRe.lastIndex = from;
	let match;
	while ((match = openRe.exec(xml)) !== null) {
		const start = match.index;
		if (start >= to) return;
		const gt = findTagEnd(xml, start + 1);
		if (gt < 0 || gt >= to) return;
		if (xml[gt - 1] === '/') {
			yield [start, gt + 1];
			openRe.lastIndex = gt + 1;
			continue;
		}
		closeRe.lastIndex = gt + 1;
		const close = closeRe.exec(xml);
		let end;
		if (!close || close.index >= to) {
			end = to;
		} else {
			const cg = xml.indexOf('>', close.index);
			end = cg < 0 || cg >= to ? to : cg + 1;
		}
		yield [start, end];
		openRe.lastIndex = end;
	}
}

/** 把片段解析成单个元素（片段里找不到该元素时返回 undefined）。 */
function parseFragment(xml, tag) {
	const root = parseXml(xml);
	for (const kid of root.kids) {
		if (local(kid.name) === tag) return kid;
	}
	return undefined;
}

/** 逐行产出 sheetData 里的 `row`（惰性，调用方 break 就不会继续解析后面的行）。 */
function* sheetRows(xml) {
	const range = findContainerRange(xml, 'sheetData');
	if (!range) return;
	for (const [start, end] of elementRanges(xml, 'row', range[0], range[1])) {
		const row = parseFragment(xml.slice(start, end), 'row');
		if (row) yield row;
	}
}

/** 逐条产出共享字符串表里的 `si`。 */
function* sharedStringItems(xml) {
	for (const [start, end] of elementRanges(xml, 'si', 0, xml.length)) {
		const si = parseFragment(xml.slice(start, end), 'si');
		if (si) yield si;
	}
}

/* ------------------------------------------------------------------ *
 * 通用小工具
 * ------------------------------------------------------------------ */

/** 允许调用方直接传 Buffer，也允许传 openZip 的返回值。 */
function asZip(input) {
	if (input && typeof input.read === 'function' && typeof input.has === 'function') return input;
	return openZip(input);
}

/** 归一化部件路径（处理 ../ 与绝对路径）。 */
function resolvePart(baseDir, target) {
	let t = target;
	if (t.indexOf('%') >= 0) {
		try {
			t = decodeURIComponent(t);
		} catch {
			/* 保留原样 */
		}
	}
	const parts = (t.startsWith('/') ? [] : baseDir ? baseDir.split('/') : []).concat(t.split('/'));
	const out = [];
	for (const part of parts) {
		if (part === '' || part === '.') continue;
		if (part === '..') out.pop();
		else out.push(part);
	}
	return out.join('/');
}

/** 解析 .rels 部件：rId → { type, target }。 */
function parseRels(xml) {
	const map = new Map();
	if (!xml) return map;
	const root = parseXml(xml);
	for (const rel of descendants(root, 'Relationship')) {
		const id = attr(rel, 'Id');
		if (!id) continue;
		map.set(id, { type: attr(rel, 'Type') || '', target: attr(rel, 'Target') || '' });
	}
	return map;
}

/** 数字后缀排序辅助。 */
function byNumericSuffix(a, b) {
	return a.num - b.num;
}

/* ------------------------------------------------------------------ *
 * DOCX
 * ------------------------------------------------------------------ */

/** `w:sym` 尽力还原成字符（Symbol/Wingdings 私有区 F0xx 映射到 xx）。 */
function symbolChar(node) {
	const raw = attr(node, 'char');
	if (!raw) return '';
	const code = parseInt(raw, 16);
	if (!Number.isFinite(code)) return '';
	const mapped = code >= 0xf000 && code <= 0xf0ff ? code - 0xf000 : code;
	if (mapped < 0x20 || mapped > 0x10ffff) return '';
	try {
		return String.fromCodePoint(mapped);
	} catch {
		return '';
	}
}

/**
 * 收集一个 `w:p` 的文本。
 * 说明：段落内的 `w:br` / `w:cr` 软换行会被压成一个空格，保证「一个段落 = 一行」；
 * 制表符 `w:tab` 保留为 `\t`。
 */
function paragraphText(p) {
	const out = [];
	const walk = (node) => {
		for (const kid of node.kids) {
			const ln = local(kid.name);
			if (ln === 'pPr' || ln === 'del' || ln === 'delText' || ln === 'instrText') continue;
			if (ln === 'p' || ln === 'tbl') continue; // 嵌套段落/表格由上层结构单独处理
			if (ln === 't') out.push(kid.text);
			else if (ln === 'tab') out.push('\t');
			else if (ln === 'br' || ln === 'cr') {
				// 只有「软换行」才产出文本；分页符/分栏符只是排版，不产出内容。
				const brType = attr(kid, 'type');
				if (brType !== 'page' && brType !== 'column') out.push(' ');
			} else if (ln === 'noBreakHyphen') out.push('-');
			else if (ln === 'softHyphen') out.push('\u00ad');
			else if (ln === 'sym') out.push(symbolChar(kid));
			else if (ln === 'drawing' || ln === 'pict' || ln === 'object') continue; // 图形不产出文本
			else walk(kid);
		}
	};
	walk(p);
	return out.join('').replace(/\r\n?/g, ' ').replace(/\n/g, ' ');
}

/** 单元格文本：单元格内各段用空格连接，嵌套表格的行也拼进来。 */
function cellText(tc) {
	const parts = [];
	const walk = (node) => {
		for (const kid of node.kids) {
			const ln = local(kid.name);
			if (ln === 'p') parts.push(paragraphText(kid));
			else if (ln === 'tbl') {
				for (const tr of children(kid, 'tr')) {
					parts.push(children(tr, 'tc').map(cellText).join(' | '));
				}
			} else if (ln === 'tcPr' || ln === 'sectPr') continue;
			else walk(kid);
		}
	};
	walk(tc);
	return parts.join(' ').trim();
}

/** 按文档流顺序输出正文块（段落 / 表格）。 */
function docxBlocks(nodes, lines, meta) {
	for (const node of nodes) {
		const ln = local(node.name);
		if (ln === 'p') {
			lines.push(paragraphText(node));
			meta.paragraphs++;
		} else if (ln === 'tbl') {
			meta.tables++;
			for (const tr of children(node, 'tr')) {
				lines.push(children(tr, 'tc').map(cellText).join(' | '));
				meta.tableRows++;
			}
		} else if (ln === 'sectPr' || ln === 'bookmarkStart' || ln === 'bookmarkEnd') {
			// 无文本内容
		} else {
			docxBlocks(node.kids, lines, meta);
		}
	}
}

/** 从一个附加部件（页眉/页脚/脚注）里取出行，追加到 lines。 */
function partLines(xml, lines, label, kind) {
	const root = parseXml(xml);
	if (kind === 'note') {
		for (const note of descendants(root, 'footnote').concat(descendants(root, 'endnote'))) {
			const type = attr(note, 'type');
			if (type === 'separator' || type === 'continuationSeparator') continue;
			const id = attr(note, 'id');
			const own = [];
			docxBlocks(note.kids, own, { paragraphs: 0, tables: 0, tableRows: 0 });
			const text = own.join(' ').trim();
			if (!text) continue;
			lines.push(id === undefined ? `[${label}] ${text}` : `[${label} ${id}] ${text}`);
		}
		return;
	}
	const own = [];
	docxBlocks(root.kids, own, { paragraphs: 0, tables: 0, tableRows: 0 });
	// LibreOffice 另存为时会产出内容为空的页眉/页脚部件：跳过，免得只剩一个空标记。
	if (own.some((line) => line.trim() !== '')) {
		lines.push(`--- ${label} ---`);
		for (const line of own) lines.push(line);
	}
}

/**
 * 抽取 .docx 文本。
 * @param {object|Buffer} zip openZip 的返回值（也接受 Buffer）
 * @param {{includeHeaders?: boolean, includeFootnotes?: boolean}} [options]
 * @returns {{text: string, notes: string[], meta: object}}
 */
export function extractDocx(zip, options = {}) {
	const z = asZip(zip);
	const main = z.text('word/document.xml');
	if (main === undefined) {
		throw new Error('这不是一个有效的 .docx：缺少 word/document.xml');
	}

	const includeHeaders = options.includeHeaders === true;
	const includeFootnotes = options.includeFootnotes === true;

	const meta = {
		type: 'docx',
		paragraphs: 0,
		tables: 0,
		tableRows: 0,
		headers: 0,
		footers: 0,
		footnotes: 0,
		endnotes: 0,
		comments: 0,
		images: 0,
		deletedRuns: 0,
	};
	const lines = [];
	const notes = [];

	const root = parseXml(main);
	const body = descendant(root, 'body');
	docxBlocks(body ? body.kids : root.kids, lines, meta);

	// 统计修订删除（w:delText 的内容被忽略）——给模型一个提示。
	for (const del of descendants(root, 'delText')) {
		if (del.text) meta.deletedRuns++;
	}

	const names = z.names();
	const headers = names
		.map((name) => ({ name, m: /^word\/header(\d*)\.xml$/i.exec(name) }))
		.filter((x) => x.m)
		.map((x) => ({ name: x.name, num: x.m[1] ? parseInt(x.m[1], 10) : 0 }))
		.sort(byNumericSuffix)
		.map((x) => x.name);
	const footers = names
		.map((name) => ({ name, m: /^word\/footer(\d*)\.xml$/i.exec(name) }))
		.filter((x) => x.m)
		.map((x) => ({ name: x.name, num: x.m[1] ? parseInt(x.m[1], 10) : 0 }))
		.sort(byNumericSuffix)
		.map((x) => x.name);
	meta.headers = headers.length;
	meta.footers = footers.length;
	meta.footnotes = z.has('word/footnotes.xml') ? 1 : 0;
	meta.endnotes = z.has('word/endnotes.xml') ? 1 : 0;
	meta.comments = z.has('word/comments.xml') ? 1 : 0;
	meta.images = names.filter((name) => name.startsWith('word/media/')).length;

	if (includeHeaders && (headers.length || footers.length)) {
		lines.push('===== 页眉/页脚 =====');
		for (const name of headers.concat(footers)) {
			const xml = z.text(name);
			if (xml !== undefined) partLines(xml, lines, name, 'header');
		}
	}
	if (includeFootnotes) {
		const noteLines = [];
		for (const [name, label] of [
			['word/footnotes.xml', '脚注'],
			['word/endnotes.xml', '尾注'],
		]) {
			const xml = z.text(name);
			if (xml !== undefined) partLines(xml, noteLines, label, 'note');
		}
		if (noteLines.length) lines.push('===== 脚注/尾注 =====', ...noteLines);
	}

	if (headers.length + footers.length > 0) {
		notes.push(
			includeHeaders
				? `页眉/页脚部件共 ${headers.length + footers.length} 个（页眉 ${headers.length}、页脚 ${footers.length}），已展开在文末。`
				: `另有 ${headers.length + footers.length} 个页眉/页脚部件未展开（页眉 ${headers.length}、页脚 ${footers.length}）。`,
		);
	}
	const noteParts = meta.footnotes + meta.endnotes;
	if (noteParts > 0) {
		notes.push(
			includeFootnotes
				? `脚注/尾注部件共 ${noteParts} 个，已展开在文末。`
				: `脚注/尾注部件共 ${noteParts} 个未展开（可传 includeFootnotes=true 展开）。`,
		);
	}
	if (meta.comments > 0) notes.push('批注 1 个部件未展开：本工具只统计批注数量，不输出批注内容。');
	if (meta.images > 0) notes.push(`文档内含 ${meta.images} 个图片/媒体文件，未输出其内容。`);
	if (meta.deletedRuns > 0) notes.push(`修订删除的文本共 ${meta.deletedRuns} 处，已忽略；修订插入的文本已保留。`);

	return { text: lines.join('\n'), notes, meta };
}

/* ------------------------------------------------------------------ *
 * PPTX
 * ------------------------------------------------------------------ */

/** 取一张幻灯片/备注页里的段落文本行（每个 a:p 一行，空段落跳过）。 */
function pptxParagraphs(xml) {
	const root = parseXml(xml);
	const out = [];
	const walk = (node) => {
		for (const kid of node.kids) {
			const ln = local(kid.name);
			if (ln === 'p') {
				const parts = [];
				const collect = (cur) => {
					for (const sub of cur.kids) {
						const sl = local(sub.name);
						if (sl === 't') parts.push(sub.text);
						else if (sl === 'br') parts.push(' ');
						else if (sl === 'fld') {
							/* 域（如自动页码）：其 a:t 是占位内容，跳过 */
						} else collect(sub);
					}
				};
				collect(kid);
				const text = parts.join('').replace(/\r?\n/g, ' ').trimEnd();
				if (text.trim()) out.push(text);
			} else {
				walk(kid);
			}
		}
	};
	walk(root);
	return out;
}

/**
 * 抽取 .pptx 文本。
 * @param {object|Buffer} zip
 * @param {{includeNotes?: boolean}} [options]
 */
export function extractPptx(zip, options = {}) {
	const z = asZip(zip);
	const names = z.names();
	const slides = names
		.map((name) => ({ name, m: /^ppt\/slides\/slide(\d+)\.xml$/.exec(name) }))
		.filter((x) => x.m)
		.map((x) => ({ name: x.name, num: parseInt(x.m[1], 10) }))
		.sort(byNumericSuffix);
	if (slides.length === 0) {
		throw new Error('这不是一个有效的 .pptx：找不到 ppt/slides/slideN.xml');
	}

	const includeNotes = options.includeNotes !== false;
	const meta = {
		type: 'pptx',
		slides: slides.length,
		notesSlides: 0,
		notesExpanded: 0,
		images: names.filter((name) => name.startsWith('ppt/media/')).length,
		masters: names.filter((name) => /^ppt\/slideMasters\/slideMaster\d+\.xml$/.test(name)).length,
		layouts: names.filter((name) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(name)).length,
	};
	const lines = [];
	const notes = [];
	let notesMissing = 0;

	for (const slide of slides) {
		lines.push(`===== slide ${slide.num} =====`);
		const xml = z.text(slide.name);
		if (xml === undefined) continue;
		lines.push(...pptxParagraphs(xml));

		const relsName = `ppt/slides/_rels/slide${slide.num}.xml.rels`;
		const rels = parseRels(z.text(relsName));
		let notesPart;
		for (const rel of rels.values()) {
			if (rel.type.endsWith('/notesSlide') && rel.target) {
				notesPart = resolvePart('ppt/slides', rel.target);
				break;
			}
		}
		if (!notesPart) continue;
		meta.notesSlides++;
		if (!includeNotes) continue;
		const notesXml = z.text(notesPart);
		if (notesXml === undefined) {
			notesMissing++;
			continue;
		}
		const noteLines = pptxParagraphs(notesXml);
		if (noteLines.length === 0) continue;
		lines.push('[备注]');
		lines.push(...noteLines);
		meta.notesExpanded++;
	}

	// 页顺序自检：presentation.xml 里的 sldIdLst 顺序若与文件名编号顺序不同，说明一下。
	const presentation = z.text('ppt/presentation.xml');
	if (presentation) {
		const rels = parseRels(z.text('ppt/_rels/presentation.xml.rels'));
		const order = [];
		for (const sldId of descendants(parseXml(presentation), 'sldId')) {
			const rid = attr(sldId, 'id');
			const rel = rid ? rels.get(rid) : undefined;
			if (!rel) continue;
			const m = /(?:^|\/)slide(\d+)\.xml$/.exec(rel.target);
			if (m) order.push(parseInt(m[1], 10));
		}
		const sorted = slides.map((s) => s.num);
		if (order.length && order.join(',') !== sorted.join(',')) {
			notes.push(`幻灯片的实际放映顺序与文件名编号不同，本工具按文件名编号输出（编号顺序：${sorted.join(', ')}）。`);
		}
	}

	if (meta.notesSlides > 0 && !includeNotes) {
		notes.push(`另有 ${meta.notesSlides} 页备注未展开（可传 includeNotes=false/true 控制，默认展开）。`);
	}
	if (notesMissing > 0) notes.push(`${notesMissing} 页备注部件在包里缺失，已跳过。`);
	if (meta.images > 0) notes.push(`演示文稿内含 ${meta.images} 个图片/媒体文件，未输出其内容。`);
	if (meta.layouts > 0) notes.push(`已跳过 ${meta.layouts} 个版式（slideLayouts）与 ${meta.masters} 个母版（slideMasters）中的文字。`);

	return { text: lines.join('\n'), notes, meta };
}

/* ------------------------------------------------------------------ *
 * XLSX
 * ------------------------------------------------------------------ */

/** 把 A1 / BC12 这样的引用转成 0 基列号；解析不了返回 -1。 */
function columnIndex(ref) {
	let value = 0;
	let seen = false;
	for (let i = 0; i < ref.length; i++) {
		const c = ref.charCodeAt(i);
		if (c >= 65 && c <= 90) {
			value = value * 26 + (c - 64);
			seen = true;
		} else if (c >= 97 && c <= 122) {
			value = value * 26 + (c - 96);
			seen = true;
		} else break;
	}
	return seen ? value - 1 : -1;
}

function positiveInt(value, fallback) {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * 抽取 .xlsx 文本。
 * @param {object|Buffer} zip
 * @param {{maxRowsPerSheet?: number, maxCellChars?: number, maxSheets?: number}} [options]
 */
export function extractXlsx(zip, options = {}) {
	const z = asZip(zip);
	const workbook = z.text('xl/workbook.xml');
	if (workbook === undefined) {
		throw new Error('这不是一个有效的 .xlsx：缺少 xl/workbook.xml');
	}
	const maxRowsPerSheet = positiveInt(options.maxRowsPerSheet, 2000);
	const maxCellChars = positiveInt(options.maxCellChars, 2000);
	const maxSheets = positiveInt(options.maxSheets, 20);

	// 共享字符串表（可以不存在）
	const shared = [];
	const sst = z.text('xl/sharedStrings.xml');
	if (sst !== undefined) {
		for (const si of sharedStringItems(sst)) shared.push(gatherT(si));
	}

	// workbook.xml.rels：rId → 工作表部件路径
	const rels = parseRels(z.text('xl/_rels/workbook.xml.rels'));

	const wbRoot = parseXml(workbook);
	/** @type {Array<{name: string, part: string, hidden: boolean}>} */
	const sheets = [];
	for (const sheet of descendants(wbRoot, 'sheet')) {
		const name = attr(sheet, 'name') || `Sheet${sheets.length + 1}`;
		const rid = attr(sheet, 'id');
		let part = '';
		if (rid && rels.has(rid)) part = resolvePart('xl', rels.get(rid).target);
		if (!part) part = `xl/worksheets/sheet${sheets.length + 1}.xml`;
		const state = attr(sheet, 'state');
		sheets.push({ name, part, hidden: state === 'hidden' || state === 'veryHidden' });
	}
	if (sheets.length === 0) {
		// 没有 workbook.xml.rels 也没有 sheet 声明时，退化为直接找 worksheets 部件
		const found = z
			.names()
			.map((n) => ({ n, m: /^xl\/worksheets\/sheet(\d+)\.xml$/.exec(n) }))
			.filter((x) => x.m)
			.sort((a, b) => parseInt(a.m[1], 10) - parseInt(b.m[1], 10))
			.map((x) => x.n);
		for (const part of found) sheets.push({ name: part.split('/').pop(), part, hidden: false });
	}
	if (sheets.length === 0) {
		throw new Error('这不是一个有效的 .xlsx：xl/workbook.xml 里没有任何工作表');
	}

	const meta = {
		type: 'xlsx',
		sheets: sheets.length,
		sheetsExpanded: 0,
		rows: 0,
		cells: 0,
		sharedStrings: shared.length,
		truncatedSheets: false,
	};
	const lines = [];
	const notes = [];
	let truncatedCells = 0;
	let skippedEmptyRows = 0;
	let missingParts = 0;
	let badSharedRefs = 0;
	let sheetTruncated = 0;
	const hiddenCount = sheets.filter((s) => s.hidden).length;

	const selected = sheets.slice(0, maxSheets);
	for (const sheet of selected) {
		lines.push(`===== sheet "${sheet.name}" =====`);
		const xml = z.text(sheet.part);
		if (xml === undefined) {
			missingParts++;
			lines.push('（该工作表的部件在文件里缺失，无法展开）');
			continue;
		}
		meta.sheetsExpanded++;
		let rowsSeen = 0;
		let stopped = false;
		for (const row of sheetRows(xml)) {
			if (rowsSeen >= maxRowsPerSheet) {
				stopped = true;
				break;
			}
			rowsSeen++;
			meta.rows++;
			const cells = [];
			let col = 0;
			let hasContent = false;
			for (const c of children(row, 'c')) {
				const ref = attr(c, 'r');
				if (ref) {
					const idx = columnIndex(ref);
					if (idx >= 0) col = idx;
				}
				const type = attr(c, 't') || 'n';
				let value = '';
				if (type === 'inlineStr') {
					const is = child(c, 'is');
					if (is) value = gatherT(is);
				} else {
					const v = child(c, 'v');
					if (v) value = v.text;
				}
				if (type === 's') {
					// 共享字符串：按索引还原
					const idx = parseInt(value, 10);
					if (Number.isInteger(idx) && idx >= 0 && idx < shared.length) value = shared[idx];
					else if (value !== '') {
						badSharedRefs++;
						value = '';
					}
				} else if (type === 'b') {
					value = value === '1' || value.toLowerCase() === 'true' ? 'TRUE' : 'FALSE';
				}
				// 其余类型（n 数值 / str 公式缓存文本 / e 错误值 / d ISO 日期 / inlineStr）
				// 一律原样输出：不做日期转换、不做数字格式化。
				if (value.length > maxCellChars) {
					truncatedCells++;
					value = `${value.slice(0, maxCellChars)}…`;
				}
				if (value !== '') hasContent = true;
				while (cells.length < col) cells.push('');
				cells[col] = value;
				col++;
				meta.cells++;
			}
			if (!hasContent) {
				skippedEmptyRows++;
				continue;
			}
			lines.push(cells.join('\t'));
		}
		if (stopped) {
			sheetTruncated++;
			meta.truncatedSheets = true;
			notes.push(`工作表 "${sheet.name}" 超过 maxRowsPerSheet=${maxRowsPerSheet} 行，已截断。`);
		}
	}

	notes.unshift('日期与时间在 .xlsx 内部按数字序列号存储，本工具原样输出，不做日期格式化。');
	if (sheets.length > selected.length) {
		notes.push(`共 ${sheets.length} 张工作表，只展开了前 ${selected.length} 张（maxSheets=${maxSheets}）。`);
	}
	if (skippedEmptyRows > 0) notes.push(`跳过 ${skippedEmptyRows} 个没有任何内容的空行。`);
	if (truncatedCells > 0) notes.push(`${truncatedCells} 个单元格的文本超过 maxCellChars=${maxCellChars} 字符，已截断。`);
	if (missingParts > 0) notes.push(`${missingParts} 张工作表的部件在文件里缺失，已跳过。`);
	if (badSharedRefs > 0) notes.push(`${badSharedRefs} 处共享字符串索引越界，按空值输出。`);
	if (meta.sharedStrings > 0) notes.push(`共享字符串表共 ${meta.sharedStrings} 条，已按引用还原。`);
	if (hiddenCount > 0) notes.push(`其中 ${hiddenCount} 张工作表在 Excel 里是隐藏状态，也一并展开了。`);
	if (sheetTruncated > 0 && meta.sheetsExpanded > sheetTruncated) {
		notes.push(`另有 ${meta.sheetsExpanded - sheetTruncated} 张工作表已完整展开。`);
	}

	return { text: lines.join('\n'), notes, meta };
}
