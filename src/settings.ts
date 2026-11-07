import type { GlossSettings } from './types';

export const DEFAULT_SETTINGS: GlossSettings = {
	provider: 'ollama',
	baseUrl: 'http://127.0.0.1:11434',
	model: 'hy-mt2-1.8b-q8:latest',
	glossaryModel: 'qwen2.5:3b',
	fallbackModel: 'hy-mt2-7b-q5:latest',
	includeItems: true,
	temperature: 0.2,
	maxTokens: 1024,
	numCtx: 8192,
	requestTimeoutMs: 60000,
	targetLang: 'zh-Hans',
	mode: 'keywords',
	maxItems: 20,
	maxInputChars: 4000,
	customGlossary: '',
	qualityFallback: true,
	showSourceInBlock: false,
	pdfCacheInVault: true,
	pdfCacheFolder: 'Glosses/pdf',
	pdfMarksEnabled: true,
	offlineDictionaryEnabled: true,
	offlineDictionaryFallback: true,
	offlineSenseSelection: true,
	pdfMarkModel: '',
	pdfMarkSenseModel: 'qwen2.5:3b',
	pdfMarkLabelMode: 'none',
	pdfMarkFontScale: 1,
	pdfMarkColor: 'yellow',
	pdfMarkOpacity: 0.9,
	pdfMarkShowPos: false,
	pdfMarkCacheInVault: true,
	pdfMarkCacheFolder: 'Glosses/pdf',
	pdfMarkMaxChars: 40,
};

export const TARGET_LANG_LABEL: Record<string, string> = {
	'zh-Hans': '简体中文',
	'zh-Hant': '繁體中文',
	en: 'English',
};

export function targetLangName(code: string): string {
	return TARGET_LANG_LABEL[code] ?? '简体中文';
}

export function mergeSettings(raw: unknown): GlossSettings {
	const base: GlossSettings = { ...DEFAULT_SETTINGS };
	if (!raw || typeof raw !== 'object') return base;
	const src = raw as Record<string, unknown>;
	for (const key of Object.keys(base) as (keyof GlossSettings)[]) {
		const value = src[key];
		if (value === undefined || value === null) continue;
		if (typeof base[key] === 'number' && typeof value === 'number') {
			(base as unknown as Record<string, unknown>)[key] = value;
		} else if (typeof base[key] === 'boolean' && typeof value === 'boolean') {
			(base as unknown as Record<string, unknown>)[key] = value;
		} else if (typeof base[key] === 'string' && typeof value === 'string') {
			(base as unknown as Record<string, unknown>)[key] = value;
		}
	}
	// Clamp values that would make the model unusable.
	base.temperature = Math.min(2, Math.max(0, base.temperature));
	base.maxTokens = Math.min(8192, Math.max(64, Math.round(base.maxTokens)));
	base.numCtx = Math.min(131072, Math.max(1024, Math.round(base.numCtx)));
	base.maxItems = Math.min(60, Math.max(1, Math.round(base.maxItems)));
	base.maxInputChars = Math.min(20000, Math.max(200, Math.round(base.maxInputChars)));
	base.requestTimeoutMs = Math.min(300000, Math.max(5000, Math.round(base.requestTimeoutMs)));
	base.pdfMarkFontScale = Math.min(2, Math.max(0.6, Number.isFinite(base.pdfMarkFontScale) ? base.pdfMarkFontScale : 1));
	base.pdfMarkOpacity = Math.min(1, Math.max(0.2, Number.isFinite(base.pdfMarkOpacity) ? base.pdfMarkOpacity : 0.9));
	base.pdfMarkMaxChars = Math.min(80, Math.max(10, Math.round(base.pdfMarkMaxChars)));
	if (!['gap', 'overlap', 'margin', 'hover', 'none'].includes(base.pdfMarkLabelMode)) base.pdfMarkLabelMode = 'none';
	if (!['yellow', 'green', 'blue', 'pink'].includes(base.pdfMarkColor)) base.pdfMarkColor = 'yellow';
	if (!base.baseUrl.trim()) base.baseUrl = DEFAULT_SETTINGS.baseUrl;
	return base;
}

