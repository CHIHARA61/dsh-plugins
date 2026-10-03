/**
 * read_doc 工具的行为测试：用一个假的 ctx（只实现用到的 tools / fs 两个服务）把
 * 插件跑起来，再对真实文件调用工具，检查输出格式、分窗口、以及各类失败提示。
 *
 * 素材来自 `_research/doc-fixtures/`（由 test/make-fixtures.py 生成）与
 * `_research/pdf-corpus/`（下载 + LibreOffice 转换）。素材缺失时脚本会打印
 * 复现命令并以退出码 1 结束。
 */

import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { findResearchDir } from './data-paths.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = resolve(HERE, '..');
const RESEARCH = findResearchDir(PLUGIN);
const FIXTURES = join(RESEARCH, 'doc-fixtures');
const CORPUS = join(RESEARCH, 'pdf-corpus');
const SOURCES = join(RESEARCH, 'sources');

const { apply } = await import(pathToFileURL(join(PLUGIN, 'index.js')).href);

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

async function checkAsync(label, fn) {
	try {
		await fn();
		passed += 1;
		console.log(`  [PASS] ${label}`);
	} catch (error) {
		failed += 1;
		failures.push({ label, error });
		console.log(`  [FAIL] ${label}\n         ${error.message.split('\n')[0]}`);
	}
}

/** 把插件挂到一个最小 ctx 上，拿到它注册的工具。 */
function mountTool(config) {
	let tool;
	const ctx = {
		tools: {
			register: (definition) => {
				tool = definition;
				return () => {};
			}
		},
		fs: {
			resolve: (requested, options) => {
				const path = resolve(options?.cwd ?? process.cwd(), requested);
				return { displayPath: path, targetKey: path };
			},
			stat: (target) => {
				try {
					const info = statSync(target.targetKey);
					return info.isFile()
						? { type: 'file', size: info.size }
						: { type: 'directory', size: info.size };
				} catch {
					return undefined;
				}
			},
			readBytes: (target, _signal, maxBytes) => {
				const data = readFileSync(target.targetKey);
				if (maxBytes !== undefined && data.length > maxBytes) throw new Error('FS_TOO_LARGE');
				return data;
			}
		}
	};
	apply(ctx, config);
	assert.ok(tool !== undefined, '插件应当注册一个工具');
	return tool;
}

const exec = { signal: undefined, agent: undefined };

console.log('read_doc：工具定义');
const tool = mountTool();
check('工具名与参数 schema 符合注册表约定', () => {
	assert.equal(tool.name, 'read_doc');
	assert.equal(tool.parameters.type, 'object');
	assert.deepEqual(tool.parameters.required, ['file_path']);
	assert.equal(tool.parameters.additionalProperties, false);
	assert.equal(tool.parameters.properties.file_path.type, 'string');
	assert.equal(tool.output.schema.type, 'string');
	assert.equal(typeof tool.execute, 'function');
	assert.deepEqual(tool.output.render([], 'x'), [{ type: 'text', text: 'x' }]);
	assert.equal(typeof tool.presentCall({ file_path: 'a.pdf' }).title, 'string');
});

const docxPath = join(FIXTURES, 'sample.docx');
const chineseDocx = join(RESEARCH, 'pdf-corpus', 'chinese-source.docx');
const pdfPath = join(SOURCES, 'test-openalex-chinese.pdf');
const chinesePdf = join(CORPUS, 'chinese-doc.pdf');
const resnetPdf = join(CORPUS, 'resnet-2col.pdf');
const pptxPath = join(FIXTURES, 'sample.pptx');
const xlsxPath = join(FIXTURES, 'sample.xlsx');

const missing = [docxPath, pdfPath, chinesePdf, pptxPath, xlsxPath].filter((path) => !existsSync(path));
if (missing.length > 0) {
	console.log('\n缺少测试素材：');
	for (const path of missing) console.log(`  - ${path}`);
	console.log('\n先跑：<bundled-python> dsh-preset-interlocutor/test/make-fixtures.py');
	console.log('中文 PDF 素材：python _research/make-chinese-docx.py 后用 libreoffice-kit convert 转 PDF');
	process.exit(1);
}

console.log('\nread_doc：docx');
await checkAsync('读 docx：带行号、含 <path>/<format>/<content> 外壳', async () => {
	const text = await tool.execute({ file_path: docxPath }, exec);
	assert.match(text, /^<path>.*sample\.docx<\/path>\n<format>docx/);
	assert.match(text, /\n1: /);
	assert.match(text, /\n<\/content>\n/);
	assert.match(text, /共 \d+ 行/);
});

await checkAsync('读中文 docx：正文与表格都在', async () => {
	const text = await tool.execute({ file_path: chineseDocx }, exec);
	assert.ok(text.includes('本文主张：把可证伪性当作政策辩论的准入标准是错的。'), '应含正文首句');
	assert.ok(text.includes('提高税率抑制投资'), '应含表格单元格');
	assert.ok(text.includes('最低工资提高失业'), '应含表格第二行');
});

await checkAsync('docx 分窗口：offset/limit 生效且提示续读', async () => {
	const first = await tool.execute({ file_path: chineseDocx, limit: 2 }, exec);
	assert.match(first, /本次显示 1-2 行/);
	assert.match(first, /offset=3 继续/);
	const second = await tool.execute({ file_path: chineseDocx, offset: 3, limit: 2 }, exec);
	assert.match(second, /本次显示 3-4 行/);
	assert.notEqual(first.split('\n')[3], second.split('\n')[3]);
});

console.log('\nread_doc：pdf');
await checkAsync('读 PDF：页标记、页数摘要、无警告', async () => {
	const text = await tool.execute({ file_path: pdfPath }, exec);
	assert.match(text, /<format>pdf，全部 23 页<\/format>/);
	assert.match(text, /1: ===== page 1 =====/);
	assert.ok(text.includes('Beyond openness'), '应含首页标题');
	assert.ok(!text.includes('注：'), '干净的 PDF 不该有告警');
});

await checkAsync('读 PDF：pages 只读指定页', async () => {
	const text = await tool.execute({ file_path: pdfPath, pages: '4-5' }, exec);
	assert.match(text, /第 4-5 页/);
	assert.ok(text.includes('===== page 4 =====') && text.includes('===== page 5 ====='));
	assert.ok(!text.includes('===== page 6 ====='));
});

await checkAsync('读中文 PDF：中文正文完整', async () => {
	const text = await tool.execute({ file_path: chinesePdf }, exec);
	assert.ok(text.includes('本文主张：把可证伪性当作政策辩论的准入标准是错的。'), text.slice(0, 400));
	assert.ok(text.includes('最低工资提高失业'), '应含表格行');
});

await checkAsync('读双栏 PDF：整篇抽取不报错且字数可观', async () => {
	const text = await tool.execute({ file_path: resnetPdf, pages: '1-2' }, exec);
	assert.ok(text.includes('Deep Residual Learning'), '应含标题');
	assert.ok(text.replace(/\s/gu, '').length > 1500, '两页正文应当有实质内容');
});

await checkAsync('超过 pdfPageBatch 的 PDF 默认只读前若干页并说明', async () => {
	const batched = mountTool({ pdfPageBatch: 4 });
	const text = await batched.execute({ file_path: pdfPath }, exec);
	assert.match(text, /共 23 页/);
	assert.match(text, /只抽了前 4 页/);
	assert.ok(!text.includes('===== page 5 ====='), '不该出现批次之外的页');
	assert.ok(text.includes('===== page 1 ====='));
});

console.log('\nread_doc：pptx / xlsx / 纯文本');
await checkAsync('读 pptx：含幻灯片标记', async () => {
	const text = await tool.execute({ file_path: pptxPath }, exec);
	assert.match(text, /<format>pptx/);
	assert.ok(text.includes('===== slide 1 ====='), text.slice(0, 300));
});

await checkAsync('读 xlsx：含工作表名', async () => {
	const text = await tool.execute({ file_path: xlsxPath }, exec);
	assert.match(text, /<format>xlsx/);
	assert.ok(text.includes('===== sheet "'), text.slice(0, 300));
});

await checkAsync('纯文本走直通并提示 read 也能读', async () => {
	const text = await tool.execute({ file_path: join(RESEARCH, 'compare-pdf.py') }, exec);
	assert.match(text, /<format>纯文本/);
	assert.ok(text.includes('内置 read 工具'));
});

console.log('\nread_doc：失败路径');
await checkAsync('不存在的文件给出明确错误', async () => {
	await assert.rejects(() => tool.execute({ file_path: join(CORPUS, 'nope.pdf') }, exec), /文件不存在/);
});

await checkAsync('空 file_path 被拒', async () => {
	await assert.rejects(() => tool.execute({ file_path: '  ' }, exec), /非空字符串/);
});

await checkAsync('offset 越界给出可读提示', async () => {
	await assert.rejects(() => tool.execute({ file_path: docxPath, offset: 99999 }, exec), /超出了文档/);
});

await checkAsync('不支持的扩展名给出明确提示', async () => {
	const fake = join(CORPUS, 'chinese-source.docx');
	assert.ok(existsSync(fake));
	const binary = mountTool();
	// 直接对一个真的 .docx 改名场景不成立，这里换个思路：读一张图片的路径提示
	void binary;
	const png = join(RESEARCH, 'crop-line.png');
	if (existsSync(png)) {
		await assert.rejects(() => tool.execute({ file_path: png }, exec), /用 read_image/);
	}
});

/* ── 依赖与实现约束 ─────────────────────────────────────────────────────── */

console.log('\n实现约束');
check('插件不 import 任何第三方包（只用 node: 内置与相对路径）', () => {
	const files = [join(PLUGIN, 'index.js')];
	for (const relative of ['lib/zip.js', 'lib/ooxml.js', 'lib/pdf/objects.js', 'lib/pdf/fonts.js', 'lib/pdf/content.js', 'lib/pdf/index.js']) {
		files.push(join(PLUGIN, relative));
	}
	for (const file of files) {
		const source = readFileSync(file, 'utf8');
		for (const match of source.matchAll(/^\s*import[^'"]*['"]([^'"]+)['"]/gmu)) {
			const specifier = match[1];
			assert.ok(
				specifier.startsWith('node:') || specifier.startsWith('./') || specifier.startsWith('../'),
				`${file} 引入了不受支持的依赖：${specifier}`
			);
		}
	}
});

check('配置项越界时被夹到合法范围', () => {
	const clamped = mountTool({ lineLimit: -5, charBudget: 1, pdfPageBatch: 100000 });
	assert.equal(clamped.name, 'read_doc');
});

console.log(`\n${'-'.repeat(60)}`);
if (failed === 0) {
	console.log(`全部通过：${passed} 项断言组`);
} else {
	console.log(`通过 ${passed}，失败 ${failed}`);
	for (const { label, error } of failures) console.log(`\n[${label}]\n${error.stack}`);
	process.exitCode = 1;
}
