import type { GlossBlockData, GlossItem, GlossMode } from '../types';
import { normalizeForHash } from '../cache/hash';

/**
 * Pure text helpers for locating / inserting / replacing ```gloss blocks.
 * Kept free of Obsidian APIs so they can be unit tested in Node.
 */

export const GLOSS_FENCE_OPEN = /^\s{0,3}```+\s*gloss\s*$/i;
const FENCE_CLOSE = /^\s{0,3}```+\s*$/;

export interface BlockSpan {
	startLine: number;
	endLine: number;
	source: string;
	data: GlossBlockData | null;
}

export function makeGlossBlock(data: GlossBlockData): string {
	return ['```gloss', JSON.stringify(data, null, 2), '```'].join('\n');
}

function isMode(value: unknown): value is GlossMode {
	return value === 'keywords' || value === 'strict' || value === 'portable';
}

function sanitizeItem(raw: unknown): GlossItem | null {
	if (!raw || typeof raw !== 'object') return null;
	const item = raw as Record<string, unknown>;
	const source = typeof item.source === 'string' ? item.source : '';
	const target = typeof item.target === 'string' ? item.target : '';
	if (!source) return null;
	const out: GlossItem = { source, target };
	if (typeof item.pos === 'string' && item.pos) out.pos = item.pos;
	if (typeof item.note === 'string' && item.note) out.note = item.note;
	return out;
}

export function parseGlossBlockJson(source: string): GlossBlockData | null {
	const trimmed = source.trim();
	if (!trimmed) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== 'object') return null;
	const raw = parsed as Record<string, unknown>;
	if (raw.version !== 1) return null;
	if (typeof raw.sourceText !== 'string' || typeof raw.translation !== 'string') return null;
	const items = Array.isArray(raw.items)
		? raw.items.map(sanitizeItem).filter((item): item is GlossItem => item !== null)
		: [];
	return {
		version: 1,
		sourceText: raw.sourceText,
		translation: raw.translation,
		items,
		mode: isMode(raw.mode) ? raw.mode : 'keywords',
		model: typeof raw.model === 'string' ? raw.model : 'unknown',
		createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
		meta: raw.meta && typeof raw.meta === 'object' ? (raw.meta as GlossBlockData['meta']) : undefined,
	};
}

export function findGlossBlocks(lines: string[]): BlockSpan[] {
	const blocks: BlockSpan[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (!GLOSS_FENCE_OPEN.test(lines[i])) continue;
		let end = -1;
		for (let j = i + 1; j < lines.length; j++) {
			if (FENCE_CLOSE.test(lines[j])) {
				end = j;
				break;
			}
		}
		if (end < 0) break;
		const source = lines.slice(i + 1, end).join('\n');
		blocks.push({ startLine: i, endLine: end, source, data: parseGlossBlockJson(source) });
		i = end;
	}
	return blocks;
}

/** Nearest gloss block at or below `anchorLine` (optionally also above). */
export function findGlossBlockNear(
	lines: string[],
	anchorLine: number,
	forward = 120,
	backward = 0,
): BlockSpan | null {
	const blocks = findGlossBlocks(lines);
	const start = Math.max(0, anchorLine - backward);
	const end = Math.min(lines.length - 1, anchorLine + forward);
	for (const block of blocks) {
		if (block.startLine >= start && block.startLine <= end) return block;
	}
	return null;
}

export function findBlockAtLine(lines: string[], line: number): BlockSpan | null {
	const blocks = findGlossBlocks(lines);
	for (const block of blocks) {
		if (line >= block.startLine && line <= block.endLine) return block;
	}
	return null;
}

/** Next non-empty line index after `line`, or -1. */
function nextContentLine(lines: string[], line: number): number {
	for (let i = line + 1; i < lines.length; i++) {
		if (lines[i].trim()) return i;
	}
	return -1;
}

/** True when a block for the same source already sits right below the paragraph. */
export function findDuplicateBlock(
	lines: string[],
	anchorLine: number,
	sourceText: string,
	lookahead = 20,
): BlockSpan | null {
	const key = normalizeForHash(sourceText);
	for (const block of findGlossBlocks(lines)) {
		if (block.startLine <= anchorLine) continue;
		if (block.startLine > anchorLine + lookahead) break;
		if (!block.data) continue;
		if (normalizeForHash(block.data.sourceText) === key) return block;
	}
	return null;
}

export function insertBlockIntoText(text: string, anchorLine: number, block: string): string {
	const lines = text.split('\n');
	const before = lines.slice(0, anchorLine + 1);
	let after = lines.slice(anchorLine + 1);
	while (after.length && after[0].trim() === '') after = after.slice(1);
	return [...before, '', ...block.split('\n'), '', ...after].join('\n');
}

export function replaceBlockInText(text: string, span: BlockSpan, block: string): string {
	const lines = text.split('\n');
	const next = lines.slice();
	next.splice(span.startLine, span.endLine - span.startLine + 1, ...block.split('\n'));
	return next.join('\n');
}

export function removeBlockFromText(text: string, span: BlockSpan): string {
	const lines = text.split('\n');
	const out = [...lines.slice(0, span.startLine), ...lines.slice(span.endLine + 1)];
	// Collapse the blank line the block left behind.
	const junction = span.startLine;
	if (
		junction > 0 &&
		junction < out.length &&
		out[junction - 1].trim() === '' &&
		out[junction].trim() === ''
	) {
		out.splice(junction, 1);
	}
	return out.join('\n');
}

/** Offset → zero based line index. */
export function offsetToLine(text: string, offset: number): number {
	let line = 0;
	const limit = Math.min(offset, text.length);
	for (let i = 0; i < limit; i++) {
		if (text.charCodeAt(i) === 10) line++;
	}
	return line;
}

export function lineToOffset(text: string, line: number): number {
	if (line <= 0) return 0;
	let current = 0;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 10) {
			current++;
			if (current === line) return i + 1;
		}
	}
	return text.length;
}

/** Locate a selection inside the note source (reading-view fallback). */
export function locateTextInSource(source: string, needle: string): { start: number; end: number } | null {
	const trimmed = needle.trim();
	if (!trimmed) return null;
	const direct = source.indexOf(trimmed);
	if (direct >= 0) return { start: direct, end: direct + trimmed.length };
	// Whitespace-normalized search for rendered text coming from the preview.
	const flatSource = source.replace(/\s+/g, ' ');
	const flatNeedle = trimmed.replace(/\s+/g, ' ');
	const flatIndex = flatSource.indexOf(flatNeedle);
	if (flatIndex < 0) return null;
	// Walk the original text counting characters, ignoring collapsed whitespace.
	let sourceIndex = 0;
	let flatCount = 0;
	while (sourceIndex < source.length && flatCount < flatIndex) {
		if (/\s/.test(source[sourceIndex])) {
			while (sourceIndex < source.length && /\s/.test(source[sourceIndex])) sourceIndex++;
			flatCount++;
		} else {
			sourceIndex++;
			flatCount++;
		}
	}
	return { start: sourceIndex, end: Math.min(source.length, sourceIndex + flatNeedle.length) };
}

export function nextContentLineIndex(lines: string[], line: number): number {
	return nextContentLine(lines, line);
}

/* ------------------------------------------------------------------ */
/* Portable blocks: plain markdown wrapped in invisible HTML comments. */
/* ------------------------------------------------------------------ */

export const PORTABLE_START = /^\s*<!--\s*ig-gloss:([A-Za-z0-9_-]+)\s*-->\s*$/;
export const PORTABLE_END = /^\s*<!--\s*\/ig-gloss\s*-->\s*$/;

export interface PortableSpan {
	startLine: number;
	endLine: number;
	hash: string;
}

export function portableMarkers(hash: string): { start: string; end: string } {
	return { start: `<!-- ig-gloss:${hash} -->`, end: '<!-- /ig-gloss -->' };
}

export function findPortableBlocks(lines: string[]): PortableSpan[] {
	const spans: PortableSpan[] = [];
	for (let i = 0; i < lines.length; i++) {
		const startMatch = PORTABLE_START.exec(lines[i]);
		if (!startMatch) continue;
		let end = -1;
		for (let j = i + 1; j < lines.length; j++) {
			if (PORTABLE_END.test(lines[j])) {
				end = j;
				break;
			}
			if (PORTABLE_START.test(lines[j])) break;
		}
		if (end < 0) break;
		spans.push({ startLine: i, endLine: end, hash: startMatch[1] });
		i = end;
	}
	return spans;
}

export function findPortableNear(
	lines: string[],
	anchorLine: number,
	lookahead = 60,
	backward = 0,
): PortableSpan | null {
	const start = Math.max(0, anchorLine - backward);
	const end = Math.min(lines.length - 1, anchorLine + lookahead);
	for (const span of findPortableBlocks(lines)) {
		if (span.startLine >= start && span.startLine <= end) return span;
	}
	return null;
}

