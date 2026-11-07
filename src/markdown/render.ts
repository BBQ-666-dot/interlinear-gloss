import type { GlossBlockData, GlossItem } from '../types';
import { parseGlossBlockJson } from './blocks';

export interface RenderCallbacks {
	onRegenerate?: () => void;
	onRemove?: () => void;
	onCopy?: () => void;
}

const POS_LABEL: Record<string, string> = {
	n: 'n.',
	v: 'v.',
	adj: 'adj.',
	adv: 'adv.',
	prep: 'prep.',
	conj: 'conj.',
	pron: 'pron.',
	det: 'det.',
	phr: '短语',
	phrase: '短语',
};

function prettyDate(ts: number): string {
	try {
		return new Date(ts).toLocaleString('zh-CN', { hour12: false });
	} catch {
		return '';
	}
}

function renderHeader(container: HTMLElement, data: GlossBlockData): void {
	const head = container.createDiv({ cls: 'ig-head' });
	head.createSpan({ cls: 'ig-title', text: '词义对照' });
	const bits = [data.model];
	if (data.meta?.chunks && data.meta.chunks > 1) bits.push(`${data.meta.chunks} 段`);
	if (data.createdAt) bits.push(prettyDate(data.createdAt));
	head.createSpan({ cls: 'ig-meta', text: bits.filter(Boolean).join(' · ') });
}

function renderTable(container: HTMLElement, items: GlossItem[]): void {
	const table = container.createEl('table', { cls: 'ig-table' });
	const thead = table.createEl('thead');
	const headRow = thead.createEl('tr');
	for (const label of ['单词 / 短语', '词性', '释义']) {
		headRow.createEl('th', { text: label });
	}
	const tbody = table.createEl('tbody');
	for (const item of items) {
		const row = tbody.createEl('tr');
		const source = row.createEl('td', { cls: 'ig-src' });
		source.createSpan({ text: item.source });
		row.createEl('td', { cls: 'ig-pos', text: POS_LABEL[(item.pos ?? '').toLowerCase()] ?? item.pos ?? '—' });
		const target = row.createEl('td', { cls: 'ig-dst' });
		target.createSpan({ text: item.target });
		if (item.note) target.createSpan({ cls: 'ig-note', text: `（${item.note}）` });
	}
}

interface Token {
	text: string;
	word: boolean;
}

function segmentWords(text: string): Token[] {
	const tokens: Token[] = [];
	const Segmenter = (Intl as unknown as { Segmenter?: new (locale?: string, opts?: object) => { segment(input: string): Iterable<{ segment: string; isWordLike?: boolean }> } }).Segmenter;
	if (typeof Segmenter === 'function') {
		const seg = new Segmenter('en', { granularity: 'word' });
		for (const part of seg.segment(text)) {
			tokens.push({ text: part.segment, word: Boolean(part.isWordLike) });
		}
		return tokens;
	}
	const re = /[A-Za-z][A-Za-z'-]*|\s+|./gu;
	let match: RegExpExecArray | null;
	while ((match = re.exec(text)) !== null) {
		tokens.push({ text: match[0], word: /[A-Za-z]/.test(match[0]) });
	}
	return tokens;
}

function lookup(itemMap: Map<string, GlossItem>, raw: string): GlossItem | undefined {
	const cleaned = raw.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
	if (!cleaned) return undefined;
	const direct = itemMap.get(cleaned);
	if (direct) return direct;
	// Light stemming so "chapters" still hits "chapter".
	const stem = cleaned.replace(/(ies)$/, 'y').replace(/(es|s)$/, '');
	return itemMap.get(stem);
}

function renderInterlinear(container: HTMLElement, data: GlossBlockData): void {
	const itemMap = new Map<string, GlossItem>();
	for (const item of data.items) itemMap.set(item.source.toLowerCase(), item);

	const wrap = container.createDiv({ cls: 'ig-interlinear' });
	const tokens = segmentWords(data.sourceText);
	for (const token of tokens) {
		if (!token.word) {
			wrap.createSpan({ cls: 'ig-gap', text: token.text });
			continue;
		}
		const tokenEl = wrap.createSpan({ cls: 'ig-token' });
		tokenEl.createSpan({ cls: 'ig-en', text: token.text });
		const hit = lookup(itemMap, token.text);
		if (hit) {
			tokenEl.addClass('ig-hit');
			tokenEl.createSpan({ cls: 'ig-zh', text: hit.target });
		}
	}
}

function renderWarnings(container: HTMLElement, data: GlossBlockData): void {
	const warnings = data.meta?.warnings ?? [];
	if (!warnings.length) return;
	const box = container.createDiv({ cls: 'ig-warn' });
	box.createSpan({ text: '⚠ ' });
	box.createSpan({ text: warnings.join('；') });
}

function renderActions(container: HTMLElement, callbacks: RenderCallbacks): void {
	if (!callbacks.onRegenerate && !callbacks.onRemove && !callbacks.onCopy) return;
	const bar = container.createDiv({ cls: 'ig-actions' });
	const add = (label: string, cls: string, handler?: () => void) => {
		if (!handler) return;
		const button = bar.createEl('button', { cls: `ig-btn ${cls}`, text: label });
		button.addEventListener('click', (event) => {
			event.preventDefault();
			event.stopPropagation();
			handler();
		});
	};
	add('重新生成', 'ig-btn-regen', callbacks.onRegenerate);
	add('复制', 'ig-btn-copy', callbacks.onCopy);
	add('删除', 'ig-btn-remove', callbacks.onRemove);
}

/** Source + translation + keywords (or interlinear tokens). Shared with the PDF sidebar. */
export function renderGlossContent(
	container: HTMLElement,
	data: GlossBlockData,
	options: { showSource?: boolean; compact?: boolean } = {},
): void {
	const showSource = options.showSource ?? true;
	if (showSource && data.sourceText) {
		const sourceBox = container.createDiv({ cls: 'ig-source' });
		sourceBox.createSpan({ cls: 'ig-label', text: '原文 ' });
		sourceBox.createSpan({ cls: 'ig-source-text', text: data.sourceText });
	}

	if (data.translation) {
		const translation = container.createDiv({ cls: 'ig-translation' });
		translation.createSpan({ cls: 'ig-label', text: '译文 ' });
		translation.createSpan({ cls: 'ig-translation-text', text: data.translation });
	} else {
		container.createDiv({ cls: 'ig-warn', text: '⚠ 这次没有拿到译文，可以点「重新生成」再试一次。' });
	}

	if (data.mode === 'strict') {
		renderInterlinear(container, data);
	} else if (data.items.length) {
		const tableWrap = container.createDiv({
			cls: options.compact ? 'ig-table-wrap is-compact' : 'ig-table-wrap',
		});
		renderTable(tableWrap, data.items);
	} else {
		container.createDiv({ cls: 'ig-empty', text: '没有提取到关键词。' });
	}

	renderWarnings(container, data);
}

/** Render a ```gloss fenced block into the reading view. */
export function renderGlossBlock(
	el: HTMLElement,
	source: string,
	callbacks: RenderCallbacks = {},
): void {
	el.empty();
	el.addClass('ig-host');

	const data = parseGlossBlockJson(source);
	if (!data) {
		const box = el.createDiv({ cls: 'ig-error' });
		box.createDiv({ cls: 'ig-error-title', text: '词义块解析失败' });
		box.createDiv({
			cls: 'ig-error-body',
			text: '这段内容不是有效的 Interlinear Gloss 数据。可以用「Regenerate gloss」重写，或直接删掉这个块。',
		});
		const pre = box.createEl('pre', { cls: 'ig-error-raw' });
		pre.setText(rawExcerpt(source));
		return;
	}

	const card = el.createDiv({ cls: 'ig-card' });
	renderHeader(card, data);
	renderGlossContent(card, data);
	renderActions(card, callbacks);
}

function rawExcerpt(source: string): string {
	const text = source.trim();
	return text.length > 1200 ? `${text.slice(0, 1200)}\n…` : text;
}

/** Plain markdown rendering used by the portable mode (no plugin required to read it). */
export function glossToMarkdown(data: GlossBlockData, startMarker: string, endMarker: string): string {
	const lines: string[] = [startMarker, `**译文**：${data.translation || '（未生成）'}`, ''];
	if (data.items.length) {
		lines.push('| 单词 / 短语 | 词性 | 释义 |', '| --- | --- | --- |');
		for (const item of data.items) {
			const pos = POS_LABEL[(item.pos ?? '').toLowerCase()] ?? item.pos ?? '';
			lines.push(`| ${escapeCell(item.source)} | ${escapeCell(pos)} | ${escapeCell(item.target)} |`);
		}
	}
	lines.push(endMarker);
	return lines.join('\n');
}

function escapeCell(value: string): string {
	return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
