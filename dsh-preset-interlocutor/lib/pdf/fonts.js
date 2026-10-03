/**
 * PDF 字体与编码：把内容流里的码值变成 Unicode，并给出字宽。
 *
 * 覆盖三类常见字体：
 *   - 简单字体（Type1/TrueType/Type3）：单字节码 → 用 /Encoding（WinAnsi /
 *     MacRoman / Standard）与 /Differences 里的字形名，再经 AGL 子集落到 Unicode；
 *     有 /ToUnicode 时优先用它。
 *   - Type0/CID 字体：多字节码。码长来自 ToUnicode CMap 的 codespacerange（Identity-H
 *     与 GBK/UniGB 这类预定义 CMap 都在其中声明），按 range 前缀匹配切码；
 *     /Encoding 形如 UniXXX-UCS2-H 时可直接按 UTF-16BE 解。
 *   - 拿不到映射时：输出 U+FFFD 并计数，由上层报告「有 N 个字形无法解码」，
 *     而不是静默产出乱码。
 *
 * 字宽用于还原词间空格与换行，单位是 1/1000 em。
 */

import { dictGet, isDict, isName, isStream, deref } from './objects.js';

/* ── 编码表 ─────────────────────────────────────────────────────────────── */

// WinAnsiEncoding（与 Windows-1252 同构）。
const WIN_ANSI = [
	0x0000, 0x0001, 0x0002, 0x0003, 0x0004, 0x0005, 0x0006, 0x0007, 0x0008, 0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x000e, 0x000f,
	0x0010, 0x0011, 0x0012, 0x0013, 0x0014, 0x0015, 0x0016, 0x0017, 0x0018, 0x0019, 0x001a, 0x001b, 0x001c, 0x001d, 0x001e, 0x001f,
	0x0020, 0x0021, 0x0022, 0x0023, 0x0024, 0x0025, 0x0026, 0x0027, 0x0028, 0x0029, 0x002a, 0x002b, 0x002c, 0x002d, 0x002e, 0x002f,
	0x0030, 0x0031, 0x0032, 0x0033, 0x0034, 0x0035, 0x0036, 0x0037, 0x0038, 0x0039, 0x003a, 0x003b, 0x003c, 0x003d, 0x003e, 0x003f,
	0x0040, 0x0041, 0x0042, 0x0043, 0x0044, 0x0045, 0x0046, 0x0047, 0x0048, 0x0049, 0x004a, 0x004b, 0x004c, 0x004d, 0x004e, 0x004f,
	0x0050, 0x0051, 0x0052, 0x0053, 0x0054, 0x0055, 0x0056, 0x0057, 0x0058, 0x0059, 0x005a, 0x005b, 0x005c, 0x005d, 0x005e, 0x005f,
	0x0060, 0x0061, 0x0062, 0x0063, 0x0064, 0x0065, 0x0066, 0x0067, 0x0068, 0x0069, 0x006a, 0x006b, 0x006c, 0x006d, 0x006e, 0x006f,
	0x0070, 0x0071, 0x0072, 0x0073, 0x0074, 0x0075, 0x0076, 0x0077, 0x0078, 0x0079, 0x007a, 0x007b, 0x007c, 0x007d, 0x007e, 0x007f,
	0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x017d, 0x008f,
	0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
	0x00a0, 0x00a1, 0x00a2, 0x00a3, 0x00a4, 0x00a5, 0x00a6, 0x00a7, 0x00a8, 0x00a9, 0x00aa, 0x00ab, 0x00ac, 0x00ad, 0x00ae, 0x00af,
	0x00b0, 0x00b1, 0x00b2, 0x00b3, 0x00b4, 0x00b5, 0x00b6, 0x00b7, 0x00b8, 0x00b9, 0x00ba, 0x00bb, 0x00bc, 0x00bd, 0x00be, 0x00bf,
	0x00c0, 0x00c1, 0x00c2, 0x00c3, 0x00c4, 0x00c5, 0x00c6, 0x00c7, 0x00c8, 0x00c9, 0x00ca, 0x00cb, 0x00cc, 0x00cd, 0x00ce, 0x00cf,
	0x00d0, 0x00d1, 0x00d2, 0x00d3, 0x00d4, 0x00d5, 0x00d6, 0x00d7, 0x00d8, 0x00d9, 0x00da, 0x00db, 0x00dc, 0x00dd, 0x00de, 0x00df,
	0x00e0, 0x00e1, 0x00e2, 0x00e3, 0x00e4, 0x00e5, 0x00e6, 0x00e7, 0x00e8, 0x00e9, 0x00ea, 0x00eb, 0x00ec, 0x00ed, 0x00ee, 0x00ef,
	0x00f0, 0x00f1, 0x00f2, 0x00f3, 0x00f4, 0x00f5, 0x00f6, 0x00f7, 0x00f8, 0x00f9, 0x00fa, 0x00fb, 0x00fc, 0x00fd, 0x00fe, 0x00ff
];

// StandardEncoding 与 Latin-1 的差异（其余按 Latin-1 处理）。
const STANDARD_DIFFS = new Map([
	[0x27, 0x2019], [0x60, 0x2018], [0xa4, 0x2044], [0xa6, 0x0192], [0xa8, 0x00a4],
	[0xaa, 0x02c6], [0xac, 0x02dc], [0xaf, 0x02c7], [0xb7, 0x02d8], [0xba, 0x02c9],
	[0xbc, 0x02da], [0xbd, 0x02dd], [0xbe, 0x02db], [0xbf, 0x02d9], [0xc0, 0x02c6],
	[0xc5, 0x02c7], [0xc6, 0x02d8], [0xc8, 0x02da], [0xca, 0x02db], [0xcb, 0x02d9],
	[0xcd, 0x02dd], [0xcf, 0x02db], [0xd0, 0x02d8], [0xd1, 0x02da], [0xd8, 0x02d9],
	[0xda, 0x02dd], [0xe0, 0x00c6], [0xe1, 0x00d0], [0xe2, 0x00aa], [0xe3, 0x0126],
	[0xe6, 0x0132], [0xe8, 0x013f], [0xe9, 0x0141], [0xea, 0x00d8], [0xeb, 0x0152],
	[0xec, 0x00ba], [0xed, 0x00de], [0xee, 0x0166], [0xf0, 0x014a], [0xf1, 0x0149],
	[0xf2, 0x0138], [0xf5, 0x0152], [0xf6, 0x00d8], [0xf8, 0x00de], [0xfb, 0x0166],
	[0xfc, 0x014a]
]);

// MacRomanEncoding 的 0x80–0xFF 段。
const MAC_ROMAN_HIGH = [
	0x00c4, 0x00c5, 0x00c7, 0x00c9, 0x00d1, 0x00d6, 0x00dc, 0x00e1, 0x00e0, 0x00e2, 0x00e4, 0x00e3, 0x00e5, 0x00e7, 0x00e9, 0x00e8,
	0x00ea, 0x00eb, 0x00ed, 0x00ec, 0x00ee, 0x00ef, 0x00f1, 0x00f3, 0x00f2, 0x00f4, 0x00f6, 0x00f5, 0x00fa, 0x00f9, 0x00fb, 0x00fc,
	0x2020, 0x00b0, 0x00a2, 0x00a3, 0x00a7, 0x2022, 0x00b6, 0x00df, 0x00ae, 0x00a9, 0x2122, 0x00b4, 0x00a8, 0x2260, 0x00c6, 0x00d8,
	0x221e, 0x00b1, 0x2264, 0x2265, 0x00a5, 0x00b5, 0x2202, 0x2211, 0x220f, 0x03c0, 0x222b, 0x00aa, 0x00ba, 0x03a9, 0x00e6, 0x00f8,
	0x00bf, 0x00a1, 0x00ac, 0x221a, 0x0192, 0x2248, 0x2206, 0x00ab, 0x00bb, 0x2026, 0x00a0, 0x00c0, 0x00c3, 0x00d5, 0x0152, 0x0153,
	0x2013, 0x2014, 0x201c, 0x201d, 0x2018, 0x2019, 0x00f7, 0x25ca, 0x00ff, 0x0178, 0x2044, 0x20ac, 0x2039, 0x203a, 0xfb01, 0xfb02,
	0x2021, 0x00b7, 0x201a, 0x201e, 0x2030, 0x00c2, 0x00ca, 0x00c1, 0x00cb, 0x00c8, 0x00cd, 0x00ce, 0x00cf, 0x00cc, 0x00d3, 0x00d4,
	0xf8ff, 0x00d2, 0x00da, 0x00db, 0x00d9, 0x0131, 0x02c6, 0x02dc, 0x00af, 0x02d8, 0x02d9, 0x02da, 0x00b8, 0x02dd, 0x02db, 0x02c7
];

// /Differences 里的字形名 → Unicode（AGL 常用子集；uniXXXX / uXXXX 另行解析）。
const GLYPH_NAMES = new Map(Object.entries({
	space: 0x0020, exclam: 0x0021, quotedbl: 0x0022, numbersign: 0x0023, dollar: 0x0024,
	percent: 0x0025, ampersand: 0x0026, quotesingle: 0x0027, quoteright: 0x2019, quoteleft: 0x2018,
	parenleft: 0x0028, parenright: 0x0029, asterisk: 0x002a, plus: 0x002b, comma: 0x002c,
	hyphen: 0x002d, period: 0x002e, slash: 0x002f, zero: 0x0030, one: 0x0031, two: 0x0032,
	three: 0x0033, four: 0x0034, five: 0x0035, six: 0x0036, seven: 0x0037, eight: 0x0038,
	nine: 0x0039, colon: 0x003a, semicolon: 0x003b, less: 0x003c, equal: 0x003d, greater: 0x003e,
	question: 0x003f, at: 0x0040, bracketleft: 0x005b, backslash: 0x005c, bracketright: 0x005d,
	asciicircum: 0x005e, underscore: 0x005f, grave: 0x0060, braceleft: 0x007b, bar: 0x007c,
	braceright: 0x007d, asciitilde: 0x007e, quotedblleft: 0x201c, quotedblright: 0x201d,
	quotedblbase: 0x201e, endash: 0x2013, emdash: 0x2014, bullet: 0x2022, dagger: 0x2020,
	daggerdbl: 0x2021, ellipsis: 0x2026, perthousand: 0x2030, guilsinglleft: 0x2039,
	guilsinglright: 0x203a, guillemotleft: 0x00ab, guillemotright: 0x00bb, florin: 0x0192,
	fraction: 0x2044, Euro: 0x20ac, euro: 0x20ac, trademark: 0x2122, degree: 0x00b0,
	plusminus: 0x00b1, multiply: 0x00d7, divide: 0x00f7, periodcentered: 0x00b7,
	onesuperior: 0x00b9, twosuperior: 0x00b2, threesuperior: 0x00b3, onehalf: 0x00bd,
	onequarter: 0x00bc, threequarters: 0x00be, section: 0x00a7, paragraph: 0x00b6,
	currency: 0x00a4, cent: 0x00a2, sterling: 0x00a3, yen: 0x00a5, brokenbar: 0x00a6,
	copyright: 0x00a9, registered: 0x00ae, ordmasculine: 0x00ba, ordfeminine: 0x00aa,
	acute: 0x00b4, dieresis: 0x00a8, cedilla: 0x00b8, macron: 0x00af, circumflex: 0x02c6,
	caron: 0x02c7, breve: 0x02d8, dotaccent: 0x02d9, ring: 0x02da, ogonek: 0x02db, tilde: 0x02dc,
	hungarumlaut: 0x02dd, ae: 0x00e6, AE: 0x00c6, oe: 0x0153, OE: 0x0152, oslash: 0x00f8,
	Oslash: 0x00d8, germandbls: 0x00df, thorn: 0x00fe, Thorn: 0x00de, eth: 0x00f0, Eth: 0x00d0,
	fi: 0xfb01, fl: 0xfb02, ff: 0xfb00, ffi: 0xfb03, ffl: 0xfb04, dotlessi: 0x0131,
	minus: 0x2212, infinity: 0x221e, notequal: 0x2260, lessequal: 0x2264, greaterequal: 0x2265,
	partialdiff: 0x2202, summation: 0x2211, product: 0x220f, pi: 0x03c0, Omega: 0x03a9,
	integral: 0x222b, radical: 0x221a, approxequal: 0x2248, Delta: 0x2206, lozenge: 0x25ca,
	angle: 0x2220, perpendicular: 0x22a5, element: 0x2208, notelement: 0x2209, arrowright: 0x2192,
	arrowleft: 0x2190, arrowup: 0x2191, arrowdown: 0x2193, arrowboth: 0x2194,
	alpha: 0x03b1, beta: 0x03b2, gamma: 0x03b3, delta: 0x03b4, epsilon: 0x03b5, zeta: 0x03b6,
	eta: 0x03b7, theta: 0x03b8, iota: 0x03b9, kappa: 0x03ba, lambda: 0x03bb, mu: 0x03bc,
	nu: 0x03bd, xi: 0x03be, omicron: 0x03bf, rho: 0x03c1, sigma: 0x03c3, tau: 0x03c4,
	upsilon: 0x03c5, phi: 0x03c6, chi: 0x03c7, psi: 0x03c8, omega: 0x03c9,
	Alpha: 0x0391, Beta: 0x0392, Gamma: 0x0393, Epsilon: 0x0395, Zeta: 0x0396,
	Eta: 0x0397, Theta: 0x0398, Iota: 0x0399, Kappa: 0x039a, Lambda: 0x039b, Mu: 0x039c,
	Nu: 0x039d, Xi: 0x039e, Omicron: 0x039f, Pi: 0x03a0, Rho: 0x03a1, Sigma: 0x03a3,
	Tau: 0x03a4, Upsilon: 0x03a5, Phi: 0x03a6, Chi: 0x03a7, Psi: 0x03a8,
	nbspace: 0x00a0, sfthyphen: 0x00ad, softhyphen: 0x00ad, middot: 0x00b7,
	Lslash: 0x0141, lslash: 0x0142, Sacute: 0x015a, sacute: 0x015b, Zdotaccent: 0x017b,
	zdotaccent: 0x017c, Zcaron: 0x017d, zcaron: 0x017e, Scaron: 0x0160, scaron: 0x0161,
	Ydieresis: 0x0178, Tcaron: 0x0164, tcaron: 0x0165, Rcaron: 0x0158, rcaron: 0x0159,
	Ntilde: 0x00d1, ntilde: 0x00f1, Aacute: 0x00c1, aacute: 0x00e1, Acircumflex: 0x00c2,
	acircumflex: 0x00e2, Adieresis: 0x00c4, adieresis: 0x00e4, Agrave: 0x00c0, agrave: 0x00e0,
	Aring: 0x00c5, aring: 0x00e5, Atilde: 0x00c3, atilde: 0x00e3, Ccedilla: 0x00c7,
	ccedilla: 0x00e7, Eacute: 0x00c9, eacute: 0x00e9, Ecircumflex: 0x00ca, ecircumflex: 0x00ea,
	Edieresis: 0x00cb, edieresis: 0x00eb, Egrave: 0x00c8, egrave: 0x00e8, Iacute: 0x00cd,
	iacute: 0x00ed, Icircumflex: 0x00ce, icircumflex: 0x00ee, Idieresis: 0x00cf, idieresis: 0x00ef,
	Igrave: 0x00cc, igrave: 0x00ec, Oacute: 0x00d3, oacute: 0x00f3, Ocircumflex: 0x00d4,
	ocircumflex: 0x00f4, Odieresis: 0x00d6, odieresis: 0x00f6, Ograve: 0x00d2, ograve: 0x00f2,
	Otilde: 0x00d5, otilde: 0x00f5, Uacute: 0x00da, uacute: 0x00fa, Ucircumflex: 0x00db,
	ucircumflex: 0x00fb, Udieresis: 0x00dc, udieresis: 0x00fc, Ugrave: 0x00d9, ugrave: 0x00f9,
	Yacute: 0x00dd, yacute: 0x00fd, ycircumflex: 0x0177, Ycircumflex: 0x0176
}));

const GLYPH_CACHE = new Map();

// 连字：直接展开成字母序列，读起来与检索都比保留 U+FB01 更自然。
const LIGATURES = new Map([
	['fi', 'fi'], ['fl', 'fl'], ['ff', 'ff'], ['ffi', 'ffi'], ['ffl', 'ffl'],
	['IJ', 'IJ'], ['ij', 'ij'], ['ae', '\u00e6'], ['AE', '\u00c6']
]);

/** 字形名 → Unicode 字符串；未知返回 undefined。 */
export function glyphToUnicode(glyphName) {
	if (GLYPH_CACHE.has(glyphName)) return GLYPH_CACHE.get(glyphName);
	let result;
	if (LIGATURES.has(glyphName)) result = LIGATURES.get(glyphName);
	else if (GLYPH_NAMES.has(glyphName)) result = String.fromCodePoint(GLYPH_NAMES.get(glyphName));
	else if (/^[A-Za-z0-9]$/u.test(glyphName)) result = glyphName;
	else {
		const uni = /^uni([0-9A-Fa-f]{4,6})$/u.exec(glyphName) ?? /^u([0-9A-Fa-f]{4,6})$/u.exec(glyphName);
		result = uni === null ? undefined : String.fromCodePoint(Number.parseInt(uni[1], 16));
	}
	GLYPH_CACHE.set(glyphName, result);
	return result;
}

function codeToUnicodeFromBaseEncoding(code, encodingName) {
	switch (encodingName) {
		case undefined: return undefined;
		case 'WinAnsiEncoding': return String.fromCodePoint(WIN_ANSI[code] ?? code);
		case 'MacRomanEncoding':
			return code >= 0x80 && code <= 0xff
				? String.fromCodePoint(MAC_ROMAN_HIGH[code - 0x80])
				: String.fromCodePoint(code);
		case 'StandardEncoding':
			return String.fromCodePoint(STANDARD_DIFFS.get(code) ?? code);
		case 'SymbolEncoding':
		case 'ZapfDingbatsEncoding':
			return undefined; // 符号字体：不猜
		default:
			// 未声明编码：PDF 默认按 StandardEncoding 的近似（Latin-1）处理；
			// 控制码不可能是可见字形，宁可报「无法解码」也不要吐控制字符
			if (code < 0x20 || code === 0x7f) return undefined;
			return String.fromCodePoint(STANDARD_DIFFS.get(code) ?? code);
	}
}

/**
 * 读内嵌 Type1 字体程序里的内建 /Encoding（清文段里的 `dup <code> /<字形名> put`）。
 *
 * 为什么需要它：TeX 排的数学符号字体（CMSY/CMMI/CMEX）常常**不写** PDF 层 /Encoding，
 * 这时唯一的真相在字体程序内部（例如 CMSY10 里 `dup 102 /braceleft put`）。不读它，
 * 数学符号就会退化成乱码或 U+FFFD。CFF（/FontFile3）不解析，留给上层报告。
 */
function readBuiltinType1Encoding(doc, dict) {
	const descriptor = deref(doc, dictGet(dict, 'FontDescriptor'));
	if (!isDict(descriptor)) return undefined;
	const fontFile = deref(doc, dictGet(descriptor, 'FontFile'));
	if (!isStream(fontFile)) return undefined;
	let data;
	try {
		data = doc.streamData(fontFile);
	} catch {
		return undefined;
	}
	const text = data.toString('latin1');
	const eexecAt = text.indexOf('currentfile eexec');
	const head = eexecAt > 0 ? text.slice(0, eexecAt) : text.slice(0, 400000);
	const encodingAt = head.indexOf('/Encoding');
	if (encodingAt === -1) return undefined;
	const block = head.slice(encodingAt, encodingAt + 40000);
	const map = new Map();
	for (const match of block.matchAll(/dup\s+(\d+)\s+\/([^\s/{}[\]]+)\s+put/gu)) {
		const code = Number.parseInt(match[1], 10);
		if (code >= 0 && code <= 255) map.set(code, match[2]);
	}
	return map.size > 0 ? map : undefined;
}

/* ── ToUnicode CMap ─────────────────────────────────────────────────────── */

/** UTF-16BE 十六进制 → 字符串。 */
function decodeUtf16BeHex(hex) {
	if (hex.length === 0) return '';
	let even = hex;
	if (even.length % 2 === 1) even += '0';
	const buffer = Buffer.from(even, 'hex');
	if (buffer.length % 2 === 1) return buffer.toString('latin1');
	return buffer.swap16().toString('utf16le');
}

/** UTF-16BE 十六进制 → 码元数组（用于 bfrange 递增）。 */
function utf16UnitsFromHex(hex) {
	if (hex.length === 0) return [];
	let even = hex;
	if (even.length % 2 === 1) even += '0';
	const buffer = Buffer.from(even, 'hex');
	const units = [];
	for (let i = 0; i + 1 < buffer.length; i += 2) units.push((buffer[i] << 8) | buffer[i + 1]);
	return units;
}

/**
 * 解析一个 CMap（ToUnicode 或 /Encoding 里的自定义 CMap）。
 * @returns {{ map: Map<number, string>, ranges: Array<{low:number, high:number, bytes:number}>, codeBytes: number|undefined }}
 */
export function parseCMap(bytes) {
	const text = bytes.toString('latin1');
	const map = new Map();
	const ranges = [];

	for (const block of text.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/gu)) {
		for (const pair of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/gu)) {
			ranges.push({
				low: Number.parseInt(pair[1], 16),
				high: Number.parseInt(pair[2], 16),
				bytes: Math.max(1, Math.ceil(pair[1].length / 2))
			});
		}
	}
	ranges.sort((a, b) => a.bytes - b.bytes);

	for (const block of text.matchAll(/(\d+)\s+beginbfchar([\s\S]*?)endbfchar/gu)) {
		for (const pair of block[2].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/gu)) {
			map.set(Number.parseInt(pair[1], 16), decodeUtf16BeHex(pair[2]));
		}
	}
	for (const block of text.matchAll(/(\d+)\s+beginbfrange([\s\S]*?)endbfrange/gu)) {
		for (const entry of block[2].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]*)>|\[([^\]]*)\])/gu)) {
			const low = Number.parseInt(entry[1], 16);
			const high = Number.parseInt(entry[2], 16);
			if (entry[3] !== undefined) {
				const units = utf16UnitsFromHex(entry[3]);
				if (units.length === 0) {
					for (let code = low; code <= high; code += 1) map.set(code, '');
					continue;
				}
				for (let code = low; code <= high && code - low < 65536; code += 1) {
					const shifted = [...units];
					shifted[shifted.length - 1] += code - low;
					map.set(code, String.fromCharCode(...shifted));
				}
			} else if (entry[4] !== undefined) {
				const items = [...entry[4].matchAll(/<([0-9A-Fa-f]*)>/gu)];
				items.forEach((item, index) => map.set(low + index, decodeUtf16BeHex(item[1])));
			}
		}
	}

	const codeBytes = ranges.length > 0 ? Math.max(...ranges.map((range) => range.bytes)) : undefined;
	return { map, ranges, codeBytes };
}

/** 简单字体里 /Encoding 是字典时，取出 /BaseEncoding 与 /Differences。 */
function buildDifferenceMap(encodingDict, doc) {
	const differences = new Map();
	const list = deref(doc, dictGet(encodingDict, 'Differences'));
	if (Array.isArray(list)) {
		let code = 0;
		for (const item of list) {
			if (typeof item === 'number') {
				code = item;
				continue;
			}
			if (isName(item)) {
				differences.set(code, item.name);
				code += 1;
			}
		}
	}
	const base = dictGet(encodingDict, 'BaseEncoding');
	return { differences, baseEncoding: isName(base) ? base.name : undefined };
}

/* ── 字体对象 ───────────────────────────────────────────────────────────── */

const UNDECODABLE = '\uFFFD';

export class PdfFont {
	/**
	 * @param doc PdfDocument
	 * @param dict 字体字典
	 */
	constructor(doc, dict) {
		this.doc = doc;
		this.dict = dict;
		const subtype = dictGet(dict, 'Subtype');
		this.subtype = isName(subtype) ? subtype.name : undefined;
		const baseFont = dictGet(dict, 'BaseFont');
		this.baseFont = isName(baseFont) ? baseFont.name : undefined;
		this.undecodable = 0;
		this.toUnicode = undefined;
		this.ranges = [];
		this.codeBytes = undefined;
		this.identityUtf16 = false;
		this.differences = undefined;
		this.baseEncoding = undefined;
		this.widths = undefined;
		this.defaultWidth = 500;
		this.firstChar = 0;
		this.initialize();
	}

	initialize() {
		const doc = this.doc;
		const dict = this.dict;
		const toUnicodeValue = deref(doc, dictGet(dict, 'ToUnicode'));
		if (isStream(toUnicodeValue)) {
			try {
				const parsed = parseCMap(doc.streamData(toUnicodeValue));
				this.toUnicode = parsed.map;
				this.ranges = parsed.ranges;
			} catch {
				this.toUnicode = undefined;
			}
		}

		if (this.subtype === 'Type0') {
			const encoding = deref(doc, dictGet(dict, 'Encoding'));
			if (isName(encoding)) {
				const name = encoding.name;
				if (/^Identity-[HV]$/u.test(name)) this.codeBytes ??= 2;
				else if (/^Uni[A-Z]+-UCS2-[HV]$/u.test(name)) {
					this.identityUtf16 = true;
					this.codeBytes ??= 2;
				} else this.codeBytes ??= 2; // 预定义 CJK CMap 一律双字节
			} else {
				const cmapStream = deref(doc, encoding);
				if (isStream(cmapStream)) {
					try {
						const parsed = parseCMap(doc.streamData(cmapStream));
						if (this.ranges.length === 0) this.ranges = parsed.ranges;
						if (this.codeBytes === undefined && parsed.codeBytes !== undefined) this.codeBytes = parsed.codeBytes;
					} catch {
						// 忽略：退回固定码长
					}
				}
				this.codeBytes ??= 2;
			}
			if (this.ranges.length > 0 && this.codeBytes === undefined) this.codeBytes = Math.max(...this.ranges.map((range) => range.bytes));
			this.codeBytes ??= 2;
			this.readCompositeWidths();
			return;
		}

		this.codeBytes = 1;
		const encoding = deref(doc, dictGet(dict, 'Encoding'));
		if (isDict(encoding)) {
			const { differences, baseEncoding } = buildDifferenceMap(encoding, doc);
			this.differences = differences;
			this.baseEncoding = baseEncoding;
		} else if (isName(encoding)) {
			this.baseEncoding = encoding.name;
		}
		this.builtinDifferences = readBuiltinType1Encoding(doc, dict);
		this.readSimpleWidths();
	}

	readSimpleWidths() {
		const doc = this.doc;
		const dict = this.dict;
		const descriptor = deref(doc, dictGet(dict, 'FontDescriptor'));
		const missing = isDict(descriptor) ? dictGet(descriptor, 'MissingWidth') : undefined;
		this.defaultWidth = typeof missing === 'number' ? missing : 500;
		const first = dictGet(dict, 'FirstChar');
		const widths = deref(doc, dictGet(dict, 'Widths'));
		if (typeof first === 'number' && Array.isArray(widths)) {
			this.firstChar = first;
			this.widths = widths.map((value) => (typeof value === 'number' ? value : this.defaultWidth));
		}
	}

	readCompositeWidths() {
		const doc = this.doc;
		const dict = this.dict;
		const descendants = deref(doc, dictGet(dict, 'DescendantFonts'));
		const descendant = Array.isArray(descendants) ? deref(doc, descendants[0]) : undefined;
		if (!isDict(descendant)) return;
		const dw = dictGet(descendant, 'DW');
		this.defaultWidth = typeof dw === 'number' ? dw : 1000;
		const w = deref(doc, dictGet(descendant, 'W'));
		if (!Array.isArray(w)) return;
		const map = new Map();
		let index = 0;
		while (index < w.length) {
			const first = w[index];
			if (typeof first !== 'number') {
				index += 1;
				continue;
			}
			const next = deref(doc, w[index + 1]);
			if (Array.isArray(next)) {
				next.forEach((value, offset) => {
					if (typeof value === 'number') map.set(first + offset, value);
				});
				index += 2;
				continue;
			}
			const last = typeof next === 'number' ? next : undefined;
			const width = w[index + 2];
			if (last !== undefined && typeof width === 'number') {
				for (let code = first; code <= last; code += 1) map.set(code, width);
			}
			index += 3;
		}
		this.widths = map;
	}

	/** 把一个字符串（Buffer）切成码值数组。 */
	splitCodes(bytes) {
		const codes = [];
		if (this.ranges.length > 0 && !this.identityUtf16) {
			let i = 0;
			while (i < bytes.length) {
				let matched = false;
				for (const range of this.ranges) {
					if (i + range.bytes > bytes.length) continue;
					let code = 0;
					for (let k = 0; k < range.bytes; k += 1) code = code * 256 + bytes[i + k];
					if (code >= range.low && code <= range.high) {
						codes.push(code);
						i += range.bytes;
						matched = true;
						break;
					}
				}
				if (!matched) {
					codes.push(bytes[i]);
					i += 1;
				}
			}
			return codes;
		}
		const width = this.codeBytes ?? 1;
		if (width <= 1) {
			for (const byte of bytes) codes.push(byte);
			return codes;
		}
		for (let i = 0; i + width <= bytes.length; i += width) {
			let code = 0;
			for (let k = 0; k < width; k += 1) code = code * 256 + bytes[i + k];
			codes.push(code);
		}
		return codes;
	}

	/** 单个码值 → Unicode 字符串。 */
	decodeCode(code) {
		if (this.toUnicode !== undefined) {
			const mapped = this.toUnicode.get(code);
			if (mapped !== undefined) return mapped;
		}
		if (this.identityUtf16) {
			return code >= 0xd800 && code <= 0xdfff ? '' : String.fromCodePoint(code);
		}
		if (this.codeBytes === 1) {
			const glyph = this.differences?.get(code);
			if (glyph !== undefined) {
				const mapped = glyphToUnicode(glyph);
				if (mapped !== undefined) return mapped;
				this.undecodable += 1;
				return UNDECODABLE;
			}
			// 1) PDF 里显式声明的 BaseEncoding / 编码名
			const declared = codeToUnicodeFromBaseEncoding(code, this.baseEncoding);
			if (declared !== undefined) return declared;
			// 2) 字体程序内建编码（TeX 数学字体这类不写 /Encoding 的字体靠它）
			const builtin = this.builtinDifferences?.get(code);
			if (builtin !== undefined) {
				const mapped = glyphToUnicode(builtin);
				if (mapped !== undefined) return mapped;
			}
			// 3) 完全没有编码信息时，才用 StandardEncoding 近似兜底
			if (this.builtinDifferences === undefined) {
				const fallback = codeToUnicodeFromBaseEncoding(code, 'StandardEncoding');
				if (fallback !== undefined) return fallback;
			}
		}
		this.undecodable += 1;
		return UNDECODABLE;
	}

	/** 码值的字宽（1/1000 em）。 */
	widthOf(code) {
		if (this.widths === undefined) return this.defaultWidth;
		if (Array.isArray(this.widths)) {
			const index = code - this.firstChar;
			return index >= 0 && index < this.widths.length ? this.widths[index] : this.defaultWidth;
		}
		return this.widths.get(code) ?? this.defaultWidth;
	}
}

/** 为一个页面的 /Resources /Font 建立 名字 → PdfFont 的映射。 */
export function buildFontMap(doc, resources) {
	const map = new Map();
	const fontDict = deref(doc, dictGet(resources, 'Font'));
	if (!isDict(fontDict)) return map;
	for (const [key, value] of fontDict.map) {
		const resolved = deref(doc, value);
		if (!isDict(resolved)) continue;
		try {
			map.set(key, new PdfFont(doc, resolved));
		} catch {
			// 单个字体失败不影响整页
		}
	}
	return map;
}
