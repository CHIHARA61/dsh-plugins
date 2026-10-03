/**
 * PDF 底层解析：词法、对象、交叉引用表、流解码、对象仓库。
 *
 * 这个模块只依赖 Node 内置的 zlib。目标不是完整的 PDF 引擎，而是「把每一页的
 * 内容流与字体取出来」所需的最小集合：
 *
 *   - 交叉引用：经典 xref 表、xref 流、对象流（/ObjStm）、混合文件的 /XRefStm；
 *     全都失败时退化到全文扫描 `N G obj`。
 *   - 过滤器：FlateDecode（含 PNG/TIFF 预测器）、LZWDecode、ASCIIHexDecode、
 *     ASCII85Decode、RunLengthDecode。图像类过滤器（DCT/JPX/CCITT）不解。
 *   - 加密：检测到 /Encrypt 一律拒绝，不猜密码。
 *
 * 对象表示：数字是 number；名子是 { name }；字符串是 { bytes: Buffer }；
 * 数组是 Array；字典是 { map: Map }，流字典额外带 stream: Buffer；
 * 间接引用是 { ref: num, gen }。
 */

import { inflateRawSync, inflateSync } from 'node:zlib';

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);
const REGULAR_END = (byte) => WHITESPACE.has(byte) || DELIMITERS.has(byte) || byte === undefined;

/** 解析期错误：消息面向排查，不面向模型。 */
export class PdfSyntaxError extends Error {
	constructor(message) {
		super(message);
		this.name = 'PdfSyntaxError';
	}
}

function isWhitespace(byte) {
	return byte !== undefined && WHITESPACE.has(byte);
}

/** 名字、字典、引用等对象的小工具。 */
export function isName(value) {
	return typeof value === 'object' && value !== null && typeof value.name === 'string';
}

export function isDict(value) {
	return typeof value === 'object' && value !== null && value.map instanceof Map;
}

export function isRef(value) {
	return typeof value === 'object' && value !== null && typeof value.ref === 'number';
}

export function isStream(value) {
	return isDict(value) && Buffer.isBuffer(value.stream);
}

/** 取字典键（键名不带前导斜杠）。 */
export function dictGet(dict, key) {
	if (!isDict(dict)) return undefined;
	return dict.map.get(key);
}

/** 拆掉一层间接引用；`doc` 为 undefined 时原样返回引用。 */
export function deref(doc, value) {
	if (isRef(value)) return doc === undefined ? value : doc.getObject(value.ref, value.gen);
	return value;
}

function asNumber(value) {
	if (typeof value === 'number') return value;
	if (isRef(value)) return undefined;
	return undefined;
}

/** 解析期可读的字段读取（数字字段）。 */
export function numberField(value) {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/* ── 词法与对象解析 ─────────────────────────────────────────────────────── */

export class Parser {	constructor(buf, pos = 0) {
		this.buf = buf;
		this.pos = pos;
	}

	skipWhitespace() {
		for (;;) {
			const byte = this.buf[this.pos];
			if (isWhitespace(byte)) {
				this.pos += 1;
				continue;
			}
			if (byte === 0x25) {
				// 注释：到行尾为止
				while (this.pos < this.buf.length && this.buf[this.pos] !== 0x0a && this.buf[this.pos] !== 0x0d) this.pos += 1;
				continue;
			}
			return;
		}
	}

	/** 读取一个「单词」：正则字符序列（名字体、数字、关键字）。会先跳过空白与注释。 */
	readWord() {
		this.skipWhitespace();
		const start = this.pos;
		while (this.pos < this.buf.length && !REGULAR_END(this.buf[this.pos])) this.pos += 1;
		return this.buf.toString('latin1', start, this.pos);
	}

	parseName() {
		this.pos += 1; // '/'
		const start = this.pos;
		while (this.pos < this.buf.length && !REGULAR_END(this.buf[this.pos])) this.pos += 1;
		const raw = this.buf.toString('latin1', start, this.pos);
		// #XX 转义
		const name = raw.replace(/#([0-9a-fA-F]{2})/gu, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
		return { name };
	}

	parseLiteralString() {
		this.pos += 1; // '('
		const out = [];
		let depth = 1;
		while (this.pos < this.buf.length) {
			const byte = this.buf[this.pos];
			if (byte === 0x5c) {
				this.pos += 1;
				const esc = this.buf[this.pos];
				switch (esc) {
					case 0x6e: out.push(0x0a); this.pos += 1; break;
					case 0x72: out.push(0x0d); this.pos += 1; break;
					case 0x74: out.push(0x09); this.pos += 1; break;
					case 0x62: out.push(0x08); this.pos += 1; break;
					case 0x66: out.push(0x0c); this.pos += 1; break;
					case 0x28: out.push(0x28); this.pos += 1; break;
					case 0x29: out.push(0x29); this.pos += 1; break;
					case 0x5c: out.push(0x5c); this.pos += 1; break;
					case 0x0a: this.pos += 1; break;
					case 0x0d: this.pos += 1; if (this.buf[this.pos] === 0x0a) this.pos += 1; break;
					default: {
						if (esc >= 0x30 && esc <= 0x37) {
							let octal = '';
							while (octal.length < 3 && this.buf[this.pos] >= 0x30 && this.buf[this.pos] <= 0x37) {
								octal += String.fromCharCode(this.buf[this.pos]);
								this.pos += 1;
							}
							out.push(Number.parseInt(octal, 8) & 0xff);
						} else if (esc === undefined) {
							this.pos += 1;
						} else {
							out.push(esc);
							this.pos += 1;
						}
					}
				}
				continue;
			}
			if (byte === 0x28) depth += 1;
			if (byte === 0x29) {
				depth -= 1;
				if (depth === 0) {
					this.pos += 1;
					break;
				}
			}
			out.push(byte);
			this.pos += 1;
		}
		return { bytes: Buffer.from(out) };
	}

	parseHexString() {
		this.pos += 1; // '<'
		const start = this.pos;
		while (this.pos < this.buf.length && this.buf[this.pos] !== 0x3e) this.pos += 1;
		let hex = this.buf.toString('latin1', start, this.pos).replace(/[^0-9a-fA-F]/gu, '');
		if (this.pos < this.buf.length) this.pos += 1; // '>'
		if (hex.length % 2 === 1) hex += '0';
		return { bytes: Buffer.from(hex, 'hex') };
	}

	/** 解析一个对象；`allowRef` 决定 `N G R` 是否合成引用。 */
	parseObject(depth = 0) {
		if (depth > 64) throw new PdfSyntaxError('对象嵌套过深');
		this.skipWhitespace();
		const byte = this.buf[this.pos];
		if (byte === undefined) return undefined;
		if (byte === 0x2f) return this.parseName();
		if (byte === 0x28) return this.parseLiteralString();
		if (byte === 0x3c) {
			if (this.buf[this.pos + 1] === 0x3c) return this.parseDict(depth);
			return this.parseHexString();
		}
		if (byte === 0x5b) {
			this.pos += 1;
			const items = [];
			for (;;) {
				this.skipWhitespace();
				if (this.buf[this.pos] === 0x5d) {
					this.pos += 1;
					return items;
				}
				if (this.buf[this.pos] === undefined) return items;
				const before = this.pos;
				const value = this.parseObject(depth + 1);
				if (this.pos === before) {
					this.pos += 1; // 无法推进时强制前进，避免死循环
					continue;
				}
				items.push(value);
			}
		}
		// 数字 / 关键字 / 引用
		const word = this.readWord();
		if (word === '') {
			this.pos += 1;
			return undefined;
		}
		if (word === 'true') return true;
		if (word === 'false') return false;
		if (word === 'null') return null;
		const numeric = Number(word);
		if (Number.isFinite(numeric) && /^[+-]?[.\d]+$/u.test(word)) {
			// 可能是 `N G R` 引用的第一部分
			const save = this.pos;
			this.skipWhitespace();
			const second = this.peekWord();
			if (second !== undefined && /^\d+$/u.test(second)) {
				const afterSecond = this.posAfterWord();
				const probe = new Parser(this.buf, afterSecond);
				probe.skipWhitespace();
				const third = probe.peekWord();
				if (third === 'R') {
					this.pos = probe.posAfterWord();
					return { ref: numeric, gen: Number.parseInt(second, 10) };
				}
			}
			this.pos = save;
			return numeric;
		}
		return { keyword: word };
	}

	peekWord() {
		const save = this.pos;
		const word = this.readWord();
		this.pos = save;
		return word === '' ? undefined : word;
	}

	/** 前进到当前单词之后（调用前必须已跳过空白；不移位时返回当前位置）。 */
	posAfterWord() {
		this.readWord();
		return this.pos;
	}

	parseDict(depth = 0) {
		this.pos += 2; // '<<'
		const map = new Map();
		for (;;) {
			this.skipWhitespace();
			if (this.buf[this.pos] === 0x3e && this.buf[this.pos + 1] === 0x3e) {
				this.pos += 2;
				return { map };
			}
			if (this.buf[this.pos] === undefined) return { map };
			if (this.buf[this.pos] !== 0x2f) {
				// 字典里出现非名字键：跳过这个值，保持解析前进
				const before = this.pos;
				this.parseObject(depth + 1);
				if (this.pos === before) this.pos += 1;
				continue;
			}
			const key = this.parseName().name;
			const value = this.parseObject(depth + 1);
			map.set(key, value);
		}
	}

	/** 解析 `N G obj … endobj`，返回 { num, gen, value }。 */
	parseIndirectObject() {
		this.skipWhitespace();
		const header = new Parser(this.buf, this.pos);
		const num = header.readWord();
		const gen = header.readWord();
		const keyword = header.readWord();
		if (!/^\d+$/u.test(num) || !/^\d+$/u.test(gen) || keyword !== 'obj') {
			throw new PdfSyntaxError(`在偏移 ${this.pos} 处不是间接对象`);
		}
		this.pos = header.pos;
		const value = this.parseObject();
		const result = { num: Number.parseInt(num, 10), gen: Number.parseInt(gen, 10), value };
		// 流对象
		const save = this.pos;
		this.skipWhitespace();
		if (this.peekWord() === 'stream') {
			this.posAfterWord();
			// stream 关键字后必须是 CRLF 或 LF
			if (this.buf[this.pos] === 0x0d) this.pos += 1;
			if (this.buf[this.pos] === 0x0a) this.pos += 1;
			const dataStart = this.pos;
			let end = -1;
			const declared = numberField(isDict(value) ? value.map.get('Length') : undefined);
			if (declared !== undefined && declared >= 0 && dataStart + declared <= this.buf.length) {
				const probe = new Parser(this.buf, dataStart + declared);
				probe.skipWhitespace();
				if (probe.peekWord() === 'endstream') end = dataStart + declared;
			}
			if (end === -1) {
				// /Length 不可信（或被间接引用）：退化为搜索 endstream
				const idx = this.buf.indexOf('endstream', dataStart);
				if (idx === -1) void save;
				end = idx === -1 ? this.buf.length : idx;
				// 去掉 endstream 前的换行
				while (end > dataStart && (this.buf[end - 1] === 0x0a || this.buf[end - 1] === 0x0d)) end -= 1;
			}
			if (isDict(value)) value.stream = this.buf.subarray(dataStart, end);
			this.pos = Math.max(end, dataStart);
		} else {
			this.pos = save;
		}
		return result;
	}
}

/** 解析独立的 PDF 对象字面量（用于内容流里的值）。 */
export function parseObjectLiteral(text) {
	return new Parser(Buffer.from(text, 'latin1')).parseObject();
}

/* ── 过滤器 ─────────────────────────────────────────────────────────────── */

function pngPredictor(data, { colors = 1, bitsPerComponent = 8, columns = 1 }) {
	const bytesPerPixel = Math.max(1, Math.ceil((colors * bitsPerComponent) / 8));
	const rowLength = Math.max(1, Math.ceil((colors * bitsPerComponent * columns) / 8));
	const rows = Math.floor(data.length / (rowLength + 1));
	const out = Buffer.alloc(rows * rowLength);
	let prev = Buffer.alloc(rowLength);
	for (let r = 0; r < rows; r += 1) {
		const filter = data[r * (rowLength + 1)];
		const row = data.subarray(r * (rowLength + 1) + 1, (r + 1) * (rowLength + 1));
		const current = Buffer.from(row);
		for (let i = 0; i < rowLength; i += 1) {
			const left = i >= bytesPerPixel ? current[i - bytesPerPixel] : 0;
			const up = prev[i];
			const upLeft = i >= bytesPerPixel ? prev[i - bytesPerPixel] : 0;
			switch (filter) {
				case 0: break;
				case 1: current[i] = (current[i] + left) & 0xff; break;
				case 2: current[i] = (current[i] + up) & 0xff; break;
				case 3: current[i] = (current[i] + ((left + up) >> 1)) & 0xff; break;
				case 4: {
					const p = left + up - upLeft;
					const pa = Math.abs(p - left);
					const pb = Math.abs(p - up);
					const pc = Math.abs(p - upLeft);
					const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
					current[i] = (current[i] + predictor) & 0xff;
					break;
				}
				default: throw new PdfSyntaxError(`未知的 PNG 预测器类型 ${filter}`);
			}
		}
		current.copy(out, r * rowLength);
		prev = current;
	}
	return out;
}

function tiffPredictor(data, { colors = 1, bitsPerComponent = 8, columns = 1 }) {
	if (bitsPerComponent !== 8) return data;
	const rowLength = colors * columns;
	const out = Buffer.from(data);
	for (let r = 0; r + rowLength <= out.length; r += rowLength) {
		for (let i = colors; i < rowLength; i += 1) {
			out[r + i] = (out[r + i] + out[r + i - colors]) & 0xff;
		}
	}
	return out;
}

function applyPredictor(data, parms) {
	const predictor = numberField(parms?.get?.('Predictor')) ?? 1;
	if (predictor <= 1) return data;
	const options = {
		colors: numberField(parms.get('Colors')) ?? 1,
		bitsPerComponent: numberField(parms.get('BitsPerComponent')) ?? 8,
		columns: numberField(parms.get('Columns')) ?? 1
	};
	if (predictor === 2) return tiffPredictor(data, options);
	return pngPredictor(data, options);
}

function asciiHexDecode(data) {
	let hex = data.toString('latin1');
	const end = hex.indexOf('>');
	if (end !== -1) hex = hex.slice(0, end);
	hex = hex.replace(/[^0-9a-fA-F]/gu, '');
	if (hex.length % 2 === 1) hex += '0';
	return Buffer.from(hex, 'hex');
}

function ascii85Decode(data) {
	const text = data.toString('latin1');
	let out = [];
	let tuple = 0;
	let count = 0;
	for (let i = 0; i < text.length; i += 1) {
		const ch = text[i];
		if (ch === '~') break;
		if (ch === 'z' && count === 0) {
			out.push(0, 0, 0, 0);
			continue;
		}
		const code = text.charCodeAt(i);
		if (code < 0x21 || code > 0x75) continue;
		tuple = tuple * 85 + (code - 33);
		count += 1;
		if (count === 5) {
			out.push((tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff);
			tuple = 0;
			count = 0;
		}
	}
	if (count > 0) {
		for (let i = count; i < 5; i += 1) tuple = tuple * 85 + 84;
		const bytes = [(tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff];
		out.push(...bytes.slice(0, count - 1));
	}
	return Buffer.from(out);
}

function runLengthDecode(data) {
	const out = [];
	let i = 0;
	while (i < data.length) {
		const length = data[i];
		i += 1;
		if (length === 128) break;
		if (length < 128) {
			const end = Math.min(i + length + 1, data.length);
			for (; i < end; i += 1) out.push(data[i]);
		} else {
			const count = 257 - length;
			const byte = data[i];
			i += 1;
			for (let k = 0; k < count; k += 1) out.push(byte);
		}
	}
	return Buffer.from(out);
}

function lzwDecode(data, earlyChange = 1) {
	const out = [];
	let dictionary = [];
	const resetDictionary = () => {
		dictionary = [];
		for (let i = 0; i < 256; i += 1) dictionary.push([i]);
		dictionary.push(null); // 256 = clear
		dictionary.push(null); // 257 = EOD
	};
	resetDictionary();
	let codeBits = 9;
	let bitBuffer = 0;
	let bitCount = 0;
	let previous = null;
	for (let i = 0; i <= data.length; i += 1) {
		bitBuffer = (bitBuffer << 8) | (i < data.length ? data[i] : 0);
		bitCount += 8;
		while (bitCount >= codeBits) {
			const code = (bitBuffer >> (bitCount - codeBits)) & ((1 << codeBits) - 1);
			bitCount -= codeBits;
			if (code === 256) {
				resetDictionary();
				codeBits = 9;
				previous = null;
				continue;
			}
			if (code === 257) return Buffer.from(out);
			let entry;
			if (code < dictionary.length && dictionary[code] !== null) entry = dictionary[code];
			else if (previous !== null) entry = [...previous, previous[0]];
			else throw new PdfSyntaxError('LZW 数据损坏');
			out.push(...entry);
			if (previous !== null) dictionary.push([...previous, entry[0]]);
			previous = entry;
			const limit = dictionary.length + earlyChange;
			if (limit >= 512 && codeBits === 9) codeBits = 10;
			else if (limit >= 1024 && codeBits === 10) codeBits = 11;
			else if (limit >= 2048 && codeBits === 11) codeBits = 12;
		}
		if (i === data.length) break;
	}
	return Buffer.from(out);
}

/**
 * 解码一个流的字节。`resolveParms` 用于把可能被间接引用的 DecodeParms 解出来。
 * @param raw 流的原始字节
 * @param filters /Filter 的值（名字或数组）
 * @param parms /DecodeParms 的值（字典或数组）
 * @returns 解码后的 Buffer；未知过滤器原样返回
 */
export function decodeStreamBytes(raw, filters, parms) {
	const filterList = filters === undefined ? [] : Array.isArray(filters) ? filters : [filters];
	const parmList = Array.isArray(parms) ? parms : [parms];
	let data = raw;
	let aborted = false;
	for (let index = 0; index < filterList.length; index += 1) {
		const filter = filterList[index];
		const name = isName(filter) ? filter.name : undefined;
		const options = isDict(parmList[index]) ? parmList[index].map : undefined;
		try {
			switch (name) {
				case undefined:
				case 'FlateDecode':
				case 'Fl':
					data = applyPredictor(inflate(data), options);
					break;
				case 'LZWDecode':
				case 'LZW':
					data = applyPredictor(lzwDecode(data, numberField(options?.get('EarlyChange')) ?? 1), options);
					break;
				case 'ASCIIHexDecode':
				case 'AHx':
					data = asciiHexDecode(data);
					break;
				case 'ASCII85Decode':
				case 'A85':
					data = ascii85Decode(data);
					break;
				case 'RunLengthDecode':
				case 'RL':
					data = runLengthDecode(data);
					break;
				case 'Crypt':
					break;
				default:
					// DCTDecode / JPXDecode / CCITTFaxDecode 等图像过滤器：不解码
					aborted = true;
					break;
			}
		} catch (error) {
			// 预测器/解码失败不致命：调用方按「流不可读」处理
			throw new PdfSyntaxError(`流解码失败（${name ?? 'FlateDecode'}）：${error.message}`);
		}
		if (aborted) return data;
	}
	return data;
}

function inflate(data) {
	try {
		return inflateSync(data);
	} catch {
		return inflateRawSync(data);
	}
}

/* ── 文档与对象仓库 ─────────────────────────────────────────────────────── */

const MAX_OBJECT_STREAM_DEPTH = 4;

export class PdfDocument {
	/**
	 * @param buffer 整个 PDF 文件的字节
	 */
	constructor(buffer) {
		this.buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
		this.entries = new Map(); // objNum → { type: 1, offset } | { type: 2, stream, index } | { type: 0 }
		this.trailer = new Map();
		this.cache = new Map(); // objNum → value
		this.objectStreams = new Map(); // objNum(ObjStm) → Map<objNum, value>
		this.encrypted = false;
		this.warnings = [];
		this.reconstructed = false;
	}

	/** 解析交叉引用；失败时退化到全文扫描。 */
	load() {
		let ok = false;
		try {
			ok = this.loadFromXref();
		} catch (error) {
			this.warnings.push(`交叉引用解析失败（${error.message}），改用全文扫描`);
			ok = false;
		}
		if (!ok || this.entries.size === 0) this.reconstruct();
		const encrypt = dictGet(this.trailerDict(), 'Encrypt');
		if (encrypt !== undefined) this.encrypted = true;
		return this;
	}

	trailerDict() {
		return { map: this.trailer };
	}

	loadFromXref() {
		const startIndex = this.buf.lastIndexOf('startxref');
		if (startIndex === -1) return false;
		const match = /startxref\s+(\d+)/u.exec(this.buf.toString('latin1', startIndex, startIndex + 64));
		if (match === null) return false;
		const visited = new Set();
		let offset = Number.parseInt(match[1], 10);
		let first = true;
		while (offset !== undefined && offset >= 0 && offset < this.buf.length && !visited.has(offset)) {
			visited.add(offset);
			let next = this.readXrefSection(offset, first);
			first = false;
			if (next === undefined) break;
			offset = next;
		}
		return this.entries.size > 0;
	}

	/** 读取一个 xref 区段；返回 /Prev 偏移（如果有）。 */
	readXrefSection(offset, mergeTrailer) {
		const parser = new Parser(this.buf, offset);
		parser.skipWhitespace();
		const word = parser.peekWord();
		if (word === 'xref') {
			parser.posAfterWord();
			this.readXrefTable(parser);
			parser.skipWhitespace();
			if (parser.peekWord() === 'trailer') {
				parser.posAfterWord();
				const trailer = parser.parseObject();
				if (isDict(trailer)) {
					if (mergeTrailer || this.trailer.size === 0) for (const [key, value] of trailer.map) this.trailer.set(key, value);
					const xrefStm = numberField(trailer.map.get('XRefStm'));
					if (xrefStm !== undefined && !this.entries.has(-1)) {
						try {
							this.readXrefSection(xrefStm, false);
						} catch {
							// 混合文件里 XRefStm 失败不影响主表
						}
					}
					const prev = numberField(trailer.map.get('Prev'));
					return prev;
				}
			}
			return undefined;
		}
		// xref 流
		const indirect = parser.parseIndirectObject();
		if (!isStream(indirect.value)) throw new PdfSyntaxError('xref 流不是流对象');
		const dict = indirect.value;
		this.entries.set(indirect.num, { type: 1, offset });
		const data = this.streamData(dict);
		const widths = (dictGet(dict, 'W') ?? []).map((value) => numberField(deref(this, value)) ?? 0);
		const size = numberField(dictGet(dict, 'Size')) ?? 0;
		const index = dictGet(dict, 'Index');
		const ranges = [];
		if (Array.isArray(index)) {
			for (let i = 0; i + 1 < index.length; i += 2) ranges.push([numberField(index[i]) ?? 0, numberField(index[i + 1]) ?? 0]);
		} else {
			ranges.push([0, size]);
		}
		const entrySize = widths.reduce((sum, width) => sum + width, 0);
		let cursor = 0;
		for (const [first, count] of ranges) {
			for (let i = 0; i < count; i += 1) {
				if (cursor + entrySize > data.length) break;
				const fields = [];
				for (const width of widths) {
					let value = 0;
					for (let b = 0; b < width; b += 1) value = value * 256 + data[cursor + b];
					cursor += width;
					fields.push(value);
				}
				const type = widths[0] === 0 ? 1 : fields[0];
				const num = first + i;
				if (type === 1) this.entries.set(num, { type: 1, offset: fields[1] });
				else if (type === 2) this.entries.set(num, { type: 2, stream: fields[1], index: fields[2] });
			}
		}
		for (const [key, value] of dict.map) {
			if (key === 'Length' || key === 'Filter' || key === 'DecodeParms' || key === 'W' || key === 'Index' || key === 'Type') continue;
			// 先读到的是最新区段；旧区段只补空缺
			if (mergeTrailer || !this.trailer.has(key)) this.trailer.set(key, value);
		}
		const prev = numberField(dictGet(dict, 'Prev'));
		return prev;
	}

	readXrefTable(parser) {
		for (;;) {
			parser.skipWhitespace();
			const word = parser.peekWord();
			if (word === undefined || word === 'trailer') return;
			const first = Number.parseInt(parser.readWord(), 10);
			parser.skipWhitespace();
			const count = Number.parseInt(parser.readWord(), 10);
			if (!Number.isFinite(first) || !Number.isFinite(count)) return;
			for (let i = 0; i < count; i += 1) {
				parser.skipWhitespace();
				const offsetWord = parser.readWord();
				parser.skipWhitespace();
				parser.readWord(); // generation
				parser.skipWhitespace();
				const type = parser.readWord();
				const offsetValue = Number.parseInt(offsetWord, 10);
				if (!Number.isFinite(offsetValue)) return;
				if (type === 'n' && !this.entries.has(first + i)) this.entries.set(first + i, { type: 1, offset: offsetValue });
			}
		}
	}

	/** 全文扫描 `N G obj`，用于交叉引用损坏的文件。 */
	reconstruct() {
		this.reconstructed = true;
		this.entries.clear();
		const text = this.buf.toString('latin1');
		const pattern = /(\d{1,10})\s+(\d{1,5})\s+obj\b/gu;
		let match;
		while ((match = pattern.exec(text)) !== null) {
			const num = Number.parseInt(match[1], 10);
			this.entries.set(num, { type: 1, offset: match.index });
		}
		// 顺便找 trailer 字典（多数文件只有一个）
		const trailerPattern = /trailer/gu;
		while ((match = trailerPattern.exec(text)) !== null) {
			try {
				const parser = new Parser(this.buf, match.index + 'trailer'.length);
				const dict = parser.parseObject();
				if (isDict(dict)) {
					for (const [key, value] of dict.map) if (!this.trailer.has(key)) this.trailer.set(key, value);
				}
			} catch {
				// 忽略
			}
		}
		if (this.trailer.size === 0) {
			// 没有 trailer：直接找 /Type /Catalog 的对象当根
			for (const num of [...this.entries.keys()]) {
				const value = this.getObject(num, 0);
				if (isDict(value) && isName(dictGet(value, 'Type')) && dictGet(value, 'Type').name === 'Catalog') {
					this.trailer.set('Root', { ref: num, gen: 0 });
					break;
				}
			}
		}
		this.cache.clear();
	}

	/** 取一个间接对象的值。 */
	getObject(num, gen = 0) {
		if (this.cache.has(num)) return this.cache.get(num);
		this.cache.set(num, undefined); // 防止循环引用递归
		const entry = this.entries.get(num);
		let value;
		if (entry === undefined) {
			value = undefined;
		} else if (entry.type === 1) {
			try {
				const parser = new Parser(this.buf, entry.offset);
				const parsed = parser.parseIndirectObject();
				value = parsed.value;
			} catch (error) {
				this.warnings.push(`对象 ${num} 解析失败：${error.message}`);
				value = undefined;
			}
		} else if (entry.type === 2) {
			const container = this.objectStreamObjects(entry.stream);
			value = container.get(num);
		}
		void gen;
		this.cache.set(num, value);
		return value;
	}

	/** 解析一个 /ObjStm 里的全部对象。 */
	objectStreamObjects(streamNum) {
		if (this.objectStreams.has(streamNum)) return this.objectStreams.get(streamNum);
		const result = new Map();
		this.objectStreams.set(streamNum, result);
		const container = this.getObject(streamNum, 0);
		if (!isStream(container)) return result;
		let data;
		try {
			data = this.streamData(container);
		} catch (error) {
			this.warnings.push(`对象流 ${streamNum} 解码失败：${error.message}`);
			return result;
		}
		const count = numberField(dictGet(container, 'N')) ?? 0;
		const first = numberField(dictGet(container, 'First')) ?? 0;
		const headerText = data.toString('latin1', 0, Math.min(first, data.length));
		const numbers = headerText.split(/\s+/u).filter((token) => token !== '').map((token) => Number.parseInt(token, 10));
		for (let i = 0; i < count; i += 1) {
			const objectNumber = numbers[i * 2];
			const offset = numbers[i * 2 + 1];
			if (!Number.isFinite(objectNumber) || !Number.isFinite(offset)) continue;
			const parser = new Parser(data, first + offset);
			try {
				result.set(objectNumber, parser.parseObject(MAX_OBJECT_STREAM_DEPTH));
			} catch {
				result.set(objectNumber, undefined);
			}
		}
		return result;
	}

	/** 解码一个流的字节（含 /DecodeParms 的间接引用）。 */
	streamData(dict) {
		if (!isStream(dict)) throw new PdfSyntaxError('不是流对象');
		const filters = deref(this, dictGet(dict, 'Filter'));
		const parms = deref(this, dictGet(dict, 'DecodeParms'));
		return decodeStreamBytes(dict.stream, filters, parms);
	}

	/** 沿引用递归取值。 */
	resolve(value, depth = 0) {
		if (depth > 32) return undefined;
		if (isRef(value)) return this.resolve(this.getObject(value.ref, value.gen), depth + 1);
		return value;
	}

	/** 取文档目录。 */
	catalog() {
		return this.resolve(dictGet(this.trailerDict(), 'Root'));
	}
}
