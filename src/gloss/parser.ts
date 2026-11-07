import type { GlossItem } from '../types';

/**
 * Tolerant parser for the `【译文】 / 【词义】` contract.
 *
 * Small local models (1.8B) frequently drift: markdown tables, bold headers,
 * full-width pipes, missing sections. The parser accepts all of that and falls
 * back to "translation only" rather than throwing the whole result away.
 */

export interface ParsedGloss {
	translation: string;
	items: GlossItem[];
	/** Machine readable hints, e.g. 'no-items' or 'unparsed-lines:3'. */
	issues: string[];
}

const TRANSLATION_HEAD = /【\s*译\s*文\s*】|\[\s*译\s*文\s*\]|译\s*文\s*[:：]/;
const ITEMS_HEAD = /【\s*(?:词\s*义|逐\s*词|词\s*表|术\s*语|词\s*汇)\s*】|\[\s*(?:词\s*义|逐\s*词)\s*\]|(?:词\s*义|逐\s*词)\s*[:：]/;

const POS_RE = /^(?:n|v|vt|vi|adj|adv|prep|conj|pron|art|num|interj|phr|aux|abbr)\.?$/i;

/** Models sometimes answer the part of speech in Chinese. */
const POS_ZH: Record<string, string> = {
	名词: 'n.',
	动词: 'v.',
	形容词: 'adj.',
	副词: 'adv.',
	介词: 'prep.',
	连词: 'conj.',
	代词: 'pron.',
	冠词: 'art.',
	数词: 'num.',
	感叹词: 'interj.',
	短语: 'phr.',
	词组: 'phr.',
	变量: 'n.',
};

function normalizePos(value: string): string {
	const text = value.trim().replace(/[.。]$/, '');
	if (POS_RE.test(text)) return `${text.toLowerCase()}.`;
	const zh = POS_ZH[text] ?? POS_ZH[value.trim()];
	return zh ?? value.trim();
}

function isPos(value: string): boolean {
	const text = value.trim();
	if (POS_RE.test(text)) return true;
	return Boolean(POS_ZH[text.replace(/[.。]$/, '')]);
}

const HEADER_CELLS = new Set([
	'单词', '词语', '词', '短语', 'word', 'words', 'term', 'terms', 'source',
	'词性', 'pos', 'part of speech',
	'释义', '中文', '意思', 'meaning', 'translation', 'target', '中文释义',
]);

function normalizeRaw(raw: string): string {
	let text = (raw ?? '').replace(/\r\n?/g, '\n').trim();
	// Whole response wrapped in a code fence.
	const fenced = text.match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```$/);
	if (fenced) text = fenced[1].trim();
	// Strip zero-width and BOM characters that break header matching.
	text = text.replace(/[\u200b-\u200d\ufeff]/g, '');
	return text;
}

function cleanInline(value: string): string {
	return value
		.replace(/^\s*[-*+•]\s+/, '')
		.replace(/^\s*\d+[.)、]\s+/, '')
		.replace(/\*\*|__/g, '')
		.replace(/^`|`$/g, '')
		.replace(/^["'“”‘’「」『』]+|["'“”‘’「」『』]+$/g, '')
		.trim();
}

function isSeparatorRow(cells: string[]): boolean {
	if (!cells.length) return false;
	return cells.every((cell) => /^:?-{2,}:?$/.test(cell.trim()));
}

function isHeaderRow(cells: string[]): boolean {
	if (!cells.length) return false;
	const known = cells.filter((cell) => HEADER_CELLS.has(cell.trim().toLowerCase()));
	return known.length >= Math.min(2, cells.length);
}

function splitCells(line: string): string[] | null {
	if (/[|｜]/.test(line)) {
		const parts = line.split(/[|｜]/).map((part) => part.trim());
		if (parts[0] === '') parts.shift();
		if (parts.length && parts[parts.length - 1] === '') parts.pop();
		return parts.length >= 2 ? parts : null;
	}
	// `journey : n. : 旅程` — a colon surrounded by whitespace can stand in for
	// a pipe; `journey: 旅程` is left to parseSingleCell.
	if (/\s[:：]\s/.test(line)) {
		const parts = line
			.split(/\s+[:：]\s+/)
			.map((part) => part.trim())
			.filter(Boolean);
		return parts.length >= 2 ? parts : null;
	}
	// `chapters —— n. —— 章节`: a long dash is a column separator too.
	if (/\s+(?:—{1,3}|–{2,}|-{2,})\s+/.test(line)) {
		const parts = line
			.split(/\s+(?:—{1,3}|–{2,}|-{2,})\s+/)
			.map((part) => part.trim())
			.filter(Boolean);
		return parts.length >= 2 ? parts : null;
	}
	return null;
}

function parseSingleCell(line: string): GlossItem | null {
	const text = cleanInline(line);
	if (!text) return null;

	// journey（n.）旅程 / journey (n.) 旅程
	const paren = text.match(/^(.+?)\s*[（(]\s*([a-z.]{1,12})\s*[)）]\s*(.+)$/i);
	if (paren) {
		return { source: cleanInline(paren[1]), pos: paren[2].trim(), target: cleanInline(paren[3]) };
	}

	// journey n. 旅程
	const spaced = text.match(/^(.+?)\s+([a-z]{1,6}\.)\s+(.+)$/i);
	if (spaced && POS_RE.test(spaced[2])) {
		return { source: cleanInline(spaced[1]), pos: spaced[2].trim(), target: cleanInline(spaced[3]) };
	}

	// journey: 旅程
	const colon = text.match(/^(.+?)\s*[:：]\s*(.+)$/);
	if (colon) {
		return { source: cleanInline(colon[1]), target: cleanInline(colon[2]) };
	}

	// journey   旅程 (two or more spaces)
	const wide = text.match(/^(.+?)\s{2,}(.+)$/);
	if (wide) {
		return { source: cleanInline(wide[1]), target: cleanInline(wide[2]) };
	}

	return null;
}

function rowsToItems(block: string, maxItems: number): { items: GlossItem[]; unparsed: number } {
	const items: GlossItem[] = [];
	const seen = new Set<string>();
	let unparsed = 0;

	for (const rawLine of block.split(/\n|<br\s*\/?>/i)) {
		const line = rawLine.trim();
		if (!line) continue;
		if (/^```/.test(line)) continue;

		const cells = splitCells(line);
		let item: GlossItem | null = null;

		if (cells) {
			if (isSeparatorRow(cells) || isHeaderRow(cells)) continue;
			// `state | n. 状态`: the model merged part of speech and meaning.
			const expanded: string[] = [];
			for (const cell of cells) {
				const merged = cell.match(/^([a-z]{1,6}\.)\s*(.+)$/i);
				if (merged && POS_RE.test(merged[1]) && expanded.length > 0) {
					expanded.push(merged[1], merged[2]);
				} else {
					expanded.push(cell);
				}
			}
			const cols = expanded.length > cells.length ? expanded : cells;
			if (cols.length >= 2 && cols[0]) {
				const source = cleanInline(cols[0]);
				if (cols.length >= 3) {
					const second = cols[1].trim();
					const third = cols[2].trim();
					if (isPos(second)) {
						item = {
							source,
							pos: normalizePos(second),
							target: cleanInline(cols.slice(2).join(' ')),
						};
					} else if (isPos(third)) {
						item = { source, target: cleanInline(second), pos: normalizePos(third) };
					} else {
						item = { source, target: cleanInline(cols.slice(1).join(' ')) };
					}
				} else {
					const target = cleanInline(cols[1]);
					item = isPos(target) ? { source, target: '', pos: normalizePos(target) } : { source, target };
				}
			}
		} else {
			item = parseSingleCell(line);
		}

		if (!item) {
			if (line.length > 2) unparsed += 1;
			continue;
		}

		// Numbered/bulleted rows are formatting noise from small models
		// ("1. journey | n. | 旅程").
		let source = item.source
			.trim()
			.replace(/^(?:\d+[.)、]\s*|[-*•]\s*)/, '')
			.trim();
		// The model sometimes repeats the part of speech inside the source cell:
		// `begin n. | v. | 开始` or `bandit n. / v. | n. | 抢劫犯`.
		const POS_TOKEN = '(?:n|v|vt|vi|adj|adv|prep|conj|pron|art|num|interj|phr|aux)\\.';
		const posTail = source.match(
			new RegExp(`^(.*\\S)\\s+(${POS_TOKEN}(?:\\s*[/、]\\s*${POS_TOKEN})*)$`, 'i'),
		);
		let pos = item.pos;
		if (posTail && posTail[1]) {
			source = posTail[1].trim();
			if (!pos) pos = normalizePos(posTail[2].split(/[/、]/)[0]);
		} else {
			// A trailing sentence period is noise too ("journey.").
			source = source.replace(/[.,;:!?。、)）]+$/, '').trim();
		}
		const target = (item.target ?? '').trim();
		if (!source || source.length > 80) {
			unparsed += 1;
			continue;
		}
		// Single letters, formulas and stray symbols are noise, not glossary rows.
		if (!/^[A-Za-z][A-Za-z'’\-\s]*$/.test(source) || source.replace(/\s/g, '').length < 2) {
			unparsed += 1;
			continue;
		}
		if (!target && !pos) {
			unparsed += 1;
			continue;
		}

		const key = source.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		items.push({ source, target, ...(pos ? { pos } : {}) });
		if (items.length >= maxItems) break;
	}

	return { items, unparsed };
}

/**
 * Last-resort recovery for the glossary pass: we asked for a fixed list of
 * words, so find each word's line and take its Chinese cell, whatever shape
 * the model produced (`begin / v. |  | 开始`, `map | n.指引图`, `<br>` joins).
 */
export function recoverCandidateItems(
	raw: string,
	candidates: readonly string[],
	maxItems = 30,
): GlossItem[] {
	const lines = raw
		.split(/\n|<br\s*\/?>/i)
		.map((line) => line.trim())
		.filter(Boolean);
	const used = new Set<number>();
	const out: GlossItem[] = [];

	for (const candidate of candidates) {
		const needle = candidate.toLowerCase();
		const index = lines.findIndex((line, position) => {
			if (used.has(position)) return false;
			const words: string[] = line.toLowerCase().match(/[a-z][a-z'’\-]*/g) ?? [];
			return words.includes(needle);
		});
		if (index < 0) continue;

		const line = lines[index];
		used.add(index);
		let cells = line.split(/[|｜]/).map((cell) => cell.trim());
		if (cells.length < 2) {
			cells = line.split(/\s+\/\s+|\s{2,}|\t/).map((cell) => cell.trim());
		}
		const meanings = cells.filter(
			(cell) =>
				/[\u4e00-\u9fff]/.test(cell) &&
				!POS_RE.test(cell.replace(/[.。]$/, '').trim()) &&
				cell.length <= 24 &&
				!/[。；]$/.test(cell),
		);
		if (!meanings.length) continue;
		const target = meanings.sort((a, b) => a.length - b.length)[0];
		const posMatch = line.match(
			/(?:^|[\s|｜/])((?:n|v|vt|vi|adj|adv|prep|conj|pron|art|num|interj|phr|aux))\.(?=$|[\s|｜/])/i,
		);
		out.push({
			source: candidate,
			target,
			...(posMatch ? { pos: normalizePos(posMatch[1]) } : {}),
		});
		if (out.length >= maxItems) break;
	}

	return out;
}

/**
 * Small models like to echo the prompt template ("（这里写原文的中文译文）",
 * "<整段中文译文>"). Strip those leading placeholders before keeping the rest.
 */
const PLACEHOLDER_LINE =
	/^[<〈《（(【\[]\s*[^<>〈〉《》（）()【】\[\]\n]{0,40}译文[^<>〈〉《》（）()【】\[\]\n]{0,40}[>〉》”）)】\]]\s*$/;

function stripTemplateEcho(value: string): string {
	let text = value.trim();
	for (let guard = 0; guard < 3; guard++) {
		const match = text.match(/^([^\n]*)\n([\s\S]*)$/);
		if (!match) break;
		if (!PLACEHOLDER_LINE.test(match[1].trim())) break;
		text = match[2].trim();
	}
	text = text.replace(/^[<〈]\s*[^<〈>\n]{0,20}译文\s*[>〉]\s*/, '');
	text = text.replace(/^（\s*[^（）\n]{0,30}译文[^（）\n]{0,30}）\s*/, '');
	return text;
}

function cleanupTranslation(value: string): string {
	let text = stripTemplateEcho(value);
	text = text.replace(/^\s*[:：]\s*/, '');
	text = text.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '');
	text = text.replace(/^\*\*(.*?)\*\*$/s, '$1');
	text = text.replace(/\n{3,}/g, '\n\n');
	return text.trim();
}

/** Pull trailing pipe rows out of a translation section. */
function splitTrailingTable(section: string): { prose: string; table: string } {
	const lines = section.split('\n');
	let firstPipe = -1;
	for (let i = 0; i < lines.length; i++) {
		if (/[|｜]/.test(lines[i]) && lines[i].trim().length > 2) {
			firstPipe = i;
			break;
		}
	}
	if (firstPipe < 0) return { prose: section, table: '' };
	return {
		prose: lines.slice(0, firstPipe).join('\n'),
		table: lines.slice(firstPipe).join('\n'),
	};
}

export interface ParseOptions {
	maxItems?: number;
}

export function parseGlossResponse(raw: string, options: ParseOptions = {}): ParsedGloss {
	const maxItems = Math.max(1, Math.min(80, options.maxItems ?? 30));
	const text = normalizeRaw(raw);
	const issues: string[] = [];

	if (!text) {
		return { translation: '', items: [], issues: ['empty-response'] };
	}

	const translationMatch = TRANSLATION_HEAD.exec(text);
	const itemsMatch = ITEMS_HEAD.exec(text);

	let translation = '';
	let itemsBlock = '';

	if (translationMatch && itemsMatch) {
		if (translationMatch.index < itemsMatch.index) {
			translation = text.slice(translationMatch.index + translationMatch[0].length, itemsMatch.index);
			itemsBlock = text.slice(itemsMatch.index + itemsMatch[0].length);
		} else {
			itemsBlock = text.slice(itemsMatch.index + itemsMatch[0].length, translationMatch.index);
			translation = text.slice(translationMatch.index + translationMatch[0].length);
			issues.push('sections-reversed');
		}
	} else if (translationMatch) {
		translation = text.slice(translationMatch.index + translationMatch[0].length);
		const split = splitTrailingTable(translation);
		translation = split.prose;
		itemsBlock = split.table;
		issues.push('missing-items-header');
	} else if (itemsMatch) {
		translation = text.slice(0, itemsMatch.index);
		itemsBlock = text.slice(itemsMatch.index + itemsMatch[0].length);
		issues.push('missing-translation-header');
	} else {
		const split = splitTrailingTable(text);
		if (split.table) {
			translation = split.prose;
			itemsBlock = split.table;
			issues.push('no-headers');
		} else if (rowsToItems(text, maxItems).items.length) {
			// The glossary pass has no headers at all: the rows are the response.
			itemsBlock = text;
			issues.push('no-headers');
		} else {
			translation = text;
			issues.push('no-headers-no-table');
		}
	}

	translation = cleanupTranslation(translation);
	if (!translation) issues.push('empty-translation');

	let items: GlossItem[] = [];
	if (itemsBlock.trim()) {
		const parsed = rowsToItems(itemsBlock, maxItems);
		items = parsed.items;
		if (parsed.unparsed > 0) issues.push(`unparsed-lines:${parsed.unparsed}`);
		if (!items.length) issues.push('empty-items');
	} else {
		issues.push('no-items-block');
	}

	return { translation, items, issues };
}

/**
 * True when the response is usable. A plain paragraph with neither headers nor
 * rows means the model ignored the contract, so the caller retries once.
 */
export function parseSucceeded(parsed: ParsedGloss): boolean {
	if (!parsed.translation.trim()) return false;
	if (parsed.issues.includes('no-headers-no-table')) return false;
	return true;
}
