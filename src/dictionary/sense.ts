import type { GlossSettings } from '../types';
import type { TranslationProvider } from '../providers/provider';

/**
 * Dictionary-grounded word sense selection.
 *
 * The dictionary provides the candidate meanings; the model only picks an
 * index. It cannot invent a meaning outside the list, which is exactly what
 * went wrong when 3B translated "obtain" as "回报" from free text.
 */

export interface SenseChoice {
	translation: string;
	index: number;
	model: string;
}

function trimContext(value: string, limit: number): string {
	const text = value.replace(/\s+/g, ' ').trim();
	if (text.length <= limit) return text;
	return '…' + text.slice(-limit + 1);
}

export function senseModel(settings: GlossSettings): string {
	return settings.pdfMarkSenseModel.trim() || settings.glossaryModel.trim() || settings.model;
}

export function buildSensePrompt(
	word: string,
	quoteBefore: string,
	quoteAfter: string,
	candidates: string[],
): string {
	const context = `${trimContext(quoteBefore, 160)}${word}${trimContext(quoteAfter, 160)}`;
	return [
		'你在做词典义项选择。根据上下文，从下面的候选释义中选出最符合这个单词在句子里意思的一项。',
		`只输出一个阿拉伯数字编号（1-${candidates.length}），不要解释、不要标点、不要其他文字。`,
		'',
		`上下文：${context}`,
		`单词：${word}`,
		'候选：',
		...candidates.map((candidate, index) => `${index + 1}. ${candidate}`),
	].join('\n');
}

/** Pull the first valid 1-based index out of the model output. */
export function parseSenseChoice(raw: string, candidateCount: number): number | null {
	if (!raw || candidateCount < 1) return null;
	const match = raw.match(/\d+/);
	if (!match) return null;
	const index = Number.parseInt(match[0], 10);
	return Number.isFinite(index) && index >= 1 && index <= candidateCount ? index : null;
}

export async function chooseOfflineSense(
	provider: TranslationProvider,
	settings: GlossSettings,
	word: string,
	quoteBefore: string,
	quoteAfter: string,
	candidates: string[],
	log?: { warn: (message: string, detail?: unknown) => void },
): Promise<SenseChoice | null> {
	if (candidates.length < 2) return null;
	const model = senseModel(settings);
	if (!model) return null;

	const prompt = buildSensePrompt(word, quoteBefore, quoteAfter, candidates);
	try {
		const raw = await provider.chat({
			model,
			messages: [
				{ role: 'system', content: '你是词义消歧助手，只输出一个数字编号，不要输出其他内容。' },
				{ role: 'user', content: prompt },
			],
			temperature: 0.1,
			maxTokens: 16,
			numCtx: settings.numCtx,
			timeoutMs: Math.min(settings.requestTimeoutMs, 30000),
		});
		const index = parseSenseChoice(raw, candidates.length);
		if (!index) {
			log?.warn('义项选择返回无法解析', raw);
			return null;
		}
		return { translation: candidates[index - 1], index, model };
	} catch (error) {
		log?.warn('义项选择失败', error instanceof Error ? error.message : String(error));
		return null;
	}
}
