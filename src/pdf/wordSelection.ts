import type { GlossSettings, PdfWordSelection } from '../types';
import type { PdfViewLike } from './adapter';
import { normalizeRects } from './geometry';

/**
 * Turns a pdf.js text selection into everything a word mark needs: normalised
 * rects, the page's text layer coordinates around the word, and the visible
 * line gap. Every measurement is CSS px in the current zoom, so nothing here
 * assumes a fixed point size.
 *
 * pdf.js splits one word across several spans, so a double click often lands on
 * "ontains" instead of "contains". The selection is therefore snapped to word
 * boundaries before anything is measured.
 */

export const PAGE_SELECTOR = '.page[data-page-number], .pdf-page[data-page-number]';

/** Characters that keep a selection inside the same word. */
export const WORD_CHARS = /[A-Za-z'\u2019\-]/;

/** Punctuation that may cling to the edges of a double-clicked word. */
const EDGE_PUNCT = /[,.;:!?)\]}"\u201d\u201c\u3001\u3002\uff0c\uff1b\uff1a\uff01\uff1f\u300b\u3009\u3011]/;

export type CaptureResult =
	| { ok: true; selection: PdfWordSelection }
	| { ok: false; message: string };

export function pageElementOf(node: Node | null): HTMLElement | null {
	if (!node) return null;
	const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
	const page = element?.closest<HTMLElement>(PAGE_SELECTOR);
	return page ?? null;
}

export function pageNumberOf(page: HTMLElement | null): number | null {
	if (!page) return null;
	const parsed = Number.parseInt(page.getAttribute('data-page-number') ?? '', 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function pageTextOf(page: HTMLElement | null): string {
	if (!page) return '';
	const layer = page.querySelector<HTMLElement>('.textLayer') ?? page;
	return (layer.textContent ?? '').replace(/\u00ad/g, '').replace(/\s+/g, ' ').trim();
}

export function normalizeSelectionText(input: string): string {
	return input
		.replace(/\u00ad/g, '')
		.replace(/\r\n?/g, '\n')
		.replace(/-\n\s*/g, '-')
		.replace(/\s*\n\s*/g, ' ')
		.replace(/\s{2,}/g, ' ')
		.trim();
}

/**
 * Grow `[start, end)` until it covers whole words on both ends. Interior
 * spaces stay untouched, so a phrase keeps its middle words intact while the
 * first word's head and the last word's tail are restored.
 *
 * A pdf.js selection routinely carries the space that follows the word (the
 * browser puts the end point after it), so the edges are stripped first —
 * otherwise the word loop below walks straight over that space and swallows
 * the next word ("contain" turning into "contain tan").
 */
export function expandToWordBounds(text: string, start: number, end: number): { start: number; end: number } {
	const length = text.length;
	let from = Math.max(0, Math.min(start, length));
	let to = Math.max(0, Math.min(end, length));
	if (to < from) {
		const swap = from;
		from = to;
		to = swap;
	}
	while (from < to && /\s/.test(text.charAt(from))) from += 1;
	while (to > from && /\s/.test(text.charAt(to - 1))) to -= 1;
	while (from < to && EDGE_PUNCT.test(text.charAt(from))) from += 1;
	while (to > from && EDGE_PUNCT.test(text.charAt(to - 1))) to -= 1;
	while (from > 0 && WORD_CHARS.test(text.charAt(from - 1))) from -= 1;
	while (to < length && WORD_CHARS.test(text.charAt(to))) to += 1;
	return { start: from, end: to };
}

/** True when the selection starts or ends in the middle of a word. */
export function hasPartialWord(text: string, start: number, end: number): boolean {
	const before = start > 0 ? text.charAt(start - 1) : '';
	const after = end < text.length ? text.charAt(end) : '';
	return (before !== '' && WORD_CHARS.test(before)) || (after !== '' && WORD_CHARS.test(after));
}

interface TextChunk {
	node: Text;
	start: number;
	end: number;
}

interface TextRect {
	top: number;
	bottom: number;
	left: number;
	right: number;
}

function textNodeRects(node: Text): TextRect[] {
	const doc = node.ownerDocument ?? document;
	const range = doc.createRange();
	range.selectNodeContents(node);
	return Array.from(range.getClientRects())
		.filter((rect) => rect.width > 0.5 && rect.height > 0.5)
		.map((rect) => ({ top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right }));
}

/**
 * pdf.js has no whitespace text node between many words, and none at all
 * between the end of one line and the start of the next. Flattening the text
 * nodes without that geometry turns "chapters" + "are" into "chaptersare".
 * Insert a synthetic separator only when the two nodes are actually a line or
 * a visible horizontal gap apart; spans of one split word stay glued.
 */
export function separatorBetween(prevRect: TextRect, nextRect: TextRect, prevText: string, nextText: string): string {
	if (/\s$/.test(prevText) || /^\s/.test(nextText)) return '';
	const sameLine = nextRect.top < prevRect.bottom - 1 && prevRect.top < nextRect.bottom - 1;
	if (!sameLine) return '\n';
	const gap = nextRect.left - prevRect.right;
	const wordGapThreshold = Math.max(1.5, (prevRect.bottom - prevRect.top) * 0.12);
	if (gap > wordGapThreshold) return ' ';
	return '';
}

/** Flatten a page's text nodes so DOM offsets can be compared with string offsets. */
function buildTextIndex(root: HTMLElement): { text: string; chunks: TextChunk[] } {
	const walker = (root.ownerDocument ?? document).createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const chunks: TextChunk[] = [];
	let text = '';
	let previousNode: Text | null = null;
	let previousRect: TextRect | null = null;
	let node = walker.nextNode() as Text | null;
	while (node) {
		const value = node.nodeValue ?? '';
		if (value) {
			const rects = textNodeRects(node);
			const first = rects[0] ?? null;
			const last = rects[rects.length - 1] ?? null;
			if (previousNode && previousRect && first) {
				const separator = separatorBetween(previousRect, first, previousNode.nodeValue ?? '', value);
				if (separator) text += separator;
			}
			chunks.push({ node, start: text.length, end: text.length + value.length });
			text += value;
			previousNode = node;
			previousRect = last;
		}
		node = walker.nextNode() as Text | null;
	}
	return { text, chunks };
}

function firstTextIn(root: Node): Text | null {
	if (root.nodeType === Node.TEXT_NODE) return root as Text;
	const walker = (root.ownerDocument ?? document).createTreeWalker(root, NodeFilter.SHOW_TEXT);
	return walker.nextNode() as Text | null;
}

function lastTextIn(root: Node): Text | null {
	if (root.nodeType === Node.TEXT_NODE) return root as Text;
	const walker = (root.ownerDocument ?? document).createTreeWalker(root, NodeFilter.SHOW_TEXT);
	let last: Text | null = null;
	let node = walker.nextNode();
	while (node) {
		last = node as Text;
		node = walker.nextNode();
	}
	return last;
}

/**
 * Absolute string offset of a DOM point inside the indexed page text.
 *
 * `bias` matters when the point sits on an element boundary (which happens a
 * lot in the pdf.js text layer): a start point belongs to the child *after*
 * the caret, an end point belongs to the child *before* it. Using the wrong
 * one moves the word a whole span away.
 */
function absoluteOffset(chunks: TextChunk[], node: Node, offset: number, bias: 'start' | 'end' = 'start'): number {
	if (node.nodeType === Node.TEXT_NODE) {
		const chunk = chunks.find((item) => item.node === node);
		if (!chunk) return -1;
		const local = Math.max(0, Math.min(offset, chunk.end - chunk.start));
		return chunk.start + local;
	}
	const element = node as Element;
	const child = element.childNodes[offset] ?? null;
	const previous = offset > 0 ? element.childNodes[offset - 1] : null;
	const prevEnd = (): number => {
		if (!previous) return -1;
		const last = lastTextIn(previous);
		const chunk = last ? chunks.find((item) => item.node === last) : undefined;
		return chunk ? chunk.end : -1;
	};
	const nextStart = (): number => {
		if (!child) return -1;
		const first = firstTextIn(child);
		const chunk = first ? chunks.find((item) => item.node === first) : undefined;
		return chunk ? chunk.start : -1;
	};
	if (bias === 'end') {
		const before = prevEnd();
		if (before >= 0) return before;
		const after = nextStart();
		if (after >= 0) return after;
	} else {
		const after = nextStart();
		if (after >= 0) return after;
		const before = prevEnd();
		if (before >= 0) return before;
	}
	const first = firstTextIn(element);
	const chunk = first ? chunks.find((item) => item.node === first) : undefined;
	return chunk ? chunk.start : -1;
}

function rangeForOffsets(doc: Document, chunks: TextChunk[], start: number, end: number): Range | null {
	// Offsets can land on a synthetic separator that belongs to no text node.
	// For a start point, move forward to the next text node; for an end point,
	// move back to the previous one.
	const startChunk =
		chunks.find((chunk) => start >= chunk.start && start < chunk.end) ??
		chunks.find((chunk) => chunk.start >= start) ??
		chunks[chunks.length - 1] ??
		null;
	const endChunk =
		[...chunks].reverse().find((chunk) => end > chunk.start && end <= chunk.end) ??
		[...chunks].reverse().find((chunk) => chunk.end <= end) ??
		chunks[0] ??
		null;
	if (!startChunk || !endChunk) return null;

	const startOffset = Math.max(startChunk.start, Math.min(start, startChunk.end));
	const endOffset = Math.max(endChunk.start, Math.min(end, endChunk.end));
	if (endOffset < startOffset) return null;

	const range = doc.createRange();
	range.setStart(startChunk.node, startOffset - startChunk.start);
	range.setEnd(endChunk.node, endOffset - endChunk.start);
	return range;
}

interface LineBox {
	top: number;
	bottom: number;
	left: number;
	right: number;
	fontSize: number;
}

/** Line boxes of a page's text layer, merged from every span's client rect. */
export function collectLineBoxes(page: HTMLElement): LineBox[] {
	const layer = page.querySelector<HTMLElement>('.textLayer');
	if (!layer) return [];
	const boxes: LineBox[] = [];
	const nodes = layer.querySelectorAll<HTMLElement>('span, div, br');
	for (const node of Array.from(nodes)) {
		const style = window.getComputedStyle(node);
		const fontSize = Number.parseFloat(style.fontSize) || 0;
		for (const rect of Array.from(node.getClientRects())) {
			if (rect.width <= 0.5 || rect.height <= 0.5) continue;
			boxes.push({
				top: rect.top,
				bottom: rect.bottom,
				left: rect.left,
				right: rect.right,
				fontSize,
			});
		}
	}
	// Merge boxes that share a baseline row.
	boxes.sort((a, b) => a.top - b.top || a.left - b.left);
	const merged: LineBox[] = [];
	for (const box of boxes) {
		const last = merged[merged.length - 1];
		if (last && Math.abs(box.top - last.top) <= Math.max(1.5, last.bottom - last.top) * 0.4) {
			last.top = Math.min(last.top, box.top);
			last.bottom = Math.max(last.bottom, box.bottom);
			last.left = Math.min(last.left, box.left);
			last.right = Math.max(last.right, box.right);
			last.fontSize = Math.max(last.fontSize, box.fontSize);
			continue;
		}
		merged.push({ ...box });
	}
	return merged;
}

export function captureWordSelection(view: PdfViewLike, settings: GlossSettings): CaptureResult {
	const selection = window.getSelection();
	if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
		return { ok: false, message: '先在 PDF 里选中一个单词或短语' };
	}
	const range = selection.getRangeAt(0);
	if (!view.containerEl.contains(range.commonAncestorContainer)) {
		return { ok: false, message: '当前选区不在 PDF 里' };
	}

	const startPage = pageElementOf(range.startContainer);
	const endPage = pageElementOf(range.endContainer) ?? startPage;
	if (!startPage || !endPage) {
		return { ok: false, message: '没找到 PDF 页面元素，无法确定坐标' };
	}
	if (startPage !== endPage) {
		return { ok: false, message: '跨页选择无法标注，请只选同一页上的词' };
	}
	const page = pageNumberOf(startPage);
	if (!page) {
		return { ok: false, message: '这一页缺少页码信息，暂时无法标注' };
	}

	// Snap to word boundaries before measuring: pdf.js fragments words across
	// spans and a double click can start on the second letter.
	const textRoot = startPage.querySelector<HTMLElement>('.textLayer') ?? startPage;
	const index = buildTextIndex(textRoot);
	const rawStart = absoluteOffset(index.chunks, range.startContainer, range.startOffset, 'start');
	const rawEnd = absoluteOffset(index.chunks, range.endContainer, range.endOffset, 'end');
	const rawText = normalizeSelectionText(range.toString());
	const rawLineTops = new Set(
		Array.from(range.getClientRects())
			.filter((rect) => rect.width > 0.5 && rect.height > 0.5)
			.map((rect) => Math.round(rect.top / 2)),
	);
	let snappedRange: Range = range;
	let snappedStart = rawStart;
	let snappedEnd = rawEnd;
	if (rawStart >= 0 && rawEnd > rawStart) {
		let bounds = expandToWordBounds(index.text, rawStart, rawEnd);
		// Last-resort guard: if the user clearly selected one word but the DOM
		// points still stretch across a space (pdf.js sometimes reports the end
		// point at the start of the next span), keep only the word under the
		// caret instead of marking "contain tan".
		if (
			rawText &&
			!/\s/.test(rawText) &&
			rawLineTops.size <= 1 &&
			/\s/.test(index.text.slice(bounds.start, bounds.end))
		) {
			let from = rawStart;
			let to = rawEnd;
			while (from > bounds.start && WORD_CHARS.test(index.text.charAt(from - 1))) from -= 1;
			while (to < bounds.end && WORD_CHARS.test(index.text.charAt(to))) to += 1;
			if (to > from) bounds = { start: from, end: to };
		}
		const rebuilt = rangeForOffsets(startPage.ownerDocument, index.chunks, bounds.start, bounds.end);
		if (rebuilt) {
			snappedRange = rebuilt;
			snappedStart = bounds.start;
			snappedEnd = bounds.end;
			// Keep the on-screen selection in sync so the user sees the whole word.
			try {
				selection.removeAllRanges();
				selection.addRange(rebuilt);
			} catch {
				/* selection may be locked while the command runs */
			}
		}
	}

	// Use the indexed text, not Range.toString(): pdf.js renders lines as
	// separate absolutely-positioned spans, so the DOM range often concatenates
	// the end of one line with the start of the next ("policyThe"). The index
	// inserts a separator from the spans' geometry, which keeps multi-line
	// phrases translatable.
	const text =
		snappedStart >= 0 && snappedEnd > snappedStart
			? normalizeSelectionText(index.text.slice(snappedStart, snappedEnd))
			: normalizeSelectionText(snappedRange.toString());
	if (!text) return { ok: false, message: '选区是空的' };
	if (snappedStart >= 0 && hasPartialWord(index.text, snappedStart, snappedEnd)) {
		// Snapping could not reach the boundary (unusual span order): refuse
		// instead of saving half a word again.
		return { ok: false, message: '没能取到完整单词，请重新选一次（双击词的中间更稳）' };
	}
	const limit = Math.max(10, Math.min(80, settings.pdfMarkMaxChars));
	if (Array.from(text).length > limit) {
		return { ok: false, message: `请选一个词或短语（不超过 ${limit} 个字符）` };
	}

	const pageRect = startPage.getBoundingClientRect();
	const snappedRects = Array.from(snappedRange.getClientRects()).filter(
		(rect) => rect.width > 0.5 && rect.height > 0.5,
	);
	const rawRects = snappedRects.map((rect) => ({
		left: rect.left,
		top: rect.top,
		width: rect.width,
		height: rect.height,
	}));
	if (!rawRects.length) return { ok: false, message: '没量到选区的坐标，换个位置再试' };
	const rects = normalizeRects(rawRects, pageRect.left, pageRect.top, {
		width: pageRect.width,
		height: pageRect.height,
	});

	// Geometry of the last selected line: the label goes under that line.
	const lastRect = rawRects.reduce((best, rect) => (rect.top > best.top + 1 ? rect : best), rawRects[0]);
	const lines = collectLineBoxes(startPage);
	const currentLine =
		lines.find(
			(line) =>
				lastRect.top >= line.top - 2 && lastRect.top + lastRect.height <= line.bottom + 2,
		) ??
		lines.find((line) => Math.abs(line.top - lastRect.top) < 4) ??
		null;
	const lineTop = currentLine?.top ?? lastRect.top;
	const lineBottom = currentLine?.bottom ?? lastRect.top + lastRect.height;
	const nextLine =
		lines.find((line) => line.top > lineBottom - 1 && line.bottom > lineBottom) ?? null;

	const quoteBefore =
		snappedStart >= 0
			? normalizeSelectionText(index.text.slice(Math.max(0, snappedStart - 48), snappedStart))
			: '';
	const quoteAfter =
		snappedEnd > 0
			? normalizeSelectionText(index.text.slice(snappedEnd, snappedEnd + 48))
			: '';

	return {
		ok: true,
		selection: {
			text,
			page,
			rects,
			quoteBefore,
			quoteAfter,
			lineTop,
			lineBottom,
			nextLineTop: nextLine?.top ?? null,
			lineFontSize: currentLine?.fontSize || Number.parseFloat(window.getComputedStyle(startPage).fontSize) || 12,
		},
	};
}
