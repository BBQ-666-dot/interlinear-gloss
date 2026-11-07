import type { GlossBlockData, GlossItem, GlossMode, GlossRequest } from '../types';
import type { TranslationProvider } from '../providers/provider';
import type { GlossLogger } from '../log';
import type { GlossSettings } from '../types';
import { chunkText } from './chunker';
import { resolveGlossary, glossaryVersion, checkGlossaryUsage } from './glossary';
import { buildTranslationPrompt, buildGlossaryPrompt, buildRepairPrompt, PROMPT_VERSION } from './prompt';
import { parseGlossResponse, recoverCandidateItems } from './parser';
import { protectText, restoreText } from './protect';

export interface EngineDeps {
	provider: TranslationProvider;
	settings: GlossSettings;
	log?: GlossLogger;
	shouldAbort?: () => boolean;
	onProgress?: (done: number, total: number, phase: 'translate' | 'glossary') => void;
}

export interface GeneratedGloss {
	data: GlossBlockData;
	warnings: string[];
	elapsedMs: number;
}

const CHUNK_CHARS = 1400;

const STOPWORDS = new Set([
	'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'and', 'or', 'but', 'if', 'then',
	'than', 'that', 'this', 'these', 'those', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it',
	'its', 'as', 'by', 'from', 'we', 'you', 'they', 'he', 'she', 'i', 'our', 'their', 'his', 'her',
	'my', 'not', 'no', 'do', 'does', 'did', 'can', 'could', 'will', 'would', 'shall', 'should', 'may',
	'might', 'must', 'have', 'has', 'had', 'which', 'who', 'whom', 'whose', 'what', 'when', 'where',
	'why', 'how', 'there', 'here', 'so', 'such', 'very', 'much', 'many', 'more', 'most', 'also',
	'only', 'just', 'about', 'into', 'over', 'under', 'between', 'through', 'during', 'before',
	'after', 'above', 'below', 'up', 'down', 'out', 'off', 'again', 'further', 'once', 'all', 'any',
	'both', 'each', 'few', 'other', 'some', 'own', 'same', 'too', 'now',
]);

/**
 * High-frequency filler that never blocks comprehension. Filtering these out of
 * the candidate list leaves room for the words that actually do (chapters,
 * correlated, trade-off) instead of glossing "serves" and "later".
 */
const FILLER = new Set([
	'begin', 'begins', 'start', 'starts', 'become', 'becomes', 'seem', 'seems', 'show', 'shows',
	'shown', 'give', 'gives', 'given', 'make', 'makes', 'made', 'take', 'takes', 'taken', 'use',
	'uses', 'used', 'using', 'include', 'includes', 'develop', 'developed', 'appear', 'appears',
	'serve', 'serves', 'consider', 'considers', 'need', 'needs', 'want', 'wants', 'know', 'knows',
	'think', 'thinks', 'find', 'finds', 'follow', 'follows', 'learn', 'learns', 'work', 'works',
	'call', 'calls', 'called', 'mean', 'means', 'form', 'forms', 'idea', 'ideas', 'book', 'books',
	'paper', 'text', 'reader', 'readers', 'later', 'earlier', 'firstly', 'finally',
	'also', 'thus', 'hence', 'therefore', 'however', 'moreover', 'furthermore', 'example',
	'receive', 'receives', 'received', 'write', 'writes', 'written', 'say', 'says', 'said',
]);

function normalizeInput(text: string): string {
	return text
		.replace(/\r\n?/g, '\n')
		.replace(/\u00a0/g, ' ')
		.replace(/[ \t]+\n/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

function truncateAtSentence(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const window = text.slice(0, limit);
	const cut = Math.max(
		window.lastIndexOf('. '),
		window.lastIndexOf('。'),
		window.lastIndexOf('! '),
		window.lastIndexOf('? '),
	);
	const end = cut > limit * 0.5 ? cut + 1 : limit;
	return `${text.slice(0, end).trim()}…`;
}

function joinTranslations(parts: string[]): string {
	let out = '';
	for (const raw of parts) {
		const part = raw.trim();
		if (!part) continue;
		if (!out) {
			out = part;
			continue;
		}
		const needsSpace = /[A-Za-z0-9]$/.test(out) && /^[A-Za-z0-9]/.test(part);
		out += needsSpace ? ` ${part}` : part;
	}
	return out;
}

export function mergeItems(target: GlossItem[], incoming: GlossItem[]): void {
	const seen = new Set(target.map((item) => item.source.toLowerCase()));
	for (const item of incoming) {
		const key = item.source.toLowerCase();
		if (!item.source || seen.has(key)) continue;
		seen.add(key);
		target.push(item);
	}
}

function normalizeItemText(value: string): string {
	return value.replace(/\s+/g, ' ').trim();
}

function sourceWordSet(text: string): Set<string> {
	const words = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
	const set = new Set<string>();
	for (const word of words) {
		set.add(word);
		const plural = word.replace(/(ies|es|s)$/, '');
		if (plural && plural !== word) set.add(plural);
		const stem = word.replace(/(ed|ing)$/, '');
		if (stem && stem !== word) set.add(stem);
	}
	return set;
}

/**
 * Models occasionally copy the few-shot rows from the prompt. An item whose
 * words do not occur in the source paragraph is noise, not a glossary entry.
 */
function sourceHasItem(text: string, source: string): boolean {
	const tokens = source.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
	if (!tokens.length) return false;
	const words = sourceWordSet(text);
	return tokens.every((token) => {
		const stem = token.replace(/(ies|es|s)$/, '');
		if (words.has(token) || words.has(stem)) return true;
		if (stem.length < 4) return false;
		for (const word of words) {
			if (word.length >= 4 && (word.startsWith(stem) || stem.startsWith(word))) return true;
		}
		return false;
	});
}

/** Reject function words and single letters that made it into a glossary row. */
export function isUsefulItem(text: string, item: GlossItem): boolean {
	const source = item.source.trim();
	if (source.replace(/\s/g, '').length < 2) return false;
	if (!/^[a-z][a-z'’\-\s]*$/i.test(source)) return false;
	const words = source.toLowerCase().split(/\s+/).filter(Boolean);
	if (words.every((word) => STOPWORDS.has(word))) return false;
	if (!item.target.trim() && !item.pos) return false;
	return sourceHasItem(text, source);
}

/** Evenly spaced subset that keeps the head, middle and tail of a list. */
function sampleEven<T>(items: T[], count: number): T[] {
	if (items.length <= count) return items.slice();
	const step = items.length / count;
	return Array.from({ length: count }, (_, index) =>
		items[Math.min(items.length - 1, Math.floor(index * step))],
	);
}

/**
 * Mechanical candidates so the glossary pass cannot skip the sentence's
 * backbone words (journey / map / chapters) just because they are not terms.
 * Words already covered by the built-in glossary are demoted: the reader knows
 * policy/reward, but not "a map for the ideas in later chapters".
 *
 * Picks are spread over the whole paragraph instead of taking the first N: a
 * long paragraph front-loads its topic words, and the words that actually
 * block comprehension (correlated, chapters) often sit near the end.
 */
export function pickCandidates(text: string, limit = 12, glossary: Record<string, string> = {}): string[] {
	const cleaned = text.replace(/⟦[^⟧]*⟧/g, ' ');
	const glossaryWords = new Set<string>();
	for (const key of Object.keys(glossary)) {
		for (const token of key.toLowerCase().split(/[^a-z'-]+/)) {
			if (token) glossaryWords.add(token);
		}
	}

	const seen = new Set<string>();
	const preferred: string[] = [];
	const demoted: string[] = [];
	for (const match of cleaned.matchAll(/[A-Za-z][A-Za-z'’\-]{2,}/g)) {
		const word = match[0].replace(/'s$/, '').toLowerCase();
		if (word.length < 3 || STOPWORDS.has(word) || FILLER.has(word) || seen.has(word)) continue;
		seen.add(word);
		(glossaryWords.has(word) ? demoted : preferred).push(word);
	}

	// Even spacing keeps first, middle and last words in the running, and keeps
	// the picks in their original order.
	const even = sampleEven;

	const picked = even(preferred, limit);
	const rest = even(demoted, limit - picked.length);
	return [...picked, ...rest].slice(0, limit);
}

async function chatOnce(deps: EngineDeps, model: string, prompt: string): Promise<string> {
	return deps.provider.chat({
		model,
		messages: [{ role: 'user', content: prompt }],
		temperature: deps.settings.temperature,
		maxTokens: deps.settings.maxTokens,
		numCtx: deps.settings.numCtx,
		timeoutMs: deps.settings.requestTimeoutMs,
	});
}

function translationFromRaw(raw: string): string {
	const parsed = parseGlossResponse(raw, { maxItems: 1 });
	if (parsed.translation.trim()) return parsed.translation;
	return raw.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim();
}

async function translateChunk(
	deps: EngineDeps,
	request: GlossRequest,
	model: string,
): Promise<{ text: string; issues: string[] }> {
	const raw = await chatOnce(deps, model, buildTranslationPrompt(request));
	const first = translationFromRaw(raw);
	if (first.length > 2) return { text: first, issues: [] };
	deps.log?.warn('translation came back empty, retrying with repair prompt');
	const repaired = await chatOnce(deps, model, buildRepairPrompt(request, raw, 'translation'));
	const second = translationFromRaw(repaired);
	return { text: second, issues: second.length > 2 ? ['translation-repaired'] : ['empty-translation'] };
}

async function glossaryChunk(
	deps: EngineDeps,
	request: GlossRequest,
	model: string,
): Promise<{ candidates: GlossItem[]; parsed: GlossItem[]; issues: string[] }> {
	const collect = (raw: string) => {
		const parsed = parseGlossResponse(raw, { maxItems: deps.settings.maxItems }).items.filter((item) =>
			isUsefulItem(request.text, item),
		);
		// Candidate words come first: they are the sentence's backbone, and the
		// model's own rows fill whatever slots are left.
		const candidates = recoverCandidateItems(raw, request.candidates ?? [], deps.settings.maxItems).filter(
			(item) => isUsefulItem(request.text, item),
		);
		return { candidates, parsed };
	};

	const raw = await chatOnce(deps, model, buildGlossaryPrompt(request));
	let collected = collect(raw);
	if (collected.candidates.length || collected.parsed.length) {
		return { ...collected, issues: [] };
	}

	deps.log?.warn('glossary rows unparsable, retrying with repair prompt');
	const repaired = await chatOnce(deps, model, buildRepairPrompt(request, raw, 'glossary'));
	collected = collect(repaired);
	const issues = collected.candidates.length || collected.parsed.length
		? ['glossary-repaired']
		: ['empty-items'];
	return { ...collected, issues };
}

/**
 * Candidates that came back from the model without a matching item. Compared
 * case-insensitively on the `source` column, since the model may echo the word
 * with a trailing period or different casing.
 */
export function missingCandidates(requests: GlossRequest[], items: GlossItem[]): string[] {
	const have = new Set(items.map((item) => item.source.toLowerCase().replace(/[^a-z'’\-\s]/g, '').trim()));
	const missing: string[] = [];
	const seen = new Set<string>();
	for (const request of requests) {
		for (const word of request.candidates ?? []) {
			const key = word.toLowerCase();
			if (seen.has(key) || have.has(key)) continue;
			seen.add(key);
			missing.push(word);
		}
	}
	return missing;
}

/** One narrow request per chunk for the words the first pass dropped. */
async function backfillCandidates(
	deps: EngineDeps,
	words: string[],
	requests: GlossRequest[],
	model: string,
): Promise<GlossItem[]> {
	const filled: GlossItem[] = [];
	for (const request of requests) {
		const here = words.filter((word) => new RegExp(`\\b${word}\\b`, 'i').test(request.text));
		if (!here.length) continue;
		const raw = await chatOnce(
			deps,
			model,
			buildGlossaryPrompt({ ...request, candidates: here, maxItems: here.length }),
		);
		const recovered = recoverCandidateItems(raw, here, here.length).filter((item) =>
			isUsefulItem(request.text, item),
		);
		mergeItems(filled, recovered);
	}
	return filled;
}

/**
 * Full pipeline: protect → chunk → translate → glossary → merge → restore.
 * Translation and glossary are separate calls because the fast translation
 * model ignores the "also produce a glossary" section (see prompt.ts).
 */
export async function generateGloss(text: string, deps: EngineDeps): Promise<GeneratedGloss> {
	const startedAt = Date.now();
	const settings = deps.settings;
	const normalized = normalizeInput(text);
	if (!normalized) throw new Error('没有可翻译的文本（选区为空）');

	const warnings: string[] = [];
	let sourceForModel = normalized;
	let truncated = false;
	if (normalized.length > settings.maxInputChars) {
		sourceForModel = truncateAtSentence(normalized, settings.maxInputChars);
		truncated = true;
		warnings.push(`原文超过 ${settings.maxInputChars} 字符，只翻译了前面的部分`);
	}

	const glossary = resolveGlossary(settings.customGlossary);
	const mode: GlossMode = settings.mode;
	const protectedText = protectText(sourceForModel);
	const chunks = chunkText(protectedText.text, { maxChars: Math.min(CHUNK_CHARS, settings.maxInputChars) });
	const translationModel = settings.model;
	const glossaryModel = (settings.glossaryModel || settings.model).trim();
	const includeItems = settings.includeItems !== false;

	const buildRequest = (chunk: string): GlossRequest => ({
		text: chunk,
		sourceLang: 'auto',
		targetLang: settings.targetLang,
		mode,
		glossary,
		maxItems: settings.maxItems,
		candidates: pickCandidates(chunk, Math.max(10, Math.min(settings.maxItems, 24)), glossary),
	});

	// Pass 1: translation.
	const translations: string[] = [];
	const issueCount = new Map<string, number>();
	for (let index = 0; index < chunks.length; index++) {
		if (deps.shouldAbort?.()) throw new Error('生成已取消');
		const result = await translateChunk(deps, buildRequest(chunks[index]), translationModel);
		if (result.text) translations.push(result.text);
		for (const issue of result.issues) issueCount.set(issue, (issueCount.get(issue) ?? 0) + 1);
		deps.onProgress?.(index + 1, chunks.length, 'translate');
	}

	// Pass 2: glossary (can be turned off, or sent to a stronger model).
	// Candidate-backed items are kept apart from the model's own picks so the
	// backbone words survive the maxItems cut.
	const candidateItems: GlossItem[] = [];
	const modelItems: GlossItem[] = [];
	let usedGlossaryModel = glossaryModel;
	const requests = chunks.map((chunk) => buildRequest(chunk));
	if (includeItems && mode !== 'portable') {
		for (let index = 0; index < chunks.length; index++) {
			if (deps.shouldAbort?.()) throw new Error('生成已取消');
			const result = await glossaryChunk(deps, requests[index], usedGlossaryModel);
			mergeItems(candidateItems, result.candidates);
			mergeItems(modelItems, result.parsed);
			for (const issue of result.issues) issueCount.set(issue, (issueCount.get(issue) ?? 0) + 1);
			deps.onProgress?.(index + 1, chunks.length, 'glossary');
		}

		// Candidates the model skipped get one short, focused request. Without
		// this the block silently loses exactly the words it was built to cover.
		const seen = [...candidateItems, ...modelItems];
		const missing = missingCandidates(requests, seen).slice(0, 12);
		if (missing.length) {
			deps.log?.warn(`backfilling ${missing.length} skipped candidates`, missing.join(', '));
			try {
				const filled = await backfillCandidates(deps, missing, requests, usedGlossaryModel);
				mergeItems(candidateItems, filled);
			} catch (error) {
				deps.log?.warn('candidate backfill failed', error instanceof Error ? error.message : String(error));
			}
		}
		const stillMissing = missingCandidates(requests, [...candidateItems, ...modelItems]);
		if (stillMissing.length) {
			warnings.push(
				`有 ${stillMissing.length} 个候选词没取到释义：${stillMissing.slice(0, 6).join('、')}`,
			);
		}

		// A long candidate list sometimes makes the small glossary model answer in
		// prose instead of rows. One retry with a short list is cheaper than an
		// empty table.
		if (candidateItems.length + modelItems.length === 0) {
			deps.log?.warn('glossary pass produced nothing, retrying with a short candidate list');
			for (const request of requests) {
				const short = sampleEven(request.candidates ?? [], 8);
				if (!short.length) continue;
				try {
					const result = await glossaryChunk(deps, { ...request, candidates: short }, usedGlossaryModel);
					mergeItems(candidateItems, result.candidates);
					mergeItems(modelItems, result.parsed);
				} catch (error) {
					deps.log?.warn('short-list retry failed', error instanceof Error ? error.message : String(error));
				}
			}
			if (candidateItems.length + modelItems.length) warnings.push('词义表用短候选列表重试后生成');
		}
	}

	// Quality fallback: the glossary model produced nothing usable.
	if (
		includeItems &&
		settings.qualityFallback &&
		settings.fallbackModel &&
		settings.fallbackModel !== usedGlossaryModel &&
		candidateItems.length + modelItems.length === 0 &&
		chunks.length > 0
	) {
		deps.log?.warn('no items from glossary model, retrying with fallback', settings.fallbackModel);
		try {
			const fallbackItems: GlossItem[] = [];
			for (const chunk of chunks) {
				const result = await glossaryChunk(deps, buildRequest(chunk), settings.fallbackModel);
				mergeItems(fallbackItems, result.candidates);
				mergeItems(fallbackItems, result.parsed);
			}
			if (fallbackItems.length) {
				usedGlossaryModel = settings.fallbackModel;
				mergeItems(modelItems, fallbackItems);
				warnings.push(`词义由 ${settings.fallbackModel} 补上`);
			}
		} catch (error) {
			warnings.push(`高质量模型重试失败：${error instanceof Error ? error.message : String(error)}`);
		}
	}

	// Candidate words keep their priority; the model's own rows use what is left.
	const items: GlossItem[] = [];
	mergeItems(items, candidateItems);
	mergeItems(items, modelItems);
	const keptItems = items.slice(0, Math.max(settings.maxItems, 0));

	let translation = joinTranslations(translations);
	const restored = restoreText(translation, protectedText);
	translation = restored.text;
	if (restored.missing.length) {
		warnings.push(`${restored.missing.length} 处公式/代码没能在译文中还原`);
		// Keep the protected spans rather than silently dropping the formula.
		if (restored.missing.length <= 4) {
			translation += ` ${restored.missing.map((token) => token.original).join(' ')}`;
		}
	}

	for (const item of keptItems) {
		item.source = normalizeItemText(restoreText(item.source, protectedText).text);
		item.target = normalizeItemText(restoreText(item.target, protectedText).text);
	}

	const glossaryIssues = checkGlossaryUsage(sourceForModel, translation, glossary);
	for (const issue of glossaryIssues) {
		warnings.push(`术语「${issue.term}」应译为「${issue.expected}」，译文中出现了「${issue.found}」`);
	}

	if (issueCount.size) {
		const summary = Array.from(issueCount.entries())
			.map(([issue, count]) => `${issue}×${count}`)
			.join(', ');
		deps.log?.warn('parser issues', summary);
		if (issueCount.get('empty-items')) warnings.push('模型没有按要求给出词义表');
	}
	if (!includeItems) warnings.push('已关闭词义整理，只保存译文');

	const data: GlossBlockData = {
		version: 1,
		sourceText: sourceForModel,
		translation,
		items: keptItems,
		mode,
		model: translationModel,
		createdAt: Date.now(),
		meta: {
			glossaryVersion: glossaryVersion(glossary),
			promptVersion: PROMPT_VERSION,
			chunks: chunks.length,
			warnings: warnings.length ? warnings : undefined,
			truncated: truncated || undefined,
			glossaryModel: includeItems ? usedGlossaryModel : undefined,
		},
	};

	return { data, warnings, elapsedMs: Date.now() - startedAt };
}
