import { App, normalizePath } from 'obsidian';
import type { GlossSettings, PdfMarkFile, PdfWordMark, NormalizedRect } from '../types';
import { normalizeForHash, sha256Hex } from '../cache/hash';
import { canonicalRects, overlapRatio, denormalizeRect, roundTo } from './geometry';

/**
 * Persistence and identity for word-level PDF marks. Kept apart from the
 * paragraph gloss cache (`.gloss.json`) so neither format can corrupt the other.
 */

export const MARK_FILE_VERSION = 1;

export function marksFolder(settings: GlossSettings): string {
	return settings.pdfMarkCacheFolder.trim().replace(/^\/+|\/+$/g, '');
}

export function marksPath(pdfPath: string, folder: string): string {
	const trimmed = folder.trim().replace(/^\/+|\/+$/g, '');
	const base = pdfPath.replace(/\.pdf$/i, '');
	const name = base.split('/').pop() ?? 'marks';
	const short = normalizeForHash(pdfPath).length.toString(36);
	const digest = shortHashOfPath(pdfPath);
	const fileName = `${sanitizeName(name)}-${digest}.marks.json`;
	return normalizePath(trimmed ? `${trimmed}/${fileName}` : `${base}.marks.json`);
}

function sanitizeName(name: string): string {
	return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'marks';
}

/** Deterministic short suffix so two books with the same name never collide. */
function shortHashOfPath(pdfPath: string): string {
	let hash = 2166136261;
	for (let i = 0; i < pdfPath.length; i++) {
		hash ^= pdfPath.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(36).slice(0, 6);
}

export async function markId(
	pdfPath: string,
	page: number,
	text: string,
	rects: NormalizedRect[],
	quoteBefore: string,
	quoteAfter: string,
): Promise<string> {
	const key = [
		pdfPath,
		String(page),
		normalizeForHash(text),
		canonicalRects(rects),
		normalizeForHash(quoteBefore).slice(-40),
		normalizeForHash(quoteAfter).slice(0, 40),
	].join('|');
	return (await sha256Hex(key)).slice(0, 32);
}

export interface MarkStore {
	load(pdfPath: string): Promise<PdfWordMark[]>;
	save(pdfPath: string, marks: PdfWordMark[]): Promise<void>;
	describe(pdfPath: string): string;
}

function toFile(pdfPath: string, marks: PdfWordMark[]): PdfMarkFile {
	return { version: MARK_FILE_VERSION, pdfPath, updatedAt: Date.now(), marks };
}

export function parseMarkFile(raw: string, pdfPath: string): PdfWordMark[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	const file = parsed as Partial<PdfMarkFile>;
	const list = Array.isArray(file?.marks) ? file.marks : [];
	const out: PdfWordMark[] = [];
	for (const candidate of list) {
		const mark = sanitizeMark(candidate, pdfPath);
		if (mark) out.push(mark);
	}
	return out.sort((a, b) => a.page - b.page || a.createdAt - b.createdAt);
}

export function sanitizeMark(value: unknown, pdfPath: string): PdfWordMark | null {
	if (!value || typeof value !== 'object') return null;
	const raw = value as Partial<PdfWordMark>;
	if (typeof raw.text !== 'string' || !raw.text.trim()) return null;
	if (typeof raw.translation !== 'string') return null;
	// Tolerate "10" as well as 10: hand-edited sidecars are a real thing.
	const pageRaw = (raw as { page?: unknown }).page;
	const pageNumber =
		typeof pageRaw === 'number'
			? pageRaw
			: typeof pageRaw === 'string'
				? Number.parseInt(pageRaw, 10)
				: Number.NaN;
	const page = Number.isFinite(pageNumber) && pageNumber > 0 ? Math.round(pageNumber) : 0;
	if (!page) return null;
	const rects = Array.isArray(raw.rects)
		? raw.rects.filter(
				(rect): rect is NormalizedRect =>
					Boolean(rect) &&
					[rect.x, rect.y, rect.w, rect.h].every((n) => typeof n === 'number' && Number.isFinite(n)) &&
					rect.w > 0 &&
					rect.h > 0,
		  )
		: [];
	if (!rects.length) return null;
	const now = Date.now();
	return {
		id: typeof raw.id === 'string' && raw.id ? raw.id : `legacy-${page}-${normalizeForHash(raw.text).slice(0, 12)}`,
		pdfPath,
		page,
		text: raw.text.trim(),
		translation: raw.translation.trim(),
		...(typeof raw.pos === 'string' && raw.pos.trim() ? { pos: raw.pos.trim() } : {}),
		rects: rects.map((rect) => ({
			x: roundTo(rect.x),
			y: roundTo(rect.y),
			w: roundTo(rect.w),
			h: roundTo(rect.h),
		})),
		quoteBefore: typeof raw.quoteBefore === 'string' ? raw.quoteBefore : '',
		quoteAfter: typeof raw.quoteAfter === 'string' ? raw.quoteAfter : '',
		color: raw.color === 'green' || raw.color === 'blue' || raw.color === 'pink' ? raw.color : 'yellow',
		...(raw.labelMode === 'gap' ||
		raw.labelMode === 'overlap' ||
		raw.labelMode === 'margin' ||
		raw.labelMode === 'hover' ||
		raw.labelMode === 'none'
			? { labelMode: raw.labelMode }
			: {}),
		model: typeof raw.model === 'string' ? raw.model : '',
		createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : now,
		updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : (raw.createdAt as number) ?? now,
	};
}

export class VaultMarkStore implements MarkStore {
	constructor(private app: App, private folder: string) {}

	describe(pdfPath: string): string {
		return marksPath(pdfPath, this.folder);
	}

	async load(pdfPath: string): Promise<PdfWordMark[]> {
		const path = this.describe(pdfPath);
		try {
			if (!(await this.app.vault.adapter.exists(path))) return [];
			return parseMarkFile(await this.app.vault.adapter.read(path), pdfPath);
		} catch {
			return [];
		}
	}

	async save(pdfPath: string, marks: PdfWordMark[]): Promise<void> {
		const path = this.describe(pdfPath);
		try {
			const dir = path.split('/').slice(0, -1).join('/');
			if (dir && !(await this.app.vault.adapter.exists(dir))) {
				await this.app.vault.adapter.mkdir(dir);
			}
			await this.app.vault.adapter.write(path, JSON.stringify(toFile(pdfPath, marks), null, 2));
		} catch (error) {
			console.error('[interlinear-gloss] 无法写入 PDF 标注文件', path, error);
			throw error;
		}
	}
}

const LOCAL_PREFIX = 'interlinear-gloss:pdf-marks:';

export class LocalMarkStore implements MarkStore {
	private memo = new Map<string, PdfWordMark[]>();

	constructor(private app: App) {}

	describe(pdfPath: string): string {
		return `localStorage（标注）`;
	}

	private async key(pdfPath: string): Promise<string> {
		return LOCAL_PREFIX + (await sha256Hex(pdfPath)).slice(0, 32);
	}

	async load(pdfPath: string): Promise<PdfWordMark[]> {
		const cached = this.memo.get(pdfPath);
		if (cached) return cached;
		try {
			const raw = window.localStorage.getItem(await this.key(pdfPath));
			if (!raw) return [];
			const marks = parseMarkFile(raw, pdfPath);
			this.memo.set(pdfPath, marks);
			return marks;
		} catch {
			return [];
		}
	}

	async save(pdfPath: string, marks: PdfWordMark[]): Promise<void> {
		this.memo.set(pdfPath, marks);
		try {
			window.localStorage.setItem(await this.key(pdfPath), JSON.stringify(toFile(pdfPath, marks)));
		} catch (error) {
			console.error('[interlinear-gloss] 无法写入 localStorage 标注', error);
			throw error;
		}
	}
}

export function createMarkStore(app: App, settings: GlossSettings): MarkStore {
	return settings.pdfMarkCacheInVault
		? new VaultMarkStore(app, marksFolder(settings))
		: new LocalMarkStore(app);
}

/** Existing mark at the same page/word/spot, so re-selecting never re-requests. */
export function findSameMark(
	marks: PdfWordMark[],
	page: number,
	text: string,
	rects: NormalizedRect[],
	pageSize: { width: number; height: number },
): PdfWordMark | null {
	const needle = normalizeForHash(text);
	for (const mark of marks) {
		if (mark.page !== page) continue;
		if (normalizeForHash(mark.text) !== needle) continue;
		const samePlace = mark.rects.some((mine) =>
			rects.some((incoming) => {
				const a = denormalizeRect(mine, pageSize);
				const b = denormalizeRect(incoming, pageSize);
				return overlapRatio(a, b) > 0.45;
			}),
		);
		if (samePlace) return mark;
	}
	return null;
}

/**
 * Re-anchor by text when the page re-rendered and stored rects no longer
 * match. Returns offsets in the page text, used to rebuild the rects.
 */
export function locateQuote(
	pageText: string,
	quoteBefore: string,
	word: string,
	quoteAfter: string,
): { start: number; end: number } | null {
	const text = pageText;
	if (!word.trim()) return null;
	const before = quoteBefore.trim();
	const after = quoteAfter.trim();

	const tryFind = (needle: string, anchor: string, anchorOffsetInNeedle: number): { start: number; end: number } | null => {
		if (!needle) return null;
		const index = text.indexOf(needle);
		if (index < 0) return null;
		const start = index + anchorOffsetInNeedle;
		return { start, end: start + anchor.length };
	};

	if (before && after) {
		const hit = tryFind(before + word + after, word, before.length);
		if (hit) return hit;
	}
	if (before) {
		const hit = tryFind(before + word, word, before.length);
		if (hit) return hit;
	}
	if (after) {
		const index = text.indexOf(word + after);
		if (index >= 0) return { start: index, end: index + word.length };
	}
	const solo = text.indexOf(word);
	return solo < 0 ? null : { start: solo, end: solo + word.length };
}

export function sortMarks(marks: PdfWordMark[]): PdfWordMark[] {
	return [...marks].sort((a, b) => a.page - b.page || a.createdAt - b.createdAt);
}

/**
 * Which mark sits under a point given in page-relative coordinates (0..1).
 * Used for hover tooltips, so it tolerates a couple of pixels of slop and
 * prefers the newest mark when annotations overlap.
 */
export function markAtPoint(
	marks: readonly PdfWordMark[],
	point: { x: number; y: number },
	tolerance = 0.004,
): PdfWordMark | null {
	let best: PdfWordMark | null = null;
	for (const mark of marks) {
		const inside = mark.rects.some(
			(rect) =>
				point.x >= rect.x - tolerance &&
				point.x <= rect.x + rect.w + tolerance &&
				point.y >= rect.y - tolerance &&
				point.y <= rect.y + rect.h + tolerance,
		);
		if (!inside) continue;
		if (!best || mark.updatedAt > best.updatedAt) best = mark;
	}
	return best;
}
