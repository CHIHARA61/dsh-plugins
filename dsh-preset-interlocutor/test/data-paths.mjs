/**
 * 测试素材的定位。
 *
 * 素材（生成的 Office 样本、下载/转换来的 PDF 语料）刻意**不进仓库**，它们放在工作区的
 * `_research/` 下。而插件有两份副本（工作区里被 link 安装的那份、`dsh-plugins/` 仓库里
 * 的那份），它们的上一级目录不同，所以这里从插件目录向上找 `_research/`，并允许用环境变量
 * `DSH_PLUGIN_TEST_DATA` 直接指定。
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const MARKERS = ['doc-fixtures', 'pdf-corpus', 'sources'];

/**
 * @param pluginDir 插件包根目录
 * @returns `_research` 目录（找不到时返回默认猜测，调用方据此打印提示）
 */
export function findResearchDir(pluginDir) {
	const override = process.env.DSH_PLUGIN_TEST_DATA;
	if (override !== undefined && override.trim() !== '') return resolve(override.trim());
	let dir = pluginDir;
	for (let depth = 0; depth < 4; depth += 1) {
		const candidate = join(dir, '_research');
		if (MARKERS.some((marker) => existsSync(join(candidate, marker)))) return candidate;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return join(dirname(pluginDir), '_research');
}
