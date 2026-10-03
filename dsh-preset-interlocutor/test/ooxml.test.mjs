/**
 * lib/zip.js 与 lib/ooxml.js 的测试（纯 Node，无第三方依赖）。
 *
 * 运行：
 *   1) <bundled-python> test/make-fixtures.py     # 生成 fixtures 到 _research/doc-fixtures/
 *   2) node test/ooxml.test.mjs
 *
 * 断言分成两类：
 *   - 真实 fixtures（python-docx / python-pptx / XlsxWriter / openpyxl 生成）
 *   - 手工拼的最小 ZIP 部件（覆盖 store 方式、稀疏列、字段代码、Zip64/加密等边界）
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as zlib from 'node:zlib';
import { openZip } from '../lib/zip.js';
import { extractDocx, extractPptx, extractXlsx } from '../lib/ooxml.js';
import { findResearchDir } from './data-paths.mjs';

// 素材目录向上找：工作区里那份副本（被 link 安装）与仓库里那份副本的上一级目录不同。
const FIXTURES = join(findResearchDir(fileURLToPath(new URL('..', import.meta.url))), 'doc-fixtures') + sep;

// 先做一次环境自检：fixtures 不存在时给出「怎么生成」的明确提示，而不是一堆 ENOENT。
if (!existsSync(`${FIXTURES}sample.docx`)) {
	console.error(
		[
			`找不到测试素材目录或素材文件：${FIXTURES}`,
			'请先用随包 Python 生成 fixtures（在工作区根目录执行）：',
			'  <bundled-python>/python.exe dsh-preset-interlocutor/test/make-fixtures.py',
			'可选：再用随包 LibreOffice 生成「另存为」样本，用来跑跨写入器一致性检查：',
			'  <node> <libreoffice-kit>/lib/cli.js convert \\',
			`    --input ${FIXTURES}sample.docx --output ${FIXTURES}sample-libreoffice.docx`,
		].join('\n'),
	);
	process.exit(1);
}

/* ---------------------------------------------------------------- *
 * 迷你测试运行器
 * ---------------------------------------------------------------- */

let passed = 0;
const failures = [];

function group(title) {
	console.log(`\n${title}`);
}

function test(name, fn) {
	try {
		fn();
		passed++;
		console.log(`  [PASS] ${name}`);
	} catch (err) {
		failures.push({ name, err });
		console.log(`  [FAIL] ${name}`);
		console.log(`         ${String(err && err.message).split('\n').join('\n         ')}`);
	}
}

/* ---------------------------------------------------------------- *
 * 工具
 * ---------------------------------------------------------------- */

const loadFixture = (name) => openZip(readFileSync(FIXTURES + name));

/** 手工造一个 ZIP（用于最小部件、store 方式、以及故意损坏的样本）。 */
function buildZip(entries, options = {}) {
	const locals = [];
	const central = [];
	let offset = 0;
	for (const entry of entries) {
		const name = Buffer.from(entry.name, 'utf8');
		const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
		const method = entry.method === 8 ? 8 : 0;
		const stored = method === 8 ? zlib.deflateRawSync(data) : data;
		const crc = zlib.crc32(data) >>> 0;

		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(method, 8);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(stored.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(name.length, 26);
		locals.push(local, name, stored);

		const cen = Buffer.alloc(46);
		cen.writeUInt32LE(0x02014b50, 0);
		cen.writeUInt16LE(20, 4);
		cen.writeUInt16LE(20, 6);
		cen.writeUInt16LE(method, 10);
		cen.writeUInt32LE(crc, 16);
		cen.writeUInt32LE(stored.length, 20);
		cen.writeUInt32LE(data.length, 24);
		cen.writeUInt16LE(name.length, 28);
		cen.writeUInt32LE(offset, 42);
		central.push(cen, name);

		offset += local.length + name.length + stored.length;
	}
	const cd = Buffer.concat(central);
	const comment = options.comment ? Buffer.from(options.comment, 'utf8') : Buffer.alloc(0);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(entries.length, 8);
	eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(cd.length, 12);
	eocd.writeUInt32LE(offset, 16);
	eocd.writeUInt16LE(comment.length, 20);
	return Buffer.concat([...locals, cd, eocd, comment]);
}

/** 在真实文件里定位中央目录条目，返回 {buffer, offset}，用于破坏性测试。 */
function findCentralEntry(buffer, name) {
	const eocd = buffer.length - 22 - buffer.readUInt16LE(buffer.length - 2);
	const cdOffset = buffer.readUInt32LE(eocd + 16);
	let p = cdOffset;
	while (p < buffer.length) {
		const nameLength = buffer.readUInt16LE(p + 28);
		const extraLength = buffer.readUInt16LE(p + 30);
		const commentLength = buffer.readUInt16LE(p + 32);
		const entryName = buffer.toString('utf8', p + 46, p + 46 + nameLength);
		if (entryName === name) return { offset: p, localOffset: buffer.readUInt32LE(p + 42) };
		p += 46 + nameLength + extraLength + commentLength;
	}
	throw new Error(`测试自身出错：找不到中央目录条目 ${name}`);
}

const slideXml = (text, extra = '') => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p>${extra}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;

/* ---------------------------------------------------------------- *
 * zip.js
 * ---------------------------------------------------------------- */

group('lib/zip.js');

test('openZip 解析真实 .docx：names/has/entries/read/text', () => {
	const zip = loadFixture('sample.docx');
	const names = zip.names();
	assert.ok(names.includes('word/document.xml'), '应包含 word/document.xml');
	assert.ok(names.includes('[Content_Types].xml'));
	assert.equal(zip.has('word/document.xml'), true);
	assert.equal(zip.has('word/nope.xml'), false);
	assert.equal(zip.read('word/nope.xml'), undefined);
	assert.equal(zip.text('word/nope.xml'), undefined);
	const entries = zip.entries();
	assert.equal(entries.length, names.length);
	for (const entry of entries) {
		assert.equal(typeof entry.name, 'string');
		assert.equal(typeof entry.size, 'number');
		assert.equal(typeof entry.compressedSize, 'number');
	}
	const xml = zip.text('word/document.xml');
	assert.ok(xml.startsWith('<?xml'), 'document.xml 应是 XML 文本');
	assert.equal(zip.read('word/document.xml').length, Buffer.byteLength(xml, 'utf8'));
	// 重复读取走缓存，结果一致
	assert.equal(zip.read('word/document.xml'), zip.read('word/document.xml'));
	assert.ok(names.filter((n) => n.startsWith('word/media/')).length === 1, '应有一张图片');
});

test('openZip 接受 Uint8Array，并且 store 与 deflate 两种方式都能读', () => {
	const raw = readFileSync(FIXTURES + 'sample.docx');
	const zip = openZip(new Uint8Array(raw));
	assert.ok(zip.text('word/document.xml').includes('文档抽取测试'));

	const mixed = openZip(
		buildZip([
			{ name: 'stored.txt', data: '原样存储的内容 store', method: 0 },
			{ name: 'deflated.txt', data: '压缩存储的内容 deflate '.repeat(20), method: 8 },
		]),
	);
	assert.equal(mixed.text('stored.txt'), '原样存储的内容 store');
	assert.equal(mixed.text('deflated.txt'), '压缩存储的内容 deflate '.repeat(20));
	const deflated = mixed.entries().find((e) => e.name === 'deflated.txt');
	assert.ok(deflated.compressedSize < deflated.size, 'deflate 条目应被压缩');
});

test('尾部带注释的 ZIP 能正常打开（注释里就算有伪 EOCD 签名也不受影响）', () => {
	const fake = Buffer.alloc(22);
	fake.writeUInt32LE(0x06054b50, 0); // 注释里塞一个假的 EOCD 记录
	fake.writeUInt16LE(0xffff, 8);
	const comment = Buffer.concat([Buffer.from('这是 ZIP 注释 ', 'utf8'), fake, Buffer.from('结尾', 'utf8')]);
	const zip = openZip(buildZip([{ name: 'a/b.txt', data: '注释里的内容', method: 8 }], { comment }));
	assert.equal(zip.text('a/b.txt'), '注释里的内容');
	assert.deepEqual(zip.names(), ['a/b.txt']);
});

test('OLE/CFB 容器（旧版二进制或加密的 Office 文件）给出明确提示', () => {
	const ole = Buffer.alloc(64);
	Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(ole, 0);
	assert.throws(() => openZip(ole), /OLE\/CFB|加密/);
});

test('openZip 对非 ZIP 数据抛中文错误', () => {
	assert.throws(() => openZip(Buffer.from('这根本不是 zip 文件，只是一段中文文本。'.repeat(5))), /EOCD/);
	assert.throws(() => openZip(Buffer.alloc(8)), /太小/);
});

test('openZip 对被截断的 ZIP（尾部丢了 EOCD）抛错', () => {
	const raw = readFileSync(FIXTURES + 'sample.docx');
	assert.throws(() => openZip(raw.subarray(0, raw.length - 30)), /EOCD/);
});

test('openZip 对 Zip64 明确报错', () => {
	const locator = Buffer.alloc(20);
	locator.writeUInt32LE(0x07064b50, 0);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(0xffff, 8); // 条目数达到 Zip64 哨兵值
	eocd.writeUInt16LE(0xffff, 10);
	assert.throws(() => openZip(Buffer.concat([locator, eocd])), /Zip64/);
});

test('openZip 对加密条目明确报错', () => {
	const raw = readFileSync(FIXTURES + 'sample.docx');
	const { offset } = findCentralEntry(raw, 'word/document.xml');
	raw.writeUInt16LE(raw.readUInt16LE(offset + 8) | 0x1, offset + 8); // 打开加密标志位
	const zip = openZip(raw);
	assert.equal(zip.has('word/document.xml'), true);
	assert.throws(() => zip.read('word/document.xml'), /已加密/);
});

test('openZip 对损坏的数据做 CRC 校验并报错', () => {
	const raw = readFileSync(FIXTURES + 'sample.docx');
	const { localOffset } = findCentralEntry(raw, 'word/document.xml');
	const nameLength = raw.readUInt16LE(localOffset + 26);
	const extraLength = raw.readUInt16LE(localOffset + 28);
	const dataStart = localOffset + 30 + nameLength + extraLength;
	raw[dataStart + 3] ^= 0xff;
	const zip = openZip(raw);
	assert.throws(() => zip.read('word/document.xml'), /CRC 校验失败|解压失败/);
});

test('openZip 对不支持的压缩方式报错', () => {
	const normal = buildZip([{ name: 'a.txt', data: 'hello' }]);
	const { offset } = findCentralEntry(normal, 'a.txt');
	normal.writeUInt16LE(99, offset + 10); // 改成未知 method
	const zip = openZip(normal);
	assert.throws(() => zip.read('a.txt'), /不支持的压缩方式/);
});

/* ---------------------------------------------------------------- *
 * docx
 * ---------------------------------------------------------------- */

group('lib/ooxml.js — extractDocx');

test('正文按 段落 / 表格 的文档流顺序逐行输出', () => {
	const r = extractDocx(loadFixture('sample.docx'));
	const lines = r.text.split('\n');
	assert.equal(lines[0], '文档抽取测试 Document Extraction Test');
	assert.equal(lines[1], '中文与 English 混排：模型上下文窗口 test 123。');
	assert.equal(lines[2], '', '空段落应保留为空行');
	assert.equal(lines[3], '段落A同一段落内的第二段文字。');
	assert.equal(lines[4], '制表符→\t列二\t列三', 'w:tab 应变成制表符');
	assert.equal(lines[5], '软换行前 软换行后', '段内 w:br 压成空格，保证一段一行');
	assert.equal(lines[6], '特殊符号：不断行连字符-，项目符号·', 'w:noBreakHyphen→-，w:sym 尽力还原');
	assert.ok(lines[7].startsWith('超长段落：'), '超长段落应独占一行');
	assert.ok(lines[7].length > 3000, `超长段落行长度应 > 3000，实际 ${lines[7].length}`);
	assert.ok(!lines[7].includes('\n'));
	assert.equal(lines[8], '表头一 | 表头二 | 表头三');
	assert.equal(lines[9], '甲 单元格第二段 | 乙 | 丙', '单元格内多段用空格连接');
	assert.equal(lines[10], 'a1 | b2 | c3');
	assert.equal(lines[11], '', '分页符不产出文本，只留一个空段落行');
	assert.equal(lines[12], '分页后的段落。');
	assert.equal(lines[13], '', '图片所在段落没有文本');
	assert.equal(lines[14], '修订演示：插入后的文字');
	assert.equal(lines.length, 15);
});

test('修订：插入保留、删除丢弃；域代码不输出', () => {
	const r = extractDocx(loadFixture('sample.docx'));
	assert.ok(r.text.includes('插入后的文字'));
	assert.ok(!r.text.includes('被删除的文字'), 'w:delText 不应输出');
	assert.equal(r.meta.deletedRuns, 1);
	assert.ok(r.notes.some((n) => /修订删除的文本共 1 处/.test(n)));
});

test('默认不展开附加部件，但 notes 报告数量', () => {
	const r = extractDocx(loadFixture('sample.docx'));
	assert.ok(!r.text.includes('页眉：内部资料 Header'));
	assert.ok(!r.text.includes('脚注一：数据来源见附录。'));
	assert.ok(r.notes.some((n) => /另有 2 个页眉\/页脚部件未展开/.test(n)), `实际 notes: ${JSON.stringify(r.notes)}`);
	assert.ok(r.notes.some((n) => /脚注\/尾注部件共 1 个未展开/.test(n)));
	assert.ok(r.notes.some((n) => /批注/.test(n)));
	assert.ok(r.notes.some((n) => /1 个图片\/媒体文件/.test(n)));
});

test('includeHeaders / includeFootnotes 为真时追加到文末并带标记', () => {
	const r = extractDocx(loadFixture('sample.docx'), { includeHeaders: true, includeFootnotes: true });
	const lines = r.text.split('\n');
	const headIdx = lines.indexOf('===== 页眉/页脚 =====');
	assert.ok(headIdx > 14, '页眉/页脚应在正文之后');
	assert.equal(lines[headIdx + 1], '--- word/header1.xml ---');
	assert.equal(lines[headIdx + 2], '页眉：内部资料 Header');
	assert.equal(lines[headIdx + 3], '--- word/footer1.xml ---');
	assert.equal(lines[headIdx + 4], '页脚：第 1 页 Footer');
	const noteIdx = lines.indexOf('===== 脚注/尾注 =====');
	assert.ok(noteIdx > headIdx);
	assert.equal(lines[noteIdx + 1], '[脚注 1] 脚注一：数据来源见附录。');
	assert.equal(lines[noteIdx + 2], '[脚注 2] 脚注二：样本量偏小。');
	assert.ok(r.notes.some((n) => /已展开在文末/.test(n)));
});

test('meta 稳定可用', () => {
	const r = extractDocx(loadFixture('sample.docx'), { includeHeaders: true, includeFootnotes: true });
	assert.equal(r.meta.type, 'docx');
	assert.equal(r.meta.paragraphs, 12);
	assert.equal(r.meta.tables, 1);
	assert.equal(r.meta.tableRows, 3);
	assert.equal(r.meta.headers, 1);
	assert.equal(r.meta.footers, 1);
	assert.equal(r.meta.footnotes, 1);
	assert.equal(r.meta.endnotes, 0);
	assert.equal(r.meta.comments, 1);
	assert.equal(r.meta.images, 1);
	assert.ok(Array.isArray(r.notes) && r.notes.every((n) => typeof n === 'string'));
});

test('缺 word/document.xml 时抛中文错误', () => {
	const zip = openZip(buildZip([{ name: 'word/styles.xml', data: '<w:styles/>' }]));
	assert.throws(() => extractDocx(zip), /这不是一个有效的 \.docx：缺少 word\/document\.xml/);
});

test('跨写入器一致性：LibreOffice「另存为」的 .docx 正文与 python-docx 版本一致', () => {
	const libreOffice = FIXTURES + 'sample-libreoffice.docx';
	if (!existsSync(libreOffice)) {
		console.log('         （跳过：先跑一次 LibreOffice convert 生成 sample-libreoffice.docx）');
		return;
	}
	const base = extractDocx(loadFixture('sample.docx'));
	const resaved = extractDocx(openZip(readFileSync(libreOffice)), { includeHeaders: true, includeFootnotes: true });
	const bodyLines = (t) => t.split('\n').slice(0, 15);
	assert.deepEqual(bodyLines(resaved.text), bodyLines(base.text), '两个写入器的正文行应逐行一致');
	assert.equal(resaved.meta.images, 1);
	assert.equal(resaved.meta.tables, 1);
	assert.equal(resaved.meta.tableRows, 3);
	assert.equal(resaved.meta.paragraphs, base.meta.paragraphs);
	// LibreOffice 会把页眉/页脚拆成多个部件（其中可能有空部件），数量由 notes 报告，空部件不留标记
	assert.ok(resaved.meta.headers >= 1 && resaved.meta.footers >= 1);
	assert.ok(
		resaved.notes.some((n) => /页眉\/页脚部件共 \d+ 个/.test(n)),
		`实际 notes: ${JSON.stringify(resaved.notes)}`,
	);
	assert.equal(/--- [^ ]+ ---\n\n/.test(resaved.text), false, '内容为空的页眉/页脚部件不应留下空标记');
	assert.ok(resaved.text.includes('页眉：内部资料 Header') && resaved.text.includes('页脚：第 1 页 Footer'));
});

test('XML 实体、CDATA、w:sym 非私有区、instrText 的边界处理', () => {
	const document = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>实体 a&amp;b &lt;tag&gt; &#20013;&#x6587;</w:t></w:r></w:p>
<w:p><w:r><w:t><![CDATA[CDATA 段 <原样>]]></w:t></w:r></w:p>
<w:p><w:r><w:instrText> PAGE \\* MERGEFORMAT </w:instrText></w:r><w:r><w:t>域后的正文</w:t></w:r></w:p>
<w:p><w:r><w:sym w:font="宋体" w:char="0041"/><w:noBreakHyphen/><w:tab/></w:r></w:p>
<w:p><w:r><w:t>带软换行</w:t><w:br/><w:t>后半句</w:t><w:br w:type="page"/><w:t>分页后</w:t></w:r></w:p>
</w:body></w:document>`;
	const r = extractDocx(openZip(buildZip([{ name: 'word/document.xml', data: document, method: 8 }])));
	const lines = r.text.split('\n');
	assert.equal(lines[0], '实体 a&b <tag> 中文');
	assert.equal(lines[1], 'CDATA 段 <原样>');
	assert.equal(lines[2], '域后的正文', 'w:instrText 不应输出');
	assert.ok(!r.text.includes('PAGE'));
	assert.ok(!r.text.includes('MERGEFORMAT'));
	assert.equal(lines[3], 'A-\t');
	assert.equal(lines[4], '带软换行 后半句分页后');
	assert.deepEqual(r.notes, []);
	assert.equal(r.meta.headers, 0);
});

/* ---------------------------------------------------------------- *
 * pptx
 * ---------------------------------------------------------------- */

group('lib/ooxml.js — extractPptx');

test('按幻灯片编号的数字顺序输出，且不含母版/版式文字', () => {
	const zip = loadFixture('sample.pptx');
	const r = extractPptx(zip);
	const lines = r.text.split('\n');
	assert.equal(lines[0], '===== slide 1 =====');
	assert.ok(r.text.includes('第一页：抽取测试'));
	assert.ok(r.text.includes('要点三：带\t制表符'));
	assert.ok(r.text.includes('表头A'));
	assert.ok(r.text.includes('值2'));
	const i1 = lines.indexOf('===== slide 1 =====');
	const i2 = lines.indexOf('===== slide 2 =====');
	const i3 = lines.indexOf('===== slide 3 =====');
	assert.ok(i1 >= 0 && i2 > i1 && i3 > i2, '三张幻灯片应依次出现');
	assert.ok(!r.text.includes('Click to edit Master title style'), '母版文字不应出现');
	assert.ok(!r.text.includes('Click to edit Master subtitle style'), '版式文字不应出现');
});

test('备注：默认展开，加 [备注] 行；没有备注的页不输出标记', () => {
	const r = extractPptx(loadFixture('sample.pptx'));
	const lines = r.text.split('\n');
	const idx = lines.indexOf('[备注]');
	assert.ok(idx > 0);
	assert.equal(lines[idx + 1], '备注：第一页的讲稿。第二句。');
	const slide3 = lines.indexOf('===== slide 3 =====');
	assert.ok(!lines.slice(slide3).includes('[备注]'), '第三页没有备注');
	assert.equal(lines.filter((l) => l === '[备注]').length, 2);
	assert.equal(r.meta.slides, 3);
	assert.equal(r.meta.notesSlides, 2);
	assert.equal(r.meta.notesExpanded, 2);
	assert.equal(r.meta.layouts, 11);
	assert.equal(r.meta.masters, 1);
	assert.ok(r.notes.some((n) => /slideLayouts/.test(n)));
});

test('includeNotes=false 时不展开备注，并在 notes 里说明', () => {
	const r = extractPptx(loadFixture('sample.pptx'), { includeNotes: false });
	assert.ok(!r.text.includes('[备注]'));
	assert.ok(!r.text.includes('备注：第一页的讲稿。第二句。'));
	assert.ok(r.notes.some((n) => /另有 2 页备注未展开/.test(n)), `实际 notes: ${JSON.stringify(r.notes)}`);
});

test('幻灯片编号按数字而非字符串排序，并跳过母版/版式/备注母版', () => {
	const zip = openZip(
		buildZip([
			{ name: 'ppt/slides/slide10.xml', data: slideXml('第十页文字'), method: 8 },
			{ name: 'ppt/slides/slide2.xml', data: slideXml('第二页文字'), method: 8 },
			{ name: 'ppt/slides/slide1.xml', data: slideXml('第一页文字'), method: 8 },
			{ name: 'ppt/slideLayouts/slideLayout1.xml', data: slideXml('版式文字'), method: 8 },
			{ name: 'ppt/slideMasters/slideMaster1.xml', data: slideXml('母版文字'), method: 8 },
			{ name: 'ppt/notesMasters/notesMaster1.xml', data: slideXml('备注母版文字'), method: 8 },
			{
				name: 'ppt/slides/_rels/slide2.xml.rels',
				data: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>`,
				method: 8,
			},
			{ name: 'ppt/notesSlides/notesSlide1.xml', data: slideXml('第二条备注'), method: 8 },
		]),
	);
	const r = extractPptx(zip);
	const lines = r.text.split('\n');
	assert.deepEqual(
		lines.filter((l) => l.startsWith('===== slide')),
		['===== slide 1 =====', '===== slide 2 =====', '===== slide 10 ====='],
	);
	const i2 = lines.indexOf('===== slide 2 =====');
	assert.equal(lines[i2 + 1], '第二页文字');
	assert.equal(lines[i2 + 2], '[备注]');
	assert.equal(lines[i2 + 3], '第二条备注');
	assert.equal(lines[i2 + 4], '===== slide 10 =====');
	assert.ok(!r.text.includes('版式文字'));
	assert.ok(!r.text.includes('母版文字'));
	assert.ok(!r.text.includes('备注母版文字'));
	assert.equal(r.meta.notesSlides, 1);
	assert.ok(r.notes.some((n) => /已跳过 1 个版式/.test(n)));
});

test('a:fld 域不产出文本；没有幻灯片时抛错', () => {
	const zip = openZip(
		buildZip([
			{ name: 'ppt/slides/slide1.xml', data: slideXml('标题文字', '<a:p><a:fld id="{1}" type="slidenum"><a:t>1</a:t></a:fld></a:p>') },
		]),
	);
	const r = extractPptx(zip);
	const lines = r.text.split('\n');
	assert.equal(lines.length, 2, `应只有标记 + 一行标题，实际：${JSON.stringify(lines)}`);
	assert.equal(lines[1], '标题文字');
	assert.throws(() => extractPptx(openZip(buildZip([{ name: 'ppt/theme/theme1.xml', data: '<x/>' }]))), /缺少|找不到 ppt\/slides/);
});

/* ---------------------------------------------------------------- *
 * xlsx
 * ---------------------------------------------------------------- */

group('lib/ooxml.js — extractXlsx');

test('真实工作簿：工作表顺序、共享串、公式缓存、日期序列号', () => {
	const r = extractXlsx(loadFixture('sample.xlsx'));
	const lines = r.text.split('\n');
	assert.equal(lines[0], '===== sheet "数据" =====');
	assert.equal(lines[1], '名称\t数值\t公式\t\t稀疏列E', 'E 列前的空列要补空字段');
	assert.equal(lines[2], '中文条目一\t42\t0', '公式缓存值按原样输出');
	assert.equal(lines[3], 'English row\t3.14\t0');
	assert.equal(lines[4], '\t45366', '日期按序列号输出，前面的空列补空字段');
	assert.equal(lines[5], '布尔\tTRUE');
	assert.equal(lines[6], '错误值\t#DIV/0!\tab', 't="e" 错误值原样输出，t="str" 用公式缓存文本');
	assert.equal(lines[7], '上面第 7 行是空行');
	assert.equal(lines[8], '===== sheet "汇总" =====');
	assert.equal(lines[9], '汇总表');
	assert.equal(lines[10], '100\t引用数据表');
	assert.equal(r.meta.sheets, 2);
	assert.equal(r.meta.sharedStrings, 11);
	assert.ok(r.notes.some((n) => /日期.*序列号/.test(n)));
});

test('inlineStr、隐藏表、空行跳过（openpyxl 生成）', () => {
	const r = extractXlsx(loadFixture('sample-inline.xlsx'));
	const lines = r.text.split('\n');
	assert.equal(lines[0], '===== sheet "内联串" =====');
	assert.equal(lines[1], '内联字符串 inline\t123\t中文 inlineStr 第三列');
	assert.equal(lines[2], '稀疏：这一行只有 A 和 D\t\t\t7', '跳过的列要补空字段');
	assert.equal(lines[3], '===== sheet "第二表" =====');
	assert.equal(lines[4], '3.5');
	assert.equal(lines[5], '第二表的中文');
	assert.ok(r.notes.some((n) => /跳过 1 个没有任何内容的空行/.test(n)));
	assert.ok(r.notes.some((n) => /1 张工作表.*隐藏状态/.test(n)));
});

test('t="s" / "inlineStr" / "str" / "b" / "e" / 数值 / 富文本共享串 / 无 r 属性', () => {
	const workbook = `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="第一表" sheetId="1" r:id="rId1"/></sheets></workbook>`;
	const rels = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
	const sst = `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2"><si><t>共享一</t></si><si><r><rPr><b/></rPr><t>富</t></r><r><t>文本</t></r><rPh sb="0" eb="1"><t>フ</t></rPh></si></sst>`;
	const sheet = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>
<row r="2"><c r="A2" t="inlineStr"><is><t>内联</t></is></c><c r="B2" t="str"><v>公式缓存</v></c><c r="C2" t="b"><v>1</v></c><c r="D2" t="b"><v>0</v></c></row>
<row r="3"><c t="n"><v>7.5</v></c><c t="n"><v>8</v></c></row>
<row r="4"><c r="B4" t="e"><v>#DIV/0!</v></c><c r="C4" t="s"><v>99</v></c></row>
</sheetData></worksheet>`;
	const zip = openZip(
		buildZip([
			{ name: 'xl/workbook.xml', data: workbook, method: 8 },
			{ name: 'xl/_rels/workbook.xml.rels', data: rels, method: 8 },
			{ name: 'xl/sharedStrings.xml', data: sst, method: 8 },
			{ name: 'xl/worksheets/sheet1.xml', data: sheet, method: 8 },
		]),
	);
	const r = extractXlsx(zip);
	const lines = r.text.split('\n');
	assert.equal(lines[0], '===== sheet "第一表" =====');
	assert.equal(lines[1], '共享一\t\t富文本', '富文本共享串要拼接所有 t，rPh 注音要排除');
	assert.equal(lines[2], '内联\t公式缓存\tTRUE\tFALSE');
	assert.equal(lines[3], '7.5\t8', '没有 r 属性时按出现顺序排');
	assert.equal(lines[4], '\t#DIV/0!\t', 't="e" 原样输出；越界共享串按空值');
	assert.ok(r.notes.some((n) => /1 处共享字符串索引越界/.test(n)));
	assert.equal(r.meta.sharedStrings, 2);
});

test('maxSheets / maxRowsPerSheet / maxCellChars 生效并写进 notes', () => {
	const many = extractXlsx(loadFixture('many-sheets.xlsx'), { maxSheets: 5 });
	assert.equal(many.meta.sheets, 25);
	assert.equal(many.meta.sheetsExpanded, 5);
	assert.equal(many.text.split('\n').filter((l) => l.startsWith('===== sheet')).length, 5);
	assert.ok(many.notes.some((n) => /共 25 张工作表，只展开了前 5 张/.test(n)));

	const rows = extractXlsx(loadFixture('many-rows.xlsx'), { maxRowsPerSheet: 10 });
	assert.equal(rows.text.split('\n').filter((l) => /^第\d+行/.test(l)).length, 10);
	assert.equal(rows.meta.truncatedSheets, true);
	assert.ok(rows.notes.some((n) => /超过 maxRowsPerSheet=10 行，已截断/.test(n)));

	const longCell = '很长的单元格内容'.repeat(10);
	const zip = openZip(
		buildZip([
			{
				name: 'xl/workbook.xml',
				data: `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="S" sheetId="1" r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></sheets></workbook>`,
			},
			{
				name: 'xl/_rels/workbook.xml.rels',
				data: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
			},
			{
				name: 'xl/worksheets/sheet1.xml',
				data: `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${longCell}</t></is></c></c></row></sheetData></worksheet>`.replace('</c></row>', '</row>'),
			},
		]),
	);
	const truncated = extractXlsx(zip, { maxCellChars: 5 });
	assert.equal(truncated.text.split('\n')[1], '很长的单元…');
	assert.ok(truncated.notes.some((n) => /超过 maxCellChars=5 字符，已截断/.test(n)));
});

test('容忍缺部件：没有 workbook.xml.rels、没有 sharedStrings.xml', () => {
	const workbook = `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="甲表" sheetId="1" r:id="rId1"/><sheet name="乙表" sheetId="2" state="veryHidden" r:id="rId2"/></sheets></workbook>`;
	const zip = openZip(
		buildZip([
			{ name: 'xl/workbook.xml', data: workbook, method: 8 },
			{
				name: 'xl/worksheets/sheet1.xml',
				data: `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>有内容</t></is></c><c r="D1" t="s"><v>7</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c></row></sheetData></worksheet>`,
				method: 8,
			},
			{
				name: 'xl/worksheets/sheet2.xml',
				data: `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>乙表内容</t></is></c></row></sheetData></worksheet>`,
				method: 8,
			},
		]),
	);
	const r = extractXlsx(zip);
	const lines = r.text.split('\n');
	assert.equal(lines[0], '===== sheet "甲表" =====');
	assert.equal(lines[1], '\t有内容\t\t', '没有 sharedStrings.xml 时共享串按空值输出，列位置仍要对齐');
	assert.equal(lines[2], '===== sheet "乙表" =====');
	assert.equal(lines[3], '乙表内容');
	assert.equal(r.meta.sheets, 2, '没有 rels 时按 xl/worksheets/sheetN.xml 的编号顺序兜底');
	assert.ok(r.notes.some((n) => /3 处共享字符串索引越界/.test(n)), `实际 notes: ${JSON.stringify(r.notes)}`);
	assert.ok(r.notes.some((n) => /veryHidden|隐藏/.test(n)));
	assert.ok(r.notes.some((n) => /跳过 1 个没有任何内容的空行/.test(n)), '整行都是空值的行应跳过');
});

test('工作表元素带命名空间前缀时也能解析', () => {
	const sheet = `<?xml version="1.0"?><x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData><x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:t>前缀写法</x:t></x:is></x:c><x:c r="C1"><x:v>9</x:v></x:c></x:row></x:sheetData></x:worksheet>`;
	const zip = openZip(
		buildZip([
			{
				name: 'xl/workbook.xml',
				data: `<x:workbook xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><x:sheets><x:sheet name="前缀表" sheetId="1" r:id="rId1"/></x:sheets></x:workbook>`,
			},
			{
				name: 'xl/_rels/workbook.xml.rels',
				data: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
			},
			{ name: 'xl/worksheets/sheet1.xml', data: sheet },
		]),
	);
	const r = extractXlsx(zip);
	const lines = r.text.split('\n');
	assert.equal(lines[0], '===== sheet "前缀表" =====');
	assert.equal(lines[1], '前缀写法\t\t9');
});

test('大表也能快速截断：5 万行工作表 + 2 万条共享串', () => {
	const rows = [];
	for (let r = 1; r <= 50000; r++) {
		rows.push(`<row r="${r}"><c r="A${r}" t="s"><v>${r % 20000}</v></c><c r="B${r}"><v>${r}</v></c></row>`);
	}
	const sst = [];
	for (let i = 0; i < 20000; i++) sst.push(`<si><t>串${i}</t></si>`);
	const zip = openZip(
		buildZip([
			{
				name: 'xl/workbook.xml',
				data: `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="大表" sheetId="1" r:id="rId1"/></sheets></workbook>`,
				method: 8,
			},
			{
				name: 'xl/_rels/workbook.xml.rels',
				data: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
				method: 8,
			},
			{
				name: 'xl/sharedStrings.xml',
				data: `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="20000" uniqueCount="20000">${sst.join('')}</sst>`,
				method: 8,
			},
			{
				name: 'xl/worksheets/sheet1.xml',
				data: `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.join('')}</sheetData></worksheet>`,
				method: 8,
			},
		]),
	);
	const started = Date.now();
	const r = extractXlsx(zip, { maxRowsPerSheet: 2000 });
	const ms = Date.now() - started;
	const dataLines = r.text.split('\n').filter((l) => /^串\d+\t\d+$/.test(l));
	assert.equal(dataLines.length, 2000);
	assert.equal(dataLines[0], '串1\t1');
	assert.equal(dataLines[1999], '串2000\t2000');
	assert.equal(r.meta.sharedStrings, 20000);
	assert.ok(r.notes.some((n) => /超过 maxRowsPerSheet=2000 行，已截断/.test(n)));
	assert.ok(ms < 5000, `应在 5 秒内返回，实际 ${ms}ms`);
	console.log(`         （5 万行 / 2 万共享串，截断到 2000 行耗时 ${ms}ms）`);
});

test('缺工作表的部件与缺 xl/workbook.xml 的处理', () => {
	const workbook = `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="在的" sheetId="1" r:id="rId1"/><sheet name="丢了的" sheetId="2" r:id="rId2"/></sheets></workbook>`;
	const rels = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`;
	const zip = openZip(
		buildZip([
			{ name: 'xl/workbook.xml', data: workbook },
			{ name: 'xl/_rels/workbook.xml.rels', data: rels },
			{ name: 'xl/worksheets/sheet1.xml', data: `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>在的内容</t></is></c></row></sheetData></worksheet>` },
		]),
	);
	const r = extractXlsx(zip);
	assert.ok(r.text.includes('===== sheet "在的" ====='));
	assert.ok(r.text.includes('===== sheet "丢了的" ====='));
	assert.ok(r.text.includes('（该工作表的部件在文件里缺失，无法展开）'));
	assert.ok(r.notes.some((n) => /1 张工作表的部件在文件里缺失/.test(n)));

	assert.throws(() => extractXlsx(openZip(buildZip([{ name: 'xl/styles.xml', data: '<x/>' }]))), /缺少 xl\/workbook\.xml/);
});

/* ---------------------------------------------------------------- *
 * 汇总
 * ---------------------------------------------------------------- */

console.log(`\n${'-'.repeat(60)}`);
if (failures.length === 0) {
	console.log(`全部通过：${passed} 项断言组`);
} else {
	console.log(`失败 ${failures.length} 项 / 共 ${passed + failures.length} 项：`);
	for (const { name, err } of failures) console.log(`\n### ${name}\n${err && err.stack ? err.stack : err}`);
	process.exitCode = 1;
}
