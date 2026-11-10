import type { GlossSettings, MarkLabelMode, PdfWordMark } from '../types';
import type { PdfViewLike } from './adapter';
import {
	clamp,
	denormalizeRect,
	mergeLineRects,
	overlapRatio,
	planLabel,
	resolveCollisions,
	type CollisionItem,
	type LabelPlan,
	type PixelRect,
} from './geometry';
import { markAtPoint } from './marks';
import { collectLineBoxes, PAGE_SELECTOR } from './wordSelection';

/**
 * Renders highlights and inline labels on top of the pdf.js pages.
 *
 * Obsidian's PDF DOM is internal API, so this layer is defensive: if a page
 * element is missing the mark is simply not painted (the sidebar still lists
 * it). Painting is debounced and runs inside a requestAnimationFrame.
 */

export interface OverlayCallbacks {
	marksFor(pdfPath: string, page: number): PdfWordMark[];
	onEdit(mark: PdfWordMark): void;
	onHover?(mark: PdfWordMark | null): void;
}

const COLORS: Record<PdfWordMark['color'], string> = {
	yellow: '255, 224, 0',
	green: '120, 220, 120',
	blue: '120, 180, 255',
	pink: '255, 150, 200',
};

const MAX_MARKS_PER_PAGE = 100;
const BASE_MEASURE_FONT = 10;

interface PaintedLabel {
	mark: PdfWordMark;
	element: HTMLElement;
	plan: LabelPlan;
	rect: PixelRect;
}

interface PageGeometry {
	width: number;
	height: number;
	lines: Array<{ top: number; bottom: number; left: number; right: number; fontSize: number }>;
}

export class PdfMarkOverlay {
	private view: PdfViewLike | null = null;
	private layers = new Map<HTMLElement, HTMLElement>();
	private resize: ResizeObserver | null = null;
	private mutation: MutationObserver | null = null;
	private scrollTarget: HTMLElement | null = null;
	private frame = 0;
	private timer: number | null = null;
	private painting = false;
	private hovered: string | null = null;

	constructor(private callbacks: OverlayCallbacks, private getSettings: () => GlossSettings) {}

	attach(view: PdfViewLike): void {
		if (this.view && this.view.containerEl === view.containerEl) {
			this.view = view;
			this.refresh();
			return;
		}
		this.detach();
		this.view = view;
		this.observe();
		this.refresh();
	}

	detach(): void {
		this.stopObservers();
		for (const layer of this.layers.values()) layer.remove();
		this.layers.clear();
		this.view = null;
		this.hovered = null;
	}

	destroy(): void {
		this.detach();
		if (this.timer !== null) window.clearTimeout(this.timer);
		if (this.frame) window.cancelAnimationFrame(this.frame);
		this.timer = null;
		this.frame = 0;
	}

	/** Debounced repaint; call after marks change or the layout shifts. */
	refresh(): void {
		this.schedule(100);
	}

	private schedule(delay: number): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => {
			this.timer = null;
			if (!this.frame) {
				this.frame = window.requestAnimationFrame(() => {
					this.frame = 0;
					this.paint();
				});
			}
		}, delay);
	}

	private observe(): void {
		const container = this.view?.containerEl;
		if (!container) return;
		this.scrollTarget =
			container.querySelector<HTMLElement>('.pdf-viewer, .pdf-container, .view-scroll-container, .view-content') ??
			container;
		this.scrollTarget.addEventListener('scroll', this.onScroll, { passive: true });
		this.scrollTarget.addEventListener('pointermove', this.onPointerMove, { passive: true });
		this.scrollTarget.addEventListener('pointerleave', this.onPointerLeave);
		window.addEventListener('resize', this.onScroll);
		if (typeof ResizeObserver !== 'undefined') {
			this.resize = new ResizeObserver(() => this.refresh());
			this.resize.observe(container);
		}
		if (typeof MutationObserver !== 'undefined') {
			this.mutation = new MutationObserver((records) => {
				if (this.painting) return;
				const relevant = records.some((record) =>
					Array.from(record.addedNodes)
						.concat(Array.from(record.removedNodes))
						.some((node) => !(node instanceof HTMLElement) || !node.classList.contains('ig-pdf-layer')),
				);
				if (relevant) this.refresh();
			});
			this.mutation.observe(container, { childList: true, subtree: true });
		}
	}

	private stopObservers(): void {
		this.scrollTarget?.removeEventListener('scroll', this.onScroll);
		this.scrollTarget?.removeEventListener('pointermove', this.onPointerMove);
		this.scrollTarget?.removeEventListener('pointerleave', this.onPointerLeave);
		this.scrollTarget = null;
		window.removeEventListener('resize', this.onScroll);
		this.resize?.disconnect();
		this.resize = null;
		this.mutation?.disconnect();
		this.mutation = null;
	}

	private onScroll = (): void => {
		this.refresh();
	};

	/**
	 * Hover tracking is done by hit-testing instead of relying on the highlight
	 * elements, because those stay `pointer-events: none` so text selection in
	 * the PDF keeps working.
	 */
	private onPointerMove = (event: PointerEvent): void => {
		const view = this.view;
		if (!view) return;
		const target = event.target instanceof Element ? event.target : null;
		// Keep the current tooltip while the pointer is over our own chip.
		if (target?.closest('.ig-pdf-layer')) return;
		const page = target?.closest<HTMLElement>(PAGE_SELECTOR) ?? null;
		if (!page) {
			this.setHovered(null);
			return;
		}
		const pageNumber = Number.parseInt(page.getAttribute('data-page-number') ?? '', 10);
		if (!Number.isFinite(pageNumber) || pageNumber <= 0) return;
		const rect = page.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return;
		const point = {
			x: (event.clientX - rect.left) / rect.width,
			y: (event.clientY - rect.top) / rect.height,
		};
		this.setHovered(markAtPoint(this.callbacks.marksFor(view.file.path, pageNumber), point));
	};

	private onPointerLeave = (): void => {
		this.setHovered(null);
	};

	private setHovered(mark: PdfWordMark | null): void {
		const id = mark?.id ?? null;
		if (this.hovered === id) return;
		this.hovered = id;
		for (const layer of this.layers.values()) {
			for (const element of Array.from(layer.querySelectorAll<HTMLElement>('.ig-pdf-mark'))) {
				element.classList.toggle('is-hover', element.dataset.markId === id);
			}
		}
		this.callbacks.onHover?.(mark);
		// Only the hover mode paints the label on demand.
		if (this.getSettings().pdfMarkLabelMode === 'hover') this.schedule(0);
	}

	private visiblePageElements(container: HTMLElement): HTMLElement[] {
		const pages = Array.from(container.querySelectorAll<HTMLElement>(PAGE_SELECTOR));
		const viewport = container.getBoundingClientRect();
		return pages.filter((page) => {
			const rect = page.getBoundingClientRect();
			return rect.bottom >= viewport.top - 200 && rect.top <= viewport.bottom + 200;
		});
	}

	private layerFor(page: HTMLElement): HTMLElement {
		const existing = this.layers.get(page);
		if (existing && existing.parentElement === page) return existing;
		if (window.getComputedStyle(page).position === 'static') page.style.position = 'relative';
		const layer = document.createElement('div');
		layer.className = 'ig-pdf-layer';
		page.appendChild(layer);
		this.layers.set(page, layer);
		return layer;
	}

	private paint(): void {
		const view = this.view;
		const settings = this.getSettings();
		if (!view || !settings.pdfMarksEnabled) {
			this.detach();
			return;
		}
		const container = view.containerEl;
		if (!container.isConnected) return;

		const pages = this.visiblePageElements(container);
		const alive = new Set(pages);
		for (const [page, layer] of Array.from(this.layers.entries())) {
			if (!alive.has(page) || !page.isConnected) {
				layer.remove();
				this.layers.delete(page);
			}
		}

		this.painting = true;
		try {
			for (const page of pages) {
				const pageNumber = Number.parseInt(page.getAttribute('data-page-number') ?? '', 10);
				if (!Number.isFinite(pageNumber) || pageNumber <= 0) continue;
				const marks = this.callbacks.marksFor(view.file.path, pageNumber).slice(0, MAX_MARKS_PER_PAGE);
				const layer = this.layerFor(page);
				while (layer.firstChild) layer.removeChild(layer.firstChild);
				if (!marks.length) continue;
				const geometry = this.pageGeometry(page);
				const painted: PaintedLabel[] = [];
				for (const mark of marks) {
					const label = this.paintMark(layer, page, mark, geometry, settings);
					if (label) painted.push(label);
				}
				this.hideCollisions(painted);
			}
		} finally {
			this.painting = false;
		}
	}

	private pageGeometry(page: HTMLElement): PageGeometry {
		const rect = page.getBoundingClientRect();
		return { width: rect.width, height: rect.height, lines: collectLineBoxes(page) };
	}

	private paintMark(
		layer: HTMLElement,
		page: HTMLElement,
		mark: PdfWordMark,
		geometry: PageGeometry,
		settings: GlossSettings,
	): PaintedLabel | null {
		const pageRect = page.getBoundingClientRect();
		const layerRect = layer.getBoundingClientRect();
		const layerOffsetX = layerRect.left - pageRect.left;
		const layerOffsetY = layerRect.top - pageRect.top;
		const mode = settings.pdfMarkLabelMode;
		const rgb = COLORS[mark.color] ?? COLORS.yellow;
		const opacity = clamp(settings.pdfMarkOpacity, 0.2, 1);

		for (const rect of mergeLineRects(mark.rects)) {
			const left = rect.x * pageRect.width - layerOffsetX;
			const top = rect.y * pageRect.height - layerOffsetY;
			const width = rect.w * pageRect.width;
			const rawHeight = rect.h * pageRect.height;
			const centerY = pageRect.top + rect.y * pageRect.height + rawHeight / 2;
			const line = geometry.lines.find((item) => centerY >= item.top - 1 && centerY <= item.bottom + 1);
			const glyphHeight = line?.fontSize && line.fontSize > 0 ? Math.min(rawHeight, line.fontSize) : rawHeight;
			const highlight = document.createElement('div');
			highlight.className = 'ig-pdf-mark';
			highlight.style.left = `${left}px`;
			highlight.style.top = `${top + (rawHeight - glyphHeight) / 2}px`;
			highlight.style.width = `${width}px`;
			highlight.style.height = `${glyphHeight}px`;
			highlight.style.background = `rgba(${rgb}, ${0.35 * opacity})`;
			highlight.dataset.markId = mark.id;
			highlight.title = `${mark.text} — ${mark.translation}${mark.sentenceTranslation ? `\n${mark.sentenceTranslation}` : ''}`;
			if (this.hovered === mark.id) highlight.classList.add('is-hover');
			layer.appendChild(highlight);
		}

		const last = mark.rects[mark.rects.length - 1];
		const lastPx = denormalizeRect(last, { width: geometry.width, height: geometry.height });
		const pageTop = pageRect.top;
		const centerY = pageTop + lastPx.top + lastPx.height / 2;
		const lineBox = geometry.lines.find((line) => centerY >= line.top - 1 && centerY <= line.bottom + 1);
		const relLine = lineBox
			? { top: lineBox.top - pageTop, bottom: lineBox.bottom - pageTop }
			: { top: lastPx.top, bottom: lastPx.top + lastPx.height };
		const nextLine = geometry.lines.find((line) => line.top > pageTop + relLine.bottom + 0.5);
		const lineHeight = Math.max(4, relLine.bottom - relLine.top);
		const gap = nextLine ? nextLine.top - pageTop - relLine.bottom : lineHeight * 0.32;

		if (mode === 'none' || (mode === 'hover' && this.hovered !== mark.id)) {
			return null;
		}
		// `hover` places the tooltip as if the gap were available, falling back to
		// the overlap chip: it is transient, so covering a line for a moment is fine.
		const planMode: MarkLabelMode = mode === 'hover' ? 'gap' : mode;

		const label = document.createElement('div');
		label.className = 'ig-pdf-label';
		label.textContent = settings.pdfMarkShowPos && mark.pos ? `${mark.translation} ${mark.pos}` : mark.translation;
		label.style.fontSize = `${BASE_MEASURE_FONT}px`;
		// Measure the text only: planLabel adds the padding back in.
		label.style.padding = '0';
		label.style.visibility = 'hidden';
		label.title = `${mark.text} — ${mark.translation}${mark.sentenceTranslation ? `\n${mark.sentenceTranslation}` : ''}`;
		label.dataset.markId = mark.id;
		layer.appendChild(label);
		const measured = Math.max(12, label.getBoundingClientRect().width);
		label.style.padding = '';

		const plan = planLabel({
			anchor: {
				left: lastPx.left,
				right: lastPx.left + lastPx.width,
				top: relLine.top,
				bottom: relLine.bottom,
				pageWidth: geometry.width,
				pageHeight: geometry.height,
			},
			gap,
			textWidth: measured,
			baseFontSize: BASE_MEASURE_FONT,
			pageFontSize: lineBox?.fontSize ?? relLine.bottom - relLine.top,
			fontScale: settings.pdfMarkFontScale,
			mode: planMode,
		});

		label.style.visibility = '';
		label.style.left = `${plan.left}px`;
		label.style.top = `${plan.top}px`;
		label.style.fontSize = `${plan.fontSize}px`;
		label.style.width = `${plan.width}px`;
		label.classList.toggle('is-overlap', plan.mode === 'overlap');
		label.classList.toggle('is-margin', plan.mode === 'margin');

		if (plan.mode === 'margin') {
			const connector = document.createElement('div');
			connector.className = 'ig-pdf-connector';
			connector.style.left = `${Math.min(plan.left, lastPx.left + lastPx.width)}px`;
			connector.style.top = `${plan.top + plan.height / 2}px`;
			connector.style.width = `${Math.max(2, Math.abs(plan.left - (lastPx.left + lastPx.width)))}px`;
			layer.appendChild(connector);
		}

		label.addEventListener('click', (event) => {
			event.preventDefault();
			event.stopPropagation();
			this.callbacks.onEdit(mark);
		});

		return {
			mark,
			element: label,
			plan,
			rect: { left: plan.left, top: plan.top, width: plan.width, height: plan.height },
		};
	}


	/** Only one label wins a shared gap; the rest keep their highlight. */
	private hideCollisions(painted: PaintedLabel[]): void {
		if (painted.length < 2) return;
		const items: CollisionItem[] = painted.map((item) => ({
			id: item.mark.id,
			rect: item.rect,
			priority: this.hovered === item.mark.id ? Number.MAX_SAFE_INTEGER : item.mark.updatedAt,
		}));
		const hidden = resolveCollisions(items);
		for (const item of painted) {
			const hide = hidden.has(item.mark.id) && this.hovered !== item.mark.id;
			item.element.classList.toggle('is-hidden', hide);
		}
	}

	/** True when at least one label overlaps a mark (diagnostics helper). */
	hasOverlap(mark: PdfWordMark): boolean {
		const page = this.view?.containerEl.querySelector<HTMLElement>(
			`${PAGE_SELECTOR}[data-page-number="${mark.page}"]`,
		);
		const layer = page ? this.layers.get(page) : null;
		if (!layer) return false;
		const labels = Array.from(layer.querySelectorAll<HTMLElement>('.ig-pdf-label'));
		const mine = labels.find((label) => label.dataset.markId === mark.id);
		if (!mine) return false;
		const a = mine.getBoundingClientRect();
		return labels.some((label) => {
			if (label === mine || label.classList.contains('is-hidden')) return false;
			return overlapRatio(a, label.getBoundingClientRect()) > 0.12;
		});
	}

	/** Sidebar "定位": scroll the page into view and flash the highlights. */
	focusMark(mark: PdfWordMark): boolean {
		const view = this.view;
		if (!view) return false;
		const page = view.containerEl.querySelector<HTMLElement>(`${PAGE_SELECTOR}[data-page-number="${mark.page}"]`);
		if (!page) return false;
		page.scrollIntoView({ block: 'center', behavior: 'smooth' });
		this.refresh();
		window.setTimeout(() => {
			const layer = this.layers.get(page);
			if (!layer) return;
			for (const highlight of Array.from(
				layer.querySelectorAll<HTMLElement>(`.ig-pdf-mark[data-mark-id="${mark.id}"]`),
			)) {
				highlight.classList.add('is-flash');
				window.setTimeout(() => highlight.classList.remove('is-flash'), 1200);
			}
		}, 320);
		return true;
	}
}