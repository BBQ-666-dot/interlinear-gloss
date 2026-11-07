import type { GlossRequest } from '../types';
import { glossaryPromptLines } from './glossary';

export const PROMPT_VERSION = 3;

/**
 * Measured on this machine (2026-11):
 *  - hy-mt2-1.8b is a translation-first model: it answers the translation and
 *    stops, ignoring any "also produce a glossary" section.
 *  - hy-mt2-7b follows the section contract but writes sloppy table rows.
 *  - qwen2.5:3b writes clean `word | pos | meaning` rows.
 * So translation and glossary are two separate calls with two prompts, each of
 * which can point at a different model.
 */

export function buildTranslationPrompt(req: GlossRequest): string {
	return [
		'你是一名严谨的学术翻译助手，负责把强化学习与数学教材的英文段落翻译成简体中文。',
		'',
		'要求：',
		'1. 译文要准确、通顺，符合作者原意与教材语气。',
		'2. 保持数学公式、代码、引用编号、URL 原样不变。',
		'3. 文中形如 ⟦MATH1⟧、⟦CODE2⟧、⟦URL3⟧ 的标记是受保护的公式/代码/链接，必须原样保留，不要翻译、不要拆开、不要改写括号。',
		'4. 只输出译文本身：不要标题、不要解释、不要开场白、不要引号、不要代码块。',
		'',
		'原文：',
		req.text,
	].join('\n');
}

export function buildGlossaryPrompt(req: GlossRequest): string {
	const glossary = glossaryPromptLines(req.glossary);
	const candidates = (req.candidates ?? []).slice(0, 24);
	const lines: string[] = [];

	if (candidates.length) {
		// Naming the words beats asking a 3B model to choose them: "pick the key
		// words yourself" loses the sentence's backbone (journey / map / later).
		lines.push(
			`下面是英文教材片段和从中挑出的 ${candidates.length} 个关键词。请为每个关键词写一行释义，三列用竖线分隔：英文 | 词性 | 中文释义。`,
		);
		lines.push('');
		lines.push(`关键词：${candidates.join('、')}`);
		lines.push('');
		lines.push('要求：');
		lines.push('1. 英文列照抄上面的词，不要加序号、标点或复数变化。');
		lines.push('2. 词性用缩写：n. / v. / adj. / adv. / prep. / conj. / pron. / phr.。');
		lines.push('3. 中文释义要贴合这个词在下面这句话里的意思，尽量短：不超过 12 个字，不要例句、不要解释。');
		if (glossary) {
			lines.push('4. 以下术语必须使用给定译法（命中时必须照用）：');
			lines.push(glossary);
		}
		lines.push('');
		lines.push('只输出这些行本身：不要译文、不要解释、不要标题、不要编号、不要表头、不要代码块。');
		lines.push('');
		lines.push('英文片段：');
		lines.push(req.text);
		return lines.join('\n');
	}

	const upper = Math.max(req.maxItems, 10);
	const countLine = upper > 10 ? `10–${upper} 条` : `最多 ${req.maxItems} 条`;
	lines.push(
		`下面是英文教材片段。请挑出对理解这句话最关键的单词或短语，${countLine}，每行一条，三列用竖线分隔：英文 | 词性 | 中文释义。`,
	);
	lines.push('');
	lines.push('要求：');
	lines.push('1. 只收实词和术语（名词、动词、形容词、副词、重要短语），不要 the / of / in 这类虚词，不要单个字母或符号。');
	lines.push('2. 词性用缩写：n. / v. / adj. / adv. / prep. / conj. / pron. / phr.。');
	lines.push('3. 英文列必须是原文里出现的写法；中文释义要贴合这句话里的意思。');
	lines.push(
		'4. 优先收录句子的骨架词——承担具体意思的名词与动词，包括 journey、map、chapter 这类比喻性或抽象的说法，不要只挑领域术语。',
	);
	if (glossary) {
		lines.push('5. 以下术语必须使用给定译法（原文命中时必须照用）：');
		lines.push(glossary);
	}
	lines.push('');
	lines.push('只输出这些行本身：不要译文、不要解释、不要标题、不要编号、不要表头、不要代码块。');
	lines.push('');
	lines.push('英文片段：');
	lines.push(req.text);

	return lines.join('\n');
}

/** Second attempt after a parse failure: restate the contract, drop the text. */
export function buildRepairPrompt(req: GlossRequest, previous: string, kind: 'translation' | 'glossary'): string {
	const trimmed = previous.length > 1200 ? `${previous.slice(0, 1200)}…` : previous;
	if (kind === 'translation') {
		return [
			'你上一次的输出不符合要求，无法当作译文使用。',
			'请只输出一段简体中文译文，不要标题、不要解释、不要引号、不要代码块。',
			'原文：',
			req.text,
		].join('\n');
	}
	return [
		'你上一次的输出格式不符合要求，无法解析。',
		'请只输出词义行，每行三列用竖线分隔：英文 | 词性 | 中文释义。',
		'不要译文、不要解释、不要编号、不要表头、不要代码块。',
		'',
		'术语表（必须照用）：',
		glossaryPromptLines(req.glossary, 40),
		'',
		'英文片段：',
		req.text,
		'',
		'你上一次的输出（仅作参考，不要照抄错误格式）：',
		trimmed,
	].join('\n');
}
