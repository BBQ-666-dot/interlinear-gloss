import { App, TFile, WorkspaceLeaf } from 'obsidian';

/**
 * Thin compatibility layer over Obsidian's internal PDF view.
 * Obsidian does not expose a public PDF API, so everything here is
 * best-effort: each strategy is guarded and `null` means "unknown", never
 * an exception. Callers must tolerate a missing page number.
 */

export interface PdfViewLike {
	file: TFile;
	leaf: WorkspaceLeaf;
	containerEl: HTMLElement;
	/** The raw view object, for optional internal API probing. */
	raw: unknown;
}

export interface PdfSelection {
	text: string;
	page: number | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function readNumber(source: unknown, key: string): number | null {
	const holder = asRecord(source);
	if (!holder) return null;
	const value = holder[key];
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function toPdfView(leaf: WorkspaceLeaf | null | undefined): PdfViewLike | null {
	if (!leaf) return null;
	const view = asRecord(leaf.view);
	if (!view) return null;
	const file = view.file;
	if (!(file instanceof TFile) || file.extension.toLowerCase() !== 'pdf') return null;
	const containerEl = view.containerEl instanceof HTMLElement ? view.containerEl : null;
	if (!containerEl) return null;
	return { file, leaf, containerEl, raw: leaf.view };
}

/** Active PDF leaf, else the most recently used one, else null. */
export function getActivePdfView(app: App): PdfViewLike | null {
	const active = toPdfView(app.workspace.activeLeaf);
	if (active) return active;

	const recent = app.workspace.getMostRecentLeaf();
	const recentPdf = toPdfView(recent);
	if (recentPdf) return recentPdf;

	for (const type of ['pdf', 'pdf-viewer']) {
		for (const leaf of app.workspace.getLeavesOfType(type)) {
			const found = toPdfView(leaf);
			if (found) return found;
		}
	}
	return null;
}

export function getViewTextSelection(): string {
	const selection = window.getSelection();
	if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return '';
	return normalizeSelectionText(selection.toString());
}

function normalizeSelectionText(input: string): string {
	return input
		.replace(/\u00ad/g, '')
		.replace(/\r\n?/g, '\n')
		.replace(/-\n\s*/g, '-')
		.replace(/\s*\n\s*/g, ' ')
		.replace(/\s{2,}/g, ' ')
		.trim();
}

function pageFromNode(node: Node | null): number | null {
	if (!node) return null;
	const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
	if (!element) return null;
	const pageEl = element.closest('.page[data-page-number]');
	if (!pageEl) return null;
	const parsed = Number.parseInt(pageEl.getAttribute('data-page-number') ?? '', 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Current page as shown by the viewer; falls back to the selected page. */
export function getCurrentPdfPage(view: PdfViewLike): number | null {
	const candidates: unknown[] = [
		asRecord(view.raw)?.pdfViewer,
		asRecord(view.raw)?.viewer,
		asRecord(asRecord(view.raw)?.pdfViewerComponent),
		asRecord(asRecord(asRecord(view.raw)?.pdfViewer)?.viewer),
	];
	for (const candidate of candidates) {
		const page =
			readNumber(candidate, 'currentPageNumber') ??
			readNumber(candidate, 'currentPage') ??
			readNumber(candidate, 'page');
		if (page) return page;
	}

	const selection = window.getSelection();
	if (selection && selection.rangeCount > 0) {
		const page = pageFromNode(selection.getRangeAt(0).startContainer);
		if (page) return page;
	}

	// DOM fallback: the page occupying the most of the scroll viewport.
	const pages = Array.from(view.containerEl.querySelectorAll<HTMLElement>('.page[data-page-number]'));
	if (!pages.length) return null;
	const scroller =
		view.containerEl.querySelector<HTMLElement>('.pdf-viewer, .view-content') ?? view.containerEl;
	const bounds = scroller.getBoundingClientRect();
	let best: { page: number; score: number } | null = null;
	for (const el of pages) {
		const rect = el.getBoundingClientRect();
		const overlap = Math.min(rect.bottom, bounds.bottom) - Math.max(rect.top, bounds.top);
		if (overlap <= 0) continue;
		const page = Number.parseInt(el.getAttribute('data-page-number') ?? '', 10);
		if (!Number.isFinite(page)) continue;
		if (!best || overlap > best.score) best = { page, score: overlap };
	}
	return best?.page ?? null;
}

/** Selected text plus its page, or null when there is nothing to gloss. */
export function getPdfSelection(view: PdfViewLike): PdfSelection | null {
	const selection = window.getSelection();
	if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
	const range = selection.getRangeAt(0);
	if (!view.containerEl.contains(range.commonAncestorContainer)) return null;

	const text = normalizeSelectionText(selection.toString());
	if (!text) return null;
	return { text, page: pageFromNode(range.startContainer) ?? getCurrentPdfPage(view) };
}

/** Debug helper used by the settings tab "diagnose PDF" button. */
export function describePdfView(view: PdfViewLike | null): string {
	if (!view) return '没有打开 PDF';
	const page = getCurrentPdfPage(view);
	return `${view.file.path} · 当前页 ${page ?? '未知'}`;
}
