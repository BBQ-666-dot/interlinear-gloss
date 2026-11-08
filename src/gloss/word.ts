import type { GlossSettings } from '../types';
import type { TranslationProvider } from '../providers/provider';
import { resolveGlossary, glossaryPromptLines } from './glossary';
import { buildTranslationPrompt } from './prompt';

/**
 * Word-level translation for PDF marks. Deliberately separate from the
 * paragraph engine: one word, one short answer, no chunking, no items table.
 */

export const WORD_PROMPT_VERSION = 1;
const DEFAULT_MAX_CHARS = 12;

export interface WordRequest {
	text: string;
	quoteBefore: string;
	quoteAfter: string;
	settings: GlossSettings;
}

export interface WordTranslation {
	translation: string;
	model: string;
}

/** Which model answers word lookups: explicit setting, else the glossary model. */
export function wordModel(settings: GlossSettings): string {
	return settings.pdfMarkModel.trim() || settings.glossaryModel.trim() || settings.model;
}

function trimContext(value: string, limit: number): string {
	const text = value.replace(/\s+/g, ' ').trim();
	if (text.length <= limit) return text;
	return '…' + text.slice(-limit + 1);
}

export function buildWordPrompt(
	text: string,
	quoteBefore: string,
	quoteAfter: string,
	glossary: Record<string, string>,
	maxChars = DEFAULT_MAX_CHARS,
): string {
	const before = trimContext(quoteBefore, 140);
	const after = trimContext(quoteAfter, 140);
	const terms = glossaryPromptLines(glossary, 40);
	const lines = [
		'你是词典助手。请根据上下文，把选中的英文单词或短语译成简体中文。',
		`只输出译文，最多 ${maxChars} 个汉字，不要解释、不要引号、不要词性说明、不要例句。`,
		// Without the examples qwen2.5:3b drops the 「的」 on adjectives
		// (correlated → 相关) and adds it to nouns (chapters → 章节的).
		'形容词用「…的」形式（greedy → 贪婪的），名词保持原形（journey → 旅程、exploration → 探索、chapters → 章节）。',
	];
	if (terms) {
		lines.push('必须使用以下术语：');
		lines.push(terms);
	}
	lines.push(`上下文：${before}${text}${after}`);
	lines.push(`选中内容：${text}`);
	return lines.join('\n');
}

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/;

function stripWrappingQuotes(value: string): string {
	const pairs: Array<[string, string]> = [
		['「', '」'],
		['『', '』'],
		['“', '”'],
		['‘', '’'],
		['《', '》'],
		['"', '"'],
		["'", "'"],
	];
	let out = value.trim();
	for (const [open, close] of pairs) {
		if (out.startsWith(open) && out.endsWith(close) && out.length > 2) {
			out = out.slice(open.length, out.length - close.length).trim();
		}
	}
	return out;
}

/**
 * Models love to answer with "译文：xxx（n.）" or a quoted phrase. Reduce all of
 * that to one short line, and give up (empty string) when there is no Chinese.
 */
export function cleanWordTranslation(raw: string, maxChars = DEFAULT_MAX_CHARS): string {
	if (!raw) return '';
	let text = raw.replace(/\r/g, '').replace(/```[a-z]*/gi, '').trim();

	// A table row or "word | n. | 释义" — keep the cell that holds the Chinese.
	if (text.includes('|')) {
		const cells = text
			.split('|')
			.map((cell) => cell.trim())
			.filter(Boolean);
		const cjkCell = cells.find((cell) => CJK.test(cell));
		if (cjkCell) text = cjkCell;
	}

	const firstLine = text
		.split('\n')
		.map((line) => line.trim())
		.find((line) => line.length > 0);
	if (!firstLine) return '';

	text = firstLine
		.replace(/^(?:译文|词义|释义|中文|翻译|答案|输出|Translation|Meaning)\s*[:：]\s*/i, '')
		.replace(/^[\s*`_>#-]+/, '')
		.replace(/\s*[（(][^（()）]{0,12}[)）]\s*$/, '')
		.trim();
	text = stripWrappingQuotes(text);
	text = text.replace(/[。．.、,，;；:：!！?？~～\s]+$/, '').trim();
	text = text.replace(/\s+/g, ' ');

	if (!CJK.test(text)) return '';

	if (text.length > maxChars) {
		const head = text.slice(0, maxChars);
		const cut = head.search(/[，,；;、]/);
		text = cut > 1 ? head.slice(0, cut) : head;
	}
	return text;
}

/** Strip a translation-only model's preamble, fences and wrapping quotes. */
export function cleanSentenceTranslation(raw: string): string {
	let text = raw.replace(/\r\n?/g, '\n').trim();
	const fenced = text.match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```$/);
	if (fenced) text = fenced[1].trim();
	text = text
		.replace(/【\s*译\s*文\s*】/g, '')
		.replace(/^\s*(?:译文|翻译|Translation)\s*[:：]\s*/i, '')
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean)
		.join(' ')
		.replace(/^[\s*`_>#-]+/, '')
		.replace(/^["'“”‘’「」『』]+|["'“”‘’「」『』]+$/g, '')
		.replace(/\s+/g, ' ')
		.trim();
	return /[\u3400-\u9fff]/.test(text) ? text : '';
}

export async function translateSentence(
	provider: TranslationProvider,
	sentence: string,
	settings: GlossSettings,
	log?: { warn: (message: string, detail?: unknown) => void },
): Promise<{ translation: string; model: string }> {
	const model = settings.model;
	const prompt = buildTranslationPrompt({
		text: sentence,
		sourceLang: 'en',
		targetLang: settings.targetLang,
		mode: settings.mode,
		glossary: resolveGlossary(settings.customGlossary),
		maxItems: 1,
	});
	const raw = await provider.chat({
		model,
		messages: [
			{ role: 'system', content: '你是学术翻译助手，只输出简体中文译文。' },
			{ role: 'user', content: prompt },
		],
		temperature: settings.temperature,
		maxTokens: Math.min(settings.maxTokens, 512),
		numCtx: settings.numCtx,
		timeoutMs: Math.min(settings.requestTimeoutMs, 60000),
	});
	const translation = cleanSentenceTranslation(raw);
	if (!translation) {
		log?.warn('整句翻译为空', model);
		throw new Error('整句翻译为空');
	}
	return { translation, model };
}

export async function translateWordInContext(
	provider: TranslationProvider,
	req: WordRequest,
	log?: { warn: (message: string, detail?: unknown) => void },
): Promise<WordTranslation> {
	const settings = req.settings;
	const glossary = resolveGlossary(settings.customGlossary);
	const maxChars = DEFAULT_MAX_CHARS;
	const prompt = buildWordPrompt(req.text, req.quoteBefore, req.quoteAfter, glossary, maxChars);
	const primary = wordModel(settings);
	const fallback = settings.model;

	const ask = async (model: string): Promise<string> => {
		const raw = await provider.chat({
			model,
			messages: [
				{ role: 'system', content: '你是词典助手，只输出一行简体中文词义。' },
				{ role: 'user', content: prompt },
			],
			temperature: 0.1,
			maxTokens: 64,
			// Same num_ctx as the paragraph engine on purpose: Ollama reloads a
			// model whenever num_ctx changes, and alternating between the two
			// features would cost seconds per lookup.
			numCtx: settings.numCtx,
			timeoutMs: Math.min(settings.requestTimeoutMs, 30000),
		});
		return cleanWordTranslation(raw, maxChars);
	};

	try {
		const translation = await ask(primary);
		if (translation) return { translation, model: primary };
		log?.warn('词义为空，尝试兜底模型', primary);
	} catch (error) {
		if (!fallback || fallback === primary) throw error;
		log?.warn('词义模型调用失败，尝试兜底模型', error);
	}

	if (fallback && fallback !== primary) {
		const translation = await ask(fallback);
		if (translation) return { translation, model: fallback };
	}
	throw new Error('没有取到中文释义，请换一个模型或稍后重试');
}
