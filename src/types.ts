/** Shared data contracts for the Interlinear Gloss plugin. */

export type GlossMode = 'keywords' | 'strict' | 'portable';

export type ProviderId = 'ollama' | 'openai';

export interface GlossItem {
	source: string;
	target: string;
	pos?: string;
	note?: string;
}

export interface GlossMeta {
	glossaryVersion?: string;
	promptVersion?: number;
	chunks?: number;
	warnings?: string[];
	truncated?: boolean;
	degraded?: boolean;
	/** Model used for the glossary pass when it differs from the translator. */
	glossaryModel?: string;
}

/** Payload stored inside a ```gloss fenced block. */
export interface GlossBlockData {
	version: 1;
	sourceText: string;
	translation: string;
	items: GlossItem[];
	mode: GlossMode;
	model: string;
	createdAt: number;
	meta?: GlossMeta;
}

export interface GlossRequest {
	text: string;
	sourceLang: 'auto' | 'en';
	targetLang: string;
	mode: GlossMode;
	glossary: Record<string, string>;
	maxItems: number;
	/** Mechanically extracted content words the glossary prompt asks to cover. */
	candidates?: string[];
}

export interface GlossResult {
	translation: string;
	items: GlossItem[];
	raw?: string;
	model: string;
	createdAt: number;
	warnings?: string[];
	meta?: GlossMeta;
}

export interface PdfGlossRecord extends GlossResult {
	id: string;
	pdfPath: string;
	/** null when the viewer could not report the page (allowed by design). */
	page: number | null;
	sourceText: string;
	quoteBefore?: string;
	quoteAfter?: string;
	mode: GlossMode;
}

export interface GlossSettings {
	provider: ProviderId;
	baseUrl: string;
	model: string;
	/** Translation is done by `model`; the glossary pass can use a stronger one. */
	glossaryModel: string;
	fallbackModel: string;
	includeItems: boolean;
	temperature: number;
	maxTokens: number;
	numCtx: number;
	requestTimeoutMs: number;
	targetLang: string;
	mode: GlossMode;
	maxItems: number;
	maxInputChars: number;
	customGlossary: string;
	qualityFallback: boolean;
	showSourceInBlock: boolean;
	pdfCacheInVault: boolean;
	pdfCacheFolder: string;

	/** Word-level PDF marks. */
	pdfMarksEnabled: boolean;
	offlineDictionaryEnabled: boolean;
	offlineDictionaryFallback: boolean;
	offlineSenseSelection: boolean;
	pdfMarkModel: string;
	pdfMarkSenseModel: string;
	pdfMarkLabelMode: MarkLabelMode;
	pdfMarkFontScale: number;
	pdfMarkColor: MarkColor;
	pdfMarkOpacity: number;
	pdfMarkShowPos: boolean;
	pdfMarkCacheInVault: boolean;
	pdfMarkCacheFolder: string;
	pdfMarkMaxChars: number;
}

export interface PdfCacheFile {
	version: 1;
	pdfPath: string;
	updatedAt: number;
	records: Record<string, PdfGlossRecord>;
}

/* ------------------------------------------------------------------ */
/* PDF word marks (word-level annotation on top of the PDF text layer) */
/* ------------------------------------------------------------------ */

/** Rectangle relative to the page element: 0..1 of width/height. */
export interface NormalizedRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export type MarkColor = 'yellow' | 'green' | 'blue' | 'pink';

/** gap: squeeze between two lines; overlap/margin/hover are degradations; none hides labels. */
export type MarkLabelMode = 'gap' | 'overlap' | 'margin' | 'hover' | 'none';

export interface PdfWordMark {
	id: string;
	pdfPath: string;
	page: number;
	text: string;
	translation: string;
	pos?: string;
	rects: NormalizedRect[];
	quoteBefore: string;
	quoteAfter: string;
	color: MarkColor;
	labelMode?: MarkLabelMode;
	model: string;
	createdAt: number;
	updatedAt: number;
}

export interface PdfMarkFile {
	version: 1;
	pdfPath: string;
	updatedAt: number;
	marks: PdfWordMark[];
}

/** Raw selection geometry captured from the PDF text layer. */
export interface PdfWordSelection {
	text: string;
	page: number;
	rects: NormalizedRect[];
	quoteBefore: string;
	quoteAfter: string;
	/** CSS px relative to the page element. */
	lineTop: number;
	lineBottom: number;
	nextLineTop: number | null;
	/** Font size of the line the selection sits on, in CSS px. */
	lineFontSize: number;
}
