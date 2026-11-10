import type { MarkLabelMode, NormalizedRect } from '../types';

/**
 * Pure geometry for PDF word marks: page-relative normalisation, line-gap
 * estimation, label placement and collision resolution. No DOM here so the
 * whole thing is unit-testable in Node.
 */

export interface BoxSize {
	width: number;
	height: number;
}

export interface PixelRect {
	left: number;
	top: number;
	width: number;
	height: number;
}

export interface LabelAnchor {
	/** Word rect on the last selected line, in page-relative CSS px. */
	left: number;
	right: number;
	top: number;
	bottom: number;
	pageWidth: number;
	pageHeight: number;
}

export interface LabelPlan {
	left: number;
	top: number;
	width: number;
	height: number;
	fontSize: number;
	mode: MarkLabelMode;
	hidden: boolean;
}

export interface PlanOptions {
	anchor: LabelAnchor;
	/** Empty space between the word's line and the next line, in px. */
	gap: number;
	/** Width of the label text measured at `baseFontSize`, padding excluded. */
	textWidth: number;
	baseFontSize: number;
	/** Body-text size of the page in CSS px; the label tracks it. */
	pageFontSize?: number;
	fontScale: number;
	mode: MarkLabelMode;
}

/** Labels never shrink below this — smaller than 9px the text turns to mush. */
export const MIN_FONT_PX = 9;
export const MAX_FONT_PX = 15;
/** Horizontal padding per side, mirrored by `.ig-pdf-label` in styles.css. */
export const LABEL_PAD_X = 3;
/** Line-height factor, mirrored by `.ig-pdf-label` in styles.css. */
export const LABEL_LINE_HEIGHT = 1.05;
/** How far an overlap label may dip into the next line, in px. */
export const OVERLAP_DIP = 1;
/** Horizontal breathing room kept from the page edges. */
const EDGE_PAD = 2;


export function clamp(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.min(max, Math.max(min, value));
}

export function roundTo(value: number, digits = 4): number {
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}

export function normalizeRect(rect: PixelRect, pageLeft: number, pageTop: number, page: BoxSize): NormalizedRect {
	const width = page.width || 1;
	const height = page.height || 1;
	return {
		x: roundTo((rect.left - pageLeft) / width),
		y: roundTo((rect.top - pageTop) / height),
		w: roundTo(rect.width / width),
		h: roundTo(rect.height / height),
	};
}

export function normalizeRects(rects: PixelRect[], pageLeft: number, pageTop: number, page: BoxSize): NormalizedRect[] {
	return rects
		.filter((rect) => rect.width > 0.5 && rect.height > 0.5)
		.map((rect) => normalizeRect(rect, pageLeft, pageTop, page));
}

/**
 * pdf.js often returns several rects per line (one per span, plus inline math).
 * Painting each one at 35% opacity produces the stacked/striped highlight seen
 * on whole-sentence marks. Union all rects whose centers sit on the same line.
 */
export function mergeLineRects(rects: NormalizedRect[]): NormalizedRect[] {
	if (rects.length < 2) return rects.map((rect) => ({ ...rect }));
	const heights = rects.map((rect) => rect.h).sort((a, b) => a - b);
	const medianHeight = heights[Math.floor(heights.length / 2)] || 0.01;
	const tolerance = Math.max(0.004, medianHeight * 0.6);
	const groups: Array<{ rect: NormalizedRect; center: number }> = [];

	for (const rect of [...rects].sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2) || a.x - b.x)) {
		const center = rect.y + rect.h / 2;
		const group = groups.find((item) => Math.abs(item.center - center) <= tolerance);
		if (!group) {
			groups.push({ rect: { ...rect }, center });
			continue;
		}
		const right = Math.max(group.rect.x + group.rect.w, rect.x + rect.w);
		const bottom = Math.max(group.rect.y + group.rect.h, rect.y + rect.h);
		group.rect.x = Math.min(group.rect.x, rect.x);
		group.rect.y = Math.min(group.rect.y, rect.y);
		group.rect.w = right - group.rect.x;
		group.rect.h = bottom - group.rect.y;
		group.center = group.rect.y + group.rect.h / 2;
	}

	return groups
		.map((item) => ({
			x: roundTo(item.rect.x),
			y: roundTo(item.rect.y),
			w: roundTo(item.rect.w),
			h: roundTo(item.rect.h),
		}))
		.sort((a, b) => a.y - b.y || a.x - b.x);
}

export function denormalizeRect(rect: NormalizedRect, page: BoxSize): PixelRect {
	return {
		left: rect.x * page.width,
		top: rect.y * page.height,
		width: rect.w * page.width,
		height: rect.h * page.height,
	};
}

/** Stable, rounded copy used for hashing and comparisons. */
export function canonicalRects(rects: NormalizedRect[]): string {
	return rects.map((rect) => `${roundTo(rect.x)},${roundTo(rect.y)},${roundTo(rect.w)},${roundTo(rect.h)}`).join(';');
}

export function lineHeightFor(fontSize: number): number {
	const size = fontSize > 0 ? fontSize : 12;
	return size * 1.45;
}

/**
 * Space between the bottom of the word's line and the top of the next one.
 * When the next line is unknown (last line on the page) fall back to a
 * font-size based estimate.
 */
export function estimateGap(lineBottom: number, nextLineTop: number | null, fontSize: number): number {
	if (nextLineTop === null) return Math.max(0, lineHeightFor(fontSize) * 0.32);
	return nextLineTop - lineBottom;
}

export function rectsIntersect(a: PixelRect, b: PixelRect): boolean {
	return a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
}

/** Overlap area divided by the smaller rectangle's area (0 when disjoint). */
export function overlapRatio(a: PixelRect, b: PixelRect): number {
	const left = Math.max(a.left, b.left);
	const right = Math.min(a.left + a.width, b.left + b.width);
	const top = Math.max(a.top, b.top);
	const bottom = Math.min(a.top + a.height, b.top + b.height);
	if (right <= left || bottom <= top) return 0;
	const area = (right - left) * (bottom - top);
	const smaller = Math.min(a.width * a.height, b.width * b.height);
	return smaller > 0 ? area / smaller : 0;
}

/** Labels overlapping more than this are treated as a collision. */
export const COLLISION_RATIO = 0.12;

export function planLabel(options: PlanOptions): LabelPlan {
	const { anchor, mode } = options;
	const scale = clamp(options.fontScale, 0.6, 2);
	const gap = Number.isFinite(options.gap) ? options.gap : 0;
	const baseFont = options.baseFontSize > 0 ? options.baseFontSize : MIN_FONT_PX;
	const pageFont = options.pageFontSize && options.pageFontSize > 0 ? options.pageFontSize : baseFont;
	const textWidth = Math.max(1, options.textWidth);

	if (mode === 'hover' || mode === 'none') {
		return { left: 0, top: 0, width: 0, height: 0, fontSize: 0, mode, hidden: true };
	}

	// Readability first: the label tracks the page's body text and never drops
	// into the 4–7px range that looked like a smudge under the word.
	const minFont = MIN_FONT_PX * scale;
	const maxFont = Math.max(minFont, Math.min(pageFont * 1.05, MAX_FONT_PX * scale));
	let fontSize = clamp(pageFont * 0.72 * scale, minFont, maxFont);

	// Width includes the horizontal padding, because `.ig-pdf-label` is
	// border-box and the width is set inline.
	const measure = (size: number) => Math.max(8, (textWidth * size) / baseFont + LABEL_PAD_X * 2);
	let width = measure(fontSize);
	const available = anchor.pageWidth - EDGE_PAD * 2;
	let effective: MarkLabelMode = mode;

	if (width > available) {
		// Long phrase: shrink to fit rather than clipping the text with ellipsis.
		const shrunk = Math.max(minFont, (fontSize * available) / width);
		fontSize = shrunk;
		width = measure(shrunk);
	}
	if (width > available) {
		// Even at the minimum size it is wider than the page; CSS clips the tail.
		width = available;
	}

	const height = fontSize * LABEL_LINE_HEIGHT;
	const centerX = (anchor.left + anchor.right) / 2;
	let left = clamp(centerX - width / 2, EDGE_PAD, Math.max(EDGE_PAD, anchor.pageWidth - width - EDGE_PAD));
	let top: number;

	if (mode === 'margin') {
		left = Math.max(EDGE_PAD, anchor.pageWidth - width - EDGE_PAD);
		top = clamp(anchor.bottom - height / 2, EDGE_PAD, anchor.pageHeight - height - EDGE_PAD);
	} else if (mode === 'gap' && gap >= height + 0.5) {
		top = anchor.bottom + (gap - height) / 2;
	} else {
		// A readable label does not fit the gap, so hug the word's bottom edge
		// with a translucent chip that dips ~1px into the next line.
		effective = mode === 'gap' ? 'overlap' : mode;
		top = anchor.bottom - OVERLAP_DIP;
	}

	if (top + height > anchor.pageHeight - EDGE_PAD) {
		const above = anchor.top - height - 2;
		if (above >= EDGE_PAD) {
			top = above;
			if (effective === 'gap') effective = 'overlap';
		} else {
			top = Math.max(EDGE_PAD, anchor.pageHeight - height - EDGE_PAD);
		}
	}
	if (top < EDGE_PAD) top = EDGE_PAD;


	return {
		left: roundTo(left, 2),
		top: roundTo(top, 2),
		width: roundTo(width, 2),
		height: roundTo(height, 2),
		fontSize: roundTo(fontSize, 2),
		mode: effective,
		hidden: false,
	};
}

export interface CollisionItem {
	id: string;
	rect: PixelRect;
	/** Higher wins; the most recently created/edited mark should be on top. */
	priority: number;
}

/**
 * Two labels rarely fit in the same gap. Rather than stacking them (which
 * pushes one into the body text), hide every loser and keep the winner.
 */
export function resolveCollisions(items: CollisionItem[]): Set<string> {
	const hidden = new Set<string>();
	const sorted = [...items].sort((a, b) => b.priority - a.priority);
	const kept: CollisionItem[] = [];
	for (const item of sorted) {
		const clashes = kept.some((other) => overlapRatio(item.rect, other.rect) > COLLISION_RATIO);
		if (clashes) {
			hidden.add(item.id);
		} else {
			kept.push(item);
		}
	}
	return hidden;
}

