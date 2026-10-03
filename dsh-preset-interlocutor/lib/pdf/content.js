/**
 * PDF 内容流解释：把一页的内容流跑成一个「带坐标的文字块」序列，再拼成文本。
 *
 * 这里不做渲染，只跟踪文本状态机需要的部分：CTM（cm/q/Q）、文本矩阵（Tm/Td/TD/T*）、
 * 字符/词间距（Tc/Tw）、水平缩放（Tz）、字号（Tf）、可见性（Tr）。每个码值都带位置
 * 发射成一个 run，再按「内容流顺序 + 位置判断换行与空格」拼回文本。
 *
 * 为什么跟随内容流顺序（而不是按坐标重排）：LaTeX/Word 排多栏时内容流本身就是按栏写入的，
 * 跟随它更接近作者与读者的顺序；按坐标重排反而会在标题、脚注、图表穿插时打乱。代价是
 * 内容流顺序被打乱的文件（少数生成器）可能读起来跳跃，右起横排与竖排文字也会退化。
 */

import { Parser, dictGet, isDict, isName, isStream, deref } from './objects.js';
import { buildFontMap } from './fonts.js';

const IDENTITY = [1, 0, 0, 1, 0, 0];

function multiply(m, n) {
	// 先应用 n，再应用 m
	return [
		m[0] * n[0] + m[2] * n[1],
		m[1] * n[0] + m[3] * n[1],
		m[0] * n[2] + m[2] * n[3],
		m[1] * n[2] + m[3] * n[3],
		m[0] * n[4] + m[2] * n[5] + m[4],
		m[1] * n[4] + m[3] * n[5] + m[5]
	];
}

function applyPoint(m, x, y) {
	return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

function matrixScale(m) {
	return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
}

function translate(tx, ty) {
	return [1, 0, 0, 1, tx, ty];
}

function toNumberList(values, count) {
	if (values.length < count) return undefined;
	const out = [];
	for (let i = values.length - count; i < values.length; i += 1) {
		const value = values[i];
		if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
		out.push(value);
	}
	return out;
}

function isString(value) {
	return typeof value === 'object' && value !== null && Buffer.isBuffer(value.bytes);
}

/** 跳过内联图像（BI … ID <数据> EI），返回 EI 之后的位置。 */
function skipInlineImage(bytes, start) {
	const text = bytes.toString('latin1');
	const idMatch = /\bID[\s]/u.exec(text.slice(start));
	if (idMatch === null) return bytes.length;
	const dataStart = start + idMatch.index + idMatch[0].length;
	const eiMatch = /\sEI(?=[\s\]/>)]|$)/u.exec(text.slice(dataStart));
	if (eiMatch === null) return bytes.length;
	return dataStart + eiMatch.index + eiMatch[0].length;
}

/**
 * 解释一个内容流，返回文字块序列。
 * @returns {{ runs: Array<object>, undecodable: number, truncated: boolean }}
 */
export function extractRuns(doc, contentBytes, resources, options = {}) {
	const state = {
		runs: [],
		undecodable: 0,
		truncated: false,
		depth: 0,
		maxRuns: options.maxRuns ?? 400000,
		includeInvisible: options.includeInvisible !== false
	};
	interpret(state, doc, contentBytes, resources, buildFontMap(doc, resources), IDENTITY);
	return { runs: state.runs, undecodable: state.undecodable, truncated: state.truncated };
}

function interpret(state, doc, bytes, resources, fontMap, ctm) {
	const machine = {
		ctm,
		graphicsStack: [],
		tm: IDENTITY,
		tlm: IDENTITY,
		font: undefined,
		fontSize: 0,
		charSpacing: 0,
		wordSpacing: 0,
		hScale: 1,
		leading: 0,
		renderMode: 0
	};
	const parser = new Parser(bytes, 0);
	const operands = [];
	while (parser.pos < bytes.length) {
		const before = parser.pos;
		let value;
		try {
			value = parser.parseObject();
		} catch {
			break;
		}
		if (parser.pos === before) {
			parser.pos += 1;
			continue;
		}
		if (value === undefined) break;
		if (typeof value === 'object' && value !== null && typeof value.keyword === 'string') {
			if (value.keyword === 'BI') {
				parser.skipWhitespace();
				parser.pos = skipInlineImage(bytes, parser.pos);
				operands.length = 0;
				continue;
			}
			execute(state, doc, machine, fontMap, resources, value.keyword, operands);
			operands.length = 0;
			continue;
		}
		operands.push(value);
		if (operands.length > 64) operands.shift();
	}
}

function execute(state, doc, machine, fontMap, resources, operator, operands) {
	switch (operator) {
		case 'q': machine.graphicsStack.push([...machine.ctm]); break;
		case 'Q': if (machine.graphicsStack.length > 0) machine.ctm = machine.graphicsStack.pop(); break;
		case 'cm': {
			const m = toNumberList(operands, 6);
			if (m !== undefined) machine.ctm = multiply(m, machine.ctm);
			break;
		}
		case 'BT': machine.tm = IDENTITY; machine.tlm = IDENTITY; break;
		case 'Tf': {
			const size = operands[operands.length - 1];
			const nameValue = operands[operands.length - 2];
			if (isName(nameValue)) machine.font = fontMap.get(nameValue.name);
			if (typeof size === 'number') machine.fontSize = size;
			break;
		}
		case 'Td': {
			const t = toNumberList(operands, 2);
			if (t !== undefined) {
				machine.tlm = multiply(translate(t[0], t[1]), machine.tlm);
				machine.tm = machine.tlm;
			}
			break;
		}
		case 'TD': {
			const t = toNumberList(operands, 2);
			if (t !== undefined) {
				machine.leading = -t[1];
				machine.tlm = multiply(translate(t[0], t[1]), machine.tlm);
				machine.tm = machine.tlm;
			}
			break;
		}
		case 'Tm': {
			const m = toNumberList(operands, 6);
			if (m !== undefined) {
				machine.tm = m;
				machine.tlm = m;
			}
			break;
		}
		case 'T*':
			machine.tlm = multiply(translate(0, -machine.leading), machine.tlm);
			machine.tm = machine.tlm;
			break;
		case 'TL': {
			const value = operands[operands.length - 1];
			if (typeof value === 'number') machine.leading = value;
			break;
		}
		case 'Tc': {
			const value = operands[operands.length - 1];
			if (typeof value === 'number') machine.charSpacing = value;
			break;
		}
		case 'Tw': {
			const value = operands[operands.length - 1];
			if (typeof value === 'number') machine.wordSpacing = value;
			break;
		}
		case 'Tz': {
			const value = operands[operands.length - 1];
			if (typeof value === 'number') machine.hScale = value / 100;
			break;
		}
		case 'Tr': {
			const value = operands[operands.length - 1];
			if (typeof value === 'number') machine.renderMode = value;
			break;
		}
		case 'Tj': {
			const value = operands[operands.length - 1];
			if (isString(value)) showText(state, machine, value.bytes);
			break;
		}
		case "'": {
			machine.tlm = multiply(translate(0, -machine.leading), machine.tlm);
			machine.tm = machine.tlm;
			const value = operands[operands.length - 1];
			if (isString(value)) showText(state, machine, value.bytes);
			break;
		}
		case '"': {
			const value = operands[operands.length - 1];
			const wordSpacing = operands[operands.length - 3];
			const charSpacing = operands[operands.length - 2];
			if (typeof wordSpacing === 'number') machine.wordSpacing = wordSpacing;
			if (typeof charSpacing === 'number') machine.charSpacing = charSpacing;
			machine.tlm = multiply(translate(0, -machine.leading), machine.tlm);
			machine.tm = machine.tlm;
			if (isString(value)) showText(state, machine, value.bytes);
			break;
		}
		case 'TJ': {
			const array = operands[operands.length - 1];
			if (!Array.isArray(array)) break;
			for (const item of array) {
				if (isString(item)) showText(state, machine, item.bytes);
				else if (typeof item === 'number') {
					const shift = (-item / 1000) * machine.fontSize * machine.hScale;
					machine.tm = multiply(translate(shift, 0), machine.tm);
				}
			}
			break;
		}
		case 'Do': {
			const nameValue = operands[operands.length - 1];
			if (isName(nameValue)) drawXObject(state, doc, machine, resources, nameValue.name);
			break;
		}
		default:
			break;
	}
}

function drawXObject(state, doc, machine, resources, name) {
	if (state.depth >= 8) return;
	const xobjects = deref(doc, dictGet(resources, 'XObject'));
	if (!isDict(xobjects)) return;
	const xobject = deref(doc, xobjects.map.get(name));
	if (!isStream(xobject)) return;
	const subtype = dictGet(xobject, 'Subtype');
	if (!isName(subtype) || subtype.name !== 'Form') return;
	let bytes;
	try {
		bytes = doc.streamData(xobject);
	} catch {
		return;
	}
	const formResources = deref(doc, dictGet(xobject, 'Resources')) ?? resources;
	let matrix = IDENTITY;
	const matrixValues = deref(doc, dictGet(xobject, 'Matrix'));
	if (Array.isArray(matrixValues)) {
		const parsed = toNumberList(matrixValues, 6);
		if (parsed !== undefined) matrix = parsed;
	}
	state.depth += 1;
	interpret(state, doc, bytes, formResources, buildFontMap(doc, formResources), multiply(matrix, machine.ctm));
	state.depth -= 1;
}

function showText(state, machine, bytes) {
	const font = machine.font;
	if (font === undefined) {
		// 没见过 Tf 就显示文字：按 Latin-1 尽力而为，宽度按 0.5 em 估
		for (const byte of bytes) pushRun(state, machine, byte, String.fromCharCode(byte), 0.5);
		return;
	}
	for (const code of font.splitCodes(bytes)) {
		const unicode = font.decodeCode(code);
		pushRun(state, machine, code, unicode, font.widthOf(code) / 1000);
	}
}

function pushRun(state, machine, code, unicode, width) {
	if (state.runs.length >= state.maxRuns) {
		state.truncated = true;
		return;
	}
	const textMatrix = multiply(machine.tm, machine.ctm);
	const start = applyPoint(textMatrix, 0, 0);
	const wordSpacing = code === 32 ? machine.wordSpacing : 0;
	const advance = (width * machine.fontSize + machine.charSpacing + wordSpacing) * machine.hScale;
	machine.tm = multiply(translate(advance, 0), machine.tm);
	const end = applyPoint(multiply(machine.tm, machine.ctm), 0, 0);
	if (unicode === '\uFFFD') state.undecodable += 1;
	if (unicode === '') return;
	if (machine.renderMode === 3 && !state.includeInvisible) return;
	state.runs.push({
		text: unicode,
		x: start.x,
		y: start.y,
		endX: end.x,
		endY: end.y,
		fontSize: machine.fontSize * matrixScale(textMatrix)
	});
}

/* ── 文字块 → 文本 ─────────────────────────────────────────────────────── */

const DEFAULT_LINE_TOLERANCE = 0.45; // 相对字号：纵向偏移超过它就换行
const DEFAULT_SPACE_RATIO = 0.25; // 相对字号：横向间隙超过它就补空格（估计失败时的兜底）

/**
 * 按内容流顺序把 run 切成「行」：纵向位置变化超过阈值就换行。
 *
 * 注意这里只按顺序聚行、不重排，因为多栏排版的内容流通常就是按栏写的；但**行内**的
 * 位置顺序不可信——LibreOffice 会把一行拆成两趟画（正文一趟、字体回退的缺字再一趟，
 * 第二趟用 Tm 回到行首重新定位），所以行内必须按 x 重排。见 assembleText。
 */
function groupIntoLines(runs, lineTolerance) {
	const lines = [];
	let current = [];
	let baselineY;
	for (const run of runs) {
		if (run.text === '') continue;
		const reference = Math.max(run.fontSize, current.length > 0 ? current[0].fontSize : 0, 1);
		if (current.length > 0 && Math.abs(run.y - baselineY) > lineTolerance * reference) {
			lines.push(current);
			current = [];
		}
		if (current.length === 0) baselineY = run.y;
		current.push(run);
	}
	if (current.length > 0) lines.push(current);
	return lines;
}

/**
 * 从一页的 run 序列里估计「词间空隙」阈值。
 *
 * 词间空隙与字内空隙是双峰的（字内≈0，词间≈空格的宽度），但没有哪条固定阈值对所有
 * 文件都成立：pdfTeX 排的 Times 词间只有 0.22 em，Word 导出可能到 0.3 em，而字距调整
 * 又能把字内空隙顶到 0.15 em。所以按当前页的间隙直方图做一次 Otsu 分割，再夹到
 * [0.12, 0.32] em，比一个写死的比例稳。
 */
export function estimateSpaceThreshold(runs, lineTolerance = DEFAULT_LINE_TOLERANCE) {
	const gapSamples = [];
	for (const line of groupIntoLines(runs, lineTolerance)) {
		const sorted = [...line].sort((a, b) => a.x - b.x);
		for (let index = 1; index < sorted.length; index += 1) {
			const previous = sorted[index - 1];
			const run = sorted[index];
			const reference = Math.max(run.fontSize, previous.fontSize, 1);
			const gap = (run.x - previous.endX) / reference;
			if (gap >= 0 && gap <= 1) gapSamples.push(gap);
		}
		if (gapSamples.length >= 40000) break;
	}
	if (gapSamples.length < 300) return undefined;
	const buckets = 40;
	const max = 1;
	const histogram = new Array(buckets).fill(0);
	for (const gap of gapSamples) histogram[Math.min(buckets - 1, Math.floor((gap / max) * buckets))] += 1;
	const total = gapSamples.length;
	let sum = 0;
	for (let index = 0; index < buckets; index += 1) sum += index * histogram[index];
	let sumBelow = 0;
	let weightBelow = 0;
	let best = -1;
	let bestBucket = 0;
	for (let index = 0; index < buckets; index += 1) {
		weightBelow += histogram[index];
		if (weightBelow === 0) continue;
		const weightAbove = total - weightBelow;
		if (weightAbove === 0) break;
		sumBelow += index * histogram[index];
		const meanBelow = sumBelow / weightBelow;
		const meanAbove = (sum - sumBelow) / weightAbove;
		const between = weightBelow * weightAbove * (meanBelow - meanAbove) ** 2;
		if (between > best) {
			best = between;
			bestBucket = index;
		}
	}
	const threshold = ((bestBucket + 1) / buckets) * max;
	return Math.min(0.32, Math.max(0.12, threshold));
}

/**
 * 把一页的文字块拼成文本行。
 * @param runs extractRuns 的输出
 * @param options `{ lineTolerance, spaceRatio }`；spaceRatio 省略时按本页位置分布估计
 * @returns string[] 每一行
 */
export function assembleText(runs, options = {}) {
	const lineTolerance = options.lineTolerance ?? DEFAULT_LINE_TOLERANCE;
	const spaceRatio = options.spaceRatio ?? estimateSpaceThreshold(runs, lineTolerance) ?? DEFAULT_SPACE_RATIO;
	const lines = [];
	for (const line of groupIntoLines(runs, lineTolerance)) {
		const sorted = [...line].sort((a, b) => a.x - b.x);
		let buffer = '';
		let pendingSpace = false;
		let previous;
		for (const run of sorted) {
			if (previous !== undefined) {
				const reference = Math.max(run.fontSize, previous.fontSize, 1);
				if (run.x - previous.endX > spaceRatio * reference) pendingSpace = true;
			}
			if (/^\s+$/u.test(run.text)) {
				pendingSpace = buffer.length > 0;
			} else {
				if (pendingSpace && buffer.length > 0) buffer += ' ';
				pendingSpace = false;
				buffer += run.text;
			}
			previous = run;
		}
		lines.push(buffer.replace(/\s+$/u, ''));
	}
	return lines;
}

/** 把一页的 /Contents（可能是数组）拼成一段字节。 */
export function pageContentBytes(doc, contentValue) {
	const resolved = deref(doc, contentValue);
	const parts = [];
	const push = (value) => {
		const streamValue = deref(doc, value);
		if (!isStream(streamValue)) return;
		try {
			parts.push(doc.streamData(streamValue));
		} catch {
			// 单段内容流失败不致命
		}
	};
	if (Array.isArray(resolved)) for (const item of resolved) push(item);
	else push(resolved);
	if (parts.length === 0) return Buffer.alloc(0);
	return Buffer.concat(parts.map((part) => Buffer.concat([part, Buffer.from('\n')])));
}
