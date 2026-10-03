/**
 * PDF 抽取的行为测试。
 *
 * 前半段用**手工构造**的 PDF（合成件，永远可用）：它们能精确地钉住几条关键路径——
 * 正常文本、只有图片没有文字层、加密、xref 损坏走全文扫描。后半段对真实语料做断言，
 * 语料不在（`_research/pdf-corpus/`）时跳过并打印获取方式。
 *
 * 语料获取：
 *   - `_research/sources/test-openalex-chinese.pdf`（23 页英文论文，CID 字体）
 *   - `_research/pdf-corpus/resnet-2col.pdf`（12 页双栏，Type1 字体）
 *   - `_research/pdf-corpus/chinese-doc.pdf`（中文，LibreOffice 由 docx 转出）
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractPdf, parsePageRange, probePdf } from '../lib/pdf/index.js';
import { assembleText, estimateSpaceThreshold } from '../lib/pdf/content.js';
import { findResearchDir } from './data-paths.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESEARCH = findResearchDir(resolve(HERE, '..'));
const CORPUS = join(RESEARCH, 'pdf-corpus');
const SOURCES = join(RESEARCH, 'sources');

let passed = 0;
let failed = 0;
const failures = [];

function check(label, fn) {
	try {
		fn();
		passed += 1;
		console.log(`  [PASS] ${label}`);
	} catch (error) {
		failed += 1;
		failures.push({ label, error });
		console.log(`  [FAIL] ${label}\n         ${error.message.split('\n')[0]}`);
	}
}

/* ── 合成 PDF 构造器 ────────────────────────────────────────────────────── */

/** 用经典 xref 表把对象数组拼成一份合法 PDF。 */
function buildPdf(objects, { breakStartXref = false } = {}) {
	let out = '%PDF-1.4\n';
	const offsets = [];
	objects.forEach((body, index) => {
		offsets.push(out.length);
		out += `${index + 1} 0 obj\n${body}\nendobj\n`;
	});
	const xrefStart = out.length;
	out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
	out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n`;
	out += `${breakStartXref ? 999999 : xrefStart}\n%%EOF\n`;
	return Buffer.from(out, 'latin1');
}

function stream(dict, content) {
	return `<< ${dict} /Length ${content.length} >>\nstream\n${content}\nendstream`;
}

/** 一页、一段文字的 PDF（Helvetica，无内嵌字体）。 */
function textPdf(text = 'Hello PDF world') {
	const content = `BT /F1 12 Tf 72 700 Td (${text}) Tj ET`;
	return buildPdf([
		'<< /Type /Catalog /Pages 2 0 R >>',
		'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
		'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
		stream('', content),
		'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'
	]);
}

/** 只有一张图片、没有文字层的「扫描件」。 */
function imageOnlyPdf() {
	const image = stream('/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8', '\u0001\u0002\u0003\u0004\u0005\u0006\u0007\u0008\u0009\u000a\u000b\u000c');
	const content = 'q 100 0 0 100 100 600 cm /Im0 Do Q';
	return buildPdf([
		'<< /Type /Catalog /Pages 2 0 R >>',
		'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
		'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>',
		image,
		stream('', content)
	]);
}

/** 带 /Encrypt 的 PDF（只需触发拒绝路径，不需要真的可解密）。 */
function encryptedPdf() {
	let out = '%PDF-1.4\n';
	const offsets = [];
	const objects = [
		'<< /Type /Catalog /Pages 2 0 R >>',
		'<< /Type /Pages /Kids [] /Count 0 >>',
		'<< /Filter /Standard /V 1 /R 2 /O <00> /U <00> /P -1 >>'
	];
	objects.forEach((body, index) => {
		offsets.push(out.length);
		out += `${index + 1} 0 obj\n${body}\nendobj\n`;
	});
	const xrefStart = out.length;
	out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
	out += `trailer\n<< /Size 4 /Root 1 0 R /Encrypt 3 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
	return Buffer.from(out, 'latin1');
}

/* ── 合成件断言 ─────────────────────────────────────────────────────────── */

console.log('测试件 pdf/index.js：合成 PDF');

check('抽取一页纯文本 PDF', () => {
	const result = extractPdf(textPdf('Hello PDF world'));
	assert.equal(result.totalPages, 1);
	assert.equal(result.pages.length, 1);
	assert.ok(result.pages[0].lines.join('\n').includes('Hello PDF world'), result.pages[0].lines.join('|'));
	assert.equal(result.pages[0].chars, 'HelloPDFworld'.length);
});

check('WinAnsiEncoding 下的重音字符能正确解码', () => {
	const result = extractPdf(textPdf('caf\\351 na\\357ve'));
	const text = result.pages[0].lines.join('\n');
	assert.ok(text.includes('café naïve'), text);
});

check('openalex 之外的转义：八进制与括号', () => {
	const result = extractPdf(textPdf('a\\(b\\)c'));
	assert.ok(result.pages[0].lines.join('\n').includes('a(b)c'));
});

check('没有文字层的 PDF：不报错，但明确警告', () => {
	const result = extractPdf(imageOnlyPdf());
	assert.equal(result.pages[0].chars, 0);
	assert.ok(result.warnings.some((warning) => warning.includes('扫描件')), JSON.stringify(result.warnings));
});

check('加密 PDF 被拒绝（不猜密码）', () => {
	assert.throws(() => extractPdf(encryptedPdf()), (error) => error.code === 'PDF_ENCRYPTED');
});

check('startxref 损坏时退回全文扫描仍然能读', () => {
	const result = extractPdf(buildPdf([
		'<< /Type /Catalog /Pages 2 0 R >>',
		'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
		'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
		stream('', 'BT /F1 12 Tf 72 700 Td (fallback works) Tj ET'),
		'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'
	], { breakStartXref: true }));
	assert.equal(result.totalPages, 1);
	assert.ok(result.pages[0].lines.join('\n').includes('fallback works'));
});

check('probePdf 只数页数', () => {
	assert.equal(probePdf(textPdf()).totalPages, 1);
});

console.log('\n测试件 pdf/index.js：页范围与参数');

check('parsePageRange 支持单页、区间、逗号与去重', () => {
	assert.deepEqual(parsePageRange('3', 10), [3]);
	assert.deepEqual(parsePageRange('2-4', 10), [2, 3, 4]);
	assert.deepEqual(parsePageRange('2,5-7,5', 10), [2, 5, 6, 7]);
	assert.deepEqual(parsePageRange(undefined, 3), [1, 2, 3]);
	assert.equal(parsePageRange('1-99', 5).length, 5);
});

check('非法页范围抛中文错误', () => {
	assert.throws(() => parsePageRange('abc', 5), /不合法/);
	assert.throws(() => parsePageRange('4-2', 5), /不合法/);
	assert.throws(() => parsePageRange('99', 5), /超出了文档/);
});

check('maxPages 限制生效', () => {
	const big = buildPdf([
		'<< /Type /Catalog /Pages 2 0 R >>',
		`<< /Type /Pages /Kids [${Array.from({ length: 5 }, (_, index) => `${index + 3} 0 R`).join(' ')}] /Count 5 >>`,
		...Array.from({ length: 5 }, () => '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>')
	]);
	assert.equal(extractPdf(big).totalPages, 5);
	assert.throws(() => extractPdf(big, { maxPages: 2 }), /最多抽取 2 页/);
});

console.log('\n测试件 pdf/content.js：拼行与阈值');

check('estimateSpaceThreshold 在双峰间隙上落在两峰之间', () => {
	const runs = [];
	for (let index = 0; index < 800; index += 1) {
		// 字内间隙 0，词间间隙 0.25 em
		runs.push({ text: 'a', x: index * 10, endX: index * 10 + 10, y: 100, fontSize: 10 });
		if (index % 5 === 4) runs.push({ text: 'a', x: index * 10 + 12.5, endX: index * 10 + 22.5, y: 100, fontSize: 10 });
	}
	const threshold = estimateSpaceThreshold(runs);
	assert.ok(threshold > 0.1 && threshold < 0.3, `阈值 ${threshold} 应落在两峰之间`);
});

check('行内乱序的 run 按 x 重排（LibreOffice 的两趟绘制）', () => {
	const runs = [
		{ text: 'B', x: 30, endX: 40, y: 100, fontSize: 10 },
		{ text: 'A', x: 20, endX: 30, y: 100, fontSize: 10 },
		{ text: 'C', x: 40, endX: 50, y: 100, fontSize: 10 }
	];
	assert.deepEqual(assembleText(runs, { spaceRatio: 0.25 }), ['ABC']);
});

check('无空格的字距不产生空格，明显间隙产生空格', () => {
	const tight = [
		{ text: 'a', x: 0, endX: 10, y: 100, fontSize: 10 },
		{ text: 'b', x: 10, endX: 20, y: 100, fontSize: 10 }
	];
	const loose = [
		{ text: 'a', x: 0, endX: 10, y: 100, fontSize: 10 },
		{ text: 'b', x: 15, endX: 25, y: 100, fontSize: 10 }
	];
	assert.deepEqual(assembleText(tight, { spaceRatio: 0.25 }), ['ab']);
	assert.deepEqual(assembleText(loose, { spaceRatio: 0.25 }), ['a b']);
});

/* ── 真实语料 ───────────────────────────────────────────────────────────── */

console.log('\n测试件 pdf/index.js：真实语料');

const corpus = [
	{ path: join(SOURCES, 'test-openalex-chinese.pdf'), pages: 23, expect: 'Beyond openness', how: '23 页英文论文（CID 字体、对象流 / xref 流）' },
	{ path: join(CORPUS, 'resnet-2col.pdf'), pages: 12, expect: 'Deep Residual Learning', how: '12 页双栏（pdfTeX Type1 + 内建编码）' },
	{ path: join(CORPUS, 'chinese-doc.pdf'), pages: 1, expect: '本文主张：把可证伪性当作政策辩论的准入标准是错的。', how: 'python _research/make-chinese-docx.py + libreoffice-kit convert' },
	{ path: join(CORPUS, 'chinese-mpl-truetype.pdf'), pages: 1, expect: '论证据的可证伪性与政策辩论', how: 'python _research/make-mpl-pdf.py' }
];
let available = 0;
for (const item of corpus) {
	if (!existsSync(item.path)) {
		console.log(`  [SKIP] 缺语料：${item.path}（${item.how}）`);
		continue;
	}
	available += 1;
	check(`${item.path.split(/[\\/]/u).pop()}：页数与首页内容`, () => {
		const result = extractPdf(readFileSync(item.path));
		assert.equal(result.totalPages, item.pages);
		const pages = result.pages;
		const text = pages.flatMap((page) => page.lines).join('\n');
		assert.ok(text.includes(item.expect), `应包含 ${item.expect}`);
		// 无法解码的字形只应占极小比例（数学符号字体里少数未在子集编码内的码位）
		const chars = pages.reduce((sum, page) => sum + page.chars, 0);
		assert.ok(result.meta.undecodable < chars * 0.01, `无法解码字形 ${result.meta.undecodable} / ${chars} 偏多`);
	});
}
if (available === 0) {
	console.log('  （真实语料都不在：_research/pdf-corpus/ 与 _research/sources/ 下的 PDF 由 _research 里的脚本生成/下载）');
}

check('Type3 且没有 Unicode 映射的 PDF：如实报告抽不出，而不是吐乱码', () => {
	const path = join(CORPUS, 'chinese-mpl-type3.pdf');
	if (!existsSync(path)) {
		console.log('  [SKIP] 缺语料 chinese-mpl-type3.pdf（python _research/make-mpl-pdf.py）');
		passed += 1;
		return;
	}
	const result = extractPdf(readFileSync(path));
	assert.ok(result.meta.undecodable > 0, '应当统计到无法解码的字形');
	assert.ok(
		result.warnings.some((warning) => warning.includes('无法解码')),
		`应当明确告警，实际：${JSON.stringify(result.warnings)}`
	);
});

console.log(`\n${'-'.repeat(60)}`);
if (failed === 0) {
	console.log(`全部通过：${passed} 项断言组${available === 0 ? '（真实语料已跳过）' : ''}`);
} else {
	console.log(`通过 ${passed}，失败 ${failed}`);
	for (const { label, error } of failures) console.log(`\n[${label}]\n${error.stack}`);
	process.exitCode = 1;
}
