/**
 * 最小 ZIP 读取器（零依赖，只用 node:zlib / node:buffer）。
 *
 * 用途：读取 .docx / .pptx / .xlsx —— 它们本质上都是 ZIP 包。
 * 设计要点：
 *   - 只解析「中央目录」（EOCD 0x06054b50 + 各条目 0x02014b50），不靠逐个本地头扫描，
 *     因此条目顺序稳定、可随机访问。
 *   - 支持 store（method 0）与 deflate（method 8，zlib.inflateRawSync）。
 *   - Zip64、加密条目、分卷、损坏的中央目录都给出中文 Error，不静默返回空内容。
 *   - 单条目解压后字节数上限 256 MiB，防止 zip 炸弹。
 */

import * as zlib from 'node:zlib';
import { Buffer } from 'node:buffer';

const SIG_EOCD = 0x06054b50; // 中央目录结束记录
const SIG_CEN = 0x02014b50; // 中央目录文件头
const SIG_LOC = 0x04034b50; // 本地文件头
const SIG_ZIP64_EOCD_LOCATOR = 0x07064b50;

const EOCD_MIN_SIZE = 22;
const MAX_COMMENT = 0xffff;
/** 单个条目解压后的字节数上限：256 MiB。 */
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/** 把 Buffer | Uint8Array 统一成 Buffer（不复制已有 Buffer）。 */
function toBuffer(input) {
	if (Buffer.isBuffer(input)) return input;
	if (input instanceof Uint8Array) {
		return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
	}
	if (input instanceof ArrayBuffer) return Buffer.from(input);
	throw new Error('openZip 的参数必须是 Buffer 或 Uint8Array');
}

/** 从尾部向前找 EOCD（允许 ZIP 尾部有注释，注释最长 65535 字节）。 */
function findEocd(buf) {
	if (buf.length < EOCD_MIN_SIZE) {
		throw new Error('不是有效的 ZIP 文件：文件太小，连中央目录结束记录（EOCD）都放不下');
	}
	// OLE/CFB 容器：旧版二进制 Office（.doc/.xls/.ppt）与「加密的 Office 文件」都是这个开头，
	// 它们不是 ZIP，直接给出更有用的提示。
	if (
		buf.length > 8 &&
		buf[0] === 0xd0 &&
		buf[1] === 0xcf &&
		buf[2] === 0x11 &&
		buf[3] === 0xe0 &&
		buf[4] === 0xa1 &&
		buf[5] === 0xb1 &&
		buf[6] === 0x1a &&
		buf[7] === 0xe1
	) {
		throw new Error(
			'这不是 ZIP 格式：文件是 OLE/CFB 容器，通常是旧版二进制 Office 文档（.doc/.xls/.ppt）或设置了密码的加密 Office 文件，本工具不支持',
		);
	}
	const lowest = Math.max(0, buf.length - EOCD_MIN_SIZE - MAX_COMMENT);
	for (let i = buf.length - EOCD_MIN_SIZE; i >= lowest; i--) {
		if (buf.readUInt32LE(i) !== SIG_EOCD) continue;
		const commentLength = buf.readUInt16LE(i + 20);
		if (i + EOCD_MIN_SIZE + commentLength === buf.length) return i;
		// 命中签名但注释长度对不上：多半是注释里出现了伪签名，继续向前找。
	}
	throw new Error('不是有效的 ZIP 文件：找不到中央目录结束记录（EOCD），文件可能已损坏或不是 Office 文档');
}

/**
 * 打开一个 ZIP 缓冲区。
 * @param {Buffer|Uint8Array} buffer
 * @returns {{
 *   names(): string[],
 *   has(name: string): boolean,
 *   read(name: string): Buffer | undefined,
 *   text(name: string): string | undefined,
 *   entries(): Array<{name: string, size: number, compressedSize: number}>
 * }}
 */
export function openZip(buffer) {
	const buf = toBuffer(buffer);
	const eocd = findEocd(buf);

	const diskNumber = buf.readUInt16LE(eocd + 4);
	const cdDisk = buf.readUInt16LE(eocd + 6);
	const entriesOnDisk = buf.readUInt16LE(eocd + 8);
	const totalEntries = buf.readUInt16LE(eocd + 10);
	const cdSize = buf.readUInt32LE(eocd + 12);
	const cdOffset = buf.readUInt32LE(eocd + 16);

	// Zip64：任意关键字段取到 0xFFFF / 0xFFFFFFFF 就说明真正的值在 Zip64 结构里。
	const looksZip64 =
		totalEntries === 0xffff ||
		entriesOnDisk === 0xffff ||
		cdSize === 0xffffffff ||
		cdOffset === 0xffffffff ||
		diskNumber === 0xffff ||
		cdDisk === 0xffff;
	if (looksZip64) {
		const locator = eocd - 20;
		const hasLocator = locator >= 0 && buf.readUInt32LE(locator) === SIG_ZIP64_EOCD_LOCATOR;
		throw new Error(
			hasLocator
				? '不支持 Zip64 格式的压缩包：该 Office 文件体积超过 4 GiB 或条目数超过 65535'
				: 'ZIP 中央目录的字段超出经典 ZIP 范围，疑似 Zip64 或文件已损坏',
		);
	}
	if (diskNumber !== 0 || cdDisk !== 0 || entriesOnDisk !== totalEntries) {
		throw new Error('不支持分卷（多磁盘）的 ZIP 压缩包');
	}
	if (cdOffset + cdSize > buf.length) {
		throw new Error('ZIP 中央目录损坏：记录的偏移量超出了文件末尾');
	}

	/** @type {Map<string, {name:string, flags:number, method:number, crc:number, size:number, compressedSize:number, localOffset:number, encrypted:boolean}>} */
	const table = new Map();
	const order = [];

	let p = cdOffset;
	for (let i = 0; i < totalEntries; i++) {
		if (p + 46 > buf.length) {
			throw new Error(`ZIP 中央目录损坏：第 ${i + 1} 条记录不完整（文件被截断？）`);
		}
		if (buf.readUInt32LE(p) !== SIG_CEN) {
			throw new Error(`ZIP 中央目录损坏：第 ${i + 1} 条记录签名不正确（偏移 ${p}）`);
		}
		const flags = buf.readUInt16LE(p + 8);
		const method = buf.readUInt16LE(p + 10);
		const crc = buf.readUInt32LE(p + 16);
		const compressedSize = buf.readUInt32LE(p + 20);
		const size = buf.readUInt32LE(p + 24);
		const nameLength = buf.readUInt16LE(p + 28);
		const extraLength = buf.readUInt16LE(p + 30);
		const commentLength = buf.readUInt16LE(p + 32);
		const diskStart = buf.readUInt16LE(p + 34);
		const localOffset = buf.readUInt32LE(p + 42);
		const nameStart = p + 46;
		const nameEnd = nameStart + nameLength;
		if (nameEnd > buf.length) {
			throw new Error(`ZIP 中央目录损坏：第 ${i + 1} 条记录的文件名越界`);
		}
		const name = buf.toString('utf8', nameStart, nameEnd);

		if (
			size === 0xffffffff ||
			compressedSize === 0xffffffff ||
			localOffset === 0xffffffff ||
			diskStart === 0xffff
		) {
			throw new Error(`不支持 Zip64 条目：${name} 的体积或偏移量超出经典 ZIP 范围`);
		}
		if (diskStart !== 0) {
			throw new Error(`不支持分卷（多磁盘）的 ZIP 压缩包：条目 ${name} 位于其它磁盘`);
		}
		if (method !== METHOD_STORE && method !== METHOD_DEFLATE) {
			// 不在这里抛错：包里可能有本工具根本不会去读的条目（例如 bzip2 压缩的图片），
			// 真正读取该条目时再报错，避免整个文件因为一个无关部件而打不开。
		}
		if (size > MAX_ENTRY_BYTES) {
			throw new Error(
				`条目 ${name} 解压后需要 ${size} 字节，超过 ${MAX_ENTRY_BYTES} 字节的上限（疑似 zip 炸弹），已拒绝读取`,
			);
		}

		p = nameEnd + extraLength + commentLength;
		// 同名条目（少数工具会写重复项）以最后一条中央目录记录为准。
		if (!table.has(name)) order.push(name);
		table.set(name, {
			name,
			flags,
			method,
			crc,
			size,
			compressedSize,
			localOffset,
			encrypted: (flags & 0x1) !== 0,
		});
	}

	/** 已解压条目的缓存，避免同一部件被反复解压。 */
	const cache = new Map();

	function read(name) {
		const entry = table.get(name);
		if (!entry) return undefined;
		if (cache.has(name)) return cache.get(name);
		if (entry.encrypted) {
			throw new Error(`条目 ${name} 已加密，无法读取（本工具不支持加密的 Office 文件）`);
		}
		if (entry.method !== METHOD_STORE && entry.method !== METHOD_DEFLATE) {
			throw new Error(`条目 ${name} 使用了不支持的压缩方式（method ${entry.method}），本工具只支持 store 与 deflate`);
		}
		const lo = entry.localOffset;
		if (lo + 30 > buf.length || buf.readUInt32LE(lo) !== SIG_LOC) {
			throw new Error(`ZIP 条目 ${name} 的本地文件头损坏，无法定位数据`);
		}
		const nameLength = buf.readUInt16LE(lo + 26);
		const extraLength = buf.readUInt16LE(lo + 28);
		const dataStart = lo + 30 + nameLength + extraLength;
		const dataEnd = dataStart + entry.compressedSize;
		if (dataEnd > buf.length) {
			throw new Error(`ZIP 条目 ${name} 的数据越界，文件可能已被截断`);
		}
		const raw = buf.subarray(dataStart, dataEnd);

		let data;
		if (entry.method === METHOD_STORE) {
			data = Buffer.from(raw);
		} else {
			try {
				data = zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES });
			} catch (err) {
				throw new Error(`ZIP 条目 ${name} 解压失败：deflate 数据已损坏（${err && err.message ? err.message : err}）`);
			}
		}
		if (data.length > MAX_ENTRY_BYTES) {
			throw new Error(`条目 ${name} 解压后为 ${data.length} 字节，超过上限（疑似 zip 炸弹），已拒绝`);
		}
		// CRC 校验：中央目录里的 CRC 是权威值，对不上说明内容被改坏。
		if (typeof zlib.crc32 === 'function') {
			const actual = zlib.crc32(data) >>> 0;
			if (actual !== (entry.crc >>> 0)) {
				throw new Error(`ZIP 条目 ${name} 的 CRC 校验失败：数据已损坏`);
			}
		}
		cache.set(name, data);
		return data;
	}

	function text(name) {
		const data = read(name);
		if (data === undefined) return undefined;
		let s = data.toString('utf8');
		if (s.charCodeAt(0) === 0xfeff) s = s.slice(1); // 去掉 UTF-8 BOM
		return s;
	}

	return {
		names: () => order.slice(),
		has: (name) => table.has(name),
		read,
		text,
		entries: () =>
			order.map((name) => {
				const e = table.get(name);
				return { name: e.name, size: e.size, compressedSize: e.compressedSize };
			}),
	};
}
