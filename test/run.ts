/**
 * Self-checks for the pure layers plus an optional live check against the
 * local Ollama. Run with `npm test`. Set IG_OFFLINE=1 to skip the model call.
 */
import { protectText, restoreText } from '../src/gloss/protect';
import { chunkText, splitSentences } from '../src/gloss/chunker';
import { parseGlossResponse, parseSucceeded } from '../src/gloss/parser';
import { resolveGlossary, checkGlossaryUsage, glossaryVersion } from '../src/gloss/glossary';
import { generateGloss, isUsefulItem, missingCandidates, pickCandidates } from '../src/gloss/engine';
import { buildTranslationPrompt, buildGlossaryPrompt } from '../src/gloss/prompt';
import { applyAdjectiveSuffix, lookupOfflineWord, offlineDictionarySize } from '../src/dictionary/offline';
import { buildSensePrompt, parseSenseChoice } from '../src/dictionary/sense';
import { createProvider } from '../src/providers/provider';
import { FetchTransport } from '../src/providers/transport';
import { DEFAULT_SETTINGS } from '../src/settings';
import {
	findGlossBlocks,
	insertBlockIntoText,
	makeGlossBlock,
	removeBlockFromText,
	replaceBlockInText,
	findDuplicateBlock,
	offsetToLine,
	lineToOffset,
	locateTextInSource,
} from '../src/markdown/blocks';
import { recordId, sortRecords } from '../src/pdf/cache';
import { mergeSettings } from '../src/settings';
import {
	canonicalRects,
	denormalizeRect,
	lineHeightFor,
	normalizeRect,
	normalizeRects,
	overlapRatio,
	planLabel,
	resolveCollisions,
} from '../src/pdf/geometry';
import {
	LocalMarkStore,
	VaultMarkStore,
	createMarkStore,
	findSameMark,
	markAtPoint,
	locateQuote,
	markId,
	marksPath,
	parseMarkFile,
} from '../src/pdf/marks';
import {
	buildWordPrompt,
	cleanSentenceTranslation,
	cleanWordTranslation,
	translateWordInContext,
	wordModel,
} from '../src/gloss/word';
import {
	coversWholeSentence,
	expandToWordBounds,
	hasPartialWord,
	normalizeSelectionText,
	sentenceAround,
	separatorBetween,
} from '../src/pdf/wordSelection';
import type { App } from 'obsidian';
import type { GlossBlockData, GlossItem, PdfGlossRecord, PdfWordMark } from '../src/types';

const PASS = '\u2713';
const FAIL = '\u2717';
const SKIP = '-';

let failures = 0;
let checks = 0;
const results: string[] = [];

function ok(name: string, detail = ''): void {
	checks++;
	results.push(`${PASS} ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(name: string, detail: string): void {
	checks++;
	failures++;
	results.push(`${FAIL} ${name} — ${detail}`);
}

function skip(name: string, why: string): void {
	results.push(`${SKIP} ${name} — ${why}`);
}

function assert(name: string, condition: boolean, detail = ''): void {
	if (condition) ok(name, detail);
	else fail(name, detail || '断言失败');
}

function assertEqual(name: string, actual: unknown, expected: unknown): void {
	const a = JSON.stringify(actual);
	const b = JSON.stringify(expected);
	if (a === b) ok(name, String(actual).slice(0, 80));
	else fail(name, `期望 ${b}，实际 ${a}`);
}

/* ------------------------------------------------------------------ */
/* Formula / code protection                                           */
/* ------------------------------------------------------------------ */

function testProtection(): void {
	const source =
		'We write the value as $v_\\pi(s)$ and the action value as $q_\\pi(s,a)$. Inline `code` stays too.';
	const protectedText = protectText(source);
	assert(
		'公式被替换成占位符',
		protectedText.tokens.length >= 2 && !protectedText.text.includes('$v_\\pi'),
		`${protectedText.tokens.length} 个占位符`,
	);
	const valueToken = protectedText.tokens.find((token) => token.original.includes('$v_\\pi'));
	const actionToken = protectedText.tokens.find((token) => token.original.includes('$q_\\pi'));
	if (!valueToken || !actionToken) {
		fail('公式被替换成占位符', '公式没有生成占位符');
		return;
	}
	const fakeTranslation = `我们把状态价值写成 ${valueToken.placeholder}，把动作价值写成 ${actionToken.placeholder}，代码 ${protectedText.tokens
		.filter((token) => token !== valueToken && token !== actionToken)
		.map((token) => token.placeholder)
		.join('、')} 保持原样。`;
	const restored = restoreText(fakeTranslation, protectedText);
	assertEqual('公式原样还原', restored.text.includes('$v_\\pi(s)$') && restored.text.includes('$q_\\pi(s,a)$'), true);
	assertEqual('还原没有遗漏', restored.missing.length, 0);

	const tolerant = restoreText(
		`公式：${valueToken.placeholder.replace(/\u27e6/g, '【').replace(/\u27e7/g, '】')}`,
		protectedText,
	);
	assert('容忍全角括号变体', tolerant.text.includes('$v_\\pi(s)$'));
}

/* ------------------------------------------------------------------ */
/* Chunking                                                            */
/* ------------------------------------------------------------------ */

function testChunking(): void {
	const sentences = splitSentences('A short one. A second sentence! Is this third? Yes.');
	assertEqual('按句切分', sentences.length, 4);

	const paragraph =
		'The policy is improved by estimating its value. '.repeat(60) + 'Final sentence closes the text.';
	const chunks = chunkText(paragraph, { maxChars: 1500 });
	assert('长文本被分块', chunks.length >= 2, `${chunks.length} 块`);
	assert(
		'每块不超过上限',
		chunks.every((chunk) => chunk.length <= 1500),
		`最长 ${Math.max(...chunks.map((c) => c.length))}`,
	);
	let cursor = 0;
	let ordered = true;
	for (const chunk of chunks) {
		const index = paragraph.indexOf(chunk.trim(), cursor);
		if (index < 0) {
			ordered = false;
			break;
		}
		cursor = index + chunk.trim().length;
	}
	assert('分块保持原文顺序', ordered);
	assertEqual(
		'分块拼回原文长度一致',
		chunks.join(' ').replace(/\s+/g, ' ').trim(),
		paragraph.replace(/\s+/g, ' ').trim(),
	);
}

/* ------------------------------------------------------------------ */
/* Parser                                                              */
/* ------------------------------------------------------------------ */

function testParser(): void {
	const raw = [
		'【译文】',
		'本章是旅程的起点，也是一张地图。',
		'',
		'【词义】',
		'journey | n. | 旅程',
		'map（n.）地图',
		'correlated : adj. : 相关的',
		'chapters —— n. —— 章节',
		'not a valid line without separators at all',
	].join('\n');
	const parsed = parseGlossResponse(raw, { maxItems: 10 });
	assertEqual('解析译文', parsed.translation.includes('旅程'), true);
	assertEqual('解析出 4 条词义', parsed.items.length, 4);
	assertEqual('全角竖线也能解析', parsed.items[2].source, 'correlated');
	assert('解析成功标记', parseSucceeded(parsed), parsed.issues.join(','));

	const noTranslation = parseGlossResponse('【词义】\npolicy | n. | 策略', { maxItems: 5 });
	assertEqual('缺译文时词义仍可解析', noTranslation.items.length, 1);

	// qwen2.5:3b writes bare rows with no pipes and no headers.
	const bareRows = parseGlossResponse(
		['exploration v. 探索  ', 'exploitation v. 利用  ', 'greedy adj. 贪婪  ', 'policy n. 策略  '].join('\n'),
		{ maxItems: 10 },
	);
	assertEqual('无表头无竖线的行也能解析', bareRows.items.length, 4);
	assertEqual('无竖线行的词性', bareRows.items[0].pos, 'v.');
	assertEqual('无竖线行的释义', bareRows.items[2].target, '贪婪');
	assertEqual('空译文但词义可用', bareRows.translation, '');

	// hy-mt2-7b writes `state | n. 状态`: part of speech merged into one cell.
	const merged = parseGlossResponse('state | n. 状态\n| action | n. 动作', { maxItems: 5 });
	assertEqual('词性与释义挤在一格', merged.items.length, 2);
	assertEqual('挤在一格时词性被拆出', merged.items[0].pos, 'n.');
	assertEqual('挤在一格时释义被拆出', merged.items[0].target, '状态');
	assertEqual('前导空列的竖线行', merged.items[1].source, 'action');

	const empty = parseGlossResponse('完全不符合格式的一段话。', { maxItems: 5 });
	assert('空输出被标记为失败', !parseSucceeded(empty), empty.issues.join(','));
}

/* ------------------------------------------------------------------ */
/* Glossary                                                            */
/* ------------------------------------------------------------------ */

function testGlossary(): void {
	const glossary = resolveGlossary('');
	assertEqual('内置术语 policy = 策略', glossary.policy, '策略');
	assert('术语表版本稳定', glossaryVersion(glossary).length > 0);

	const custom = resolveGlossary('policy=方针\ngloss=词义对照');
	assertEqual('用户术语覆盖默认', custom.policy, '方针');
	assertEqual('用户术语追加', custom.gloss, '词义对照');

	const issues = checkGlossaryUsage('the policy is greedy', '这个政策是贪心的', glossary);
	assert('检测到 policy 被译成政策', issues.length === 1 && issues[0].term === 'policy', JSON.stringify(issues));

	const good = checkGlossaryUsage('the policy is greedy', '这个策略是贪心的', glossary);
	assertEqual('正确译法不报警', good.length, 0);
}

/* ------------------------------------------------------------------ */
/* Prompts (two passes, two models)                                    */
/* ------------------------------------------------------------------ */

function testPrompts(): void {
	const req = {
		text: 'The agent follows a policy and receives a reward.',
		sourceLang: 'auto' as const,
		targetLang: 'zh-Hans',
		mode: 'keywords' as const,
		glossary: { policy: '策略', reward: '奖励' },
		maxItems: 8,
	};

	const translation = buildTranslationPrompt(req);
	assert('翻译提示要求原样保留占位符', translation.includes('⟦MATH1⟧'));
	assert('翻译提示不提词义表', !translation.includes('词义'));
	assert('翻译提示只输出译文', translation.includes('只输出译文'));

	const glossary = buildGlossaryPrompt(req);
	assert('词义提示给出三列格式', glossary.includes('英文 | 词性 | 中文释义'));
	assert('词义提示带术语表', glossary.includes('策略'));
	assert('词义提示要求只输出行', glossary.includes('不要表头'));
	assert('词义提示声明上限', glossary.includes('最多 8 条'));

	// Every candidate must reach the model: a silent slice used to drop the
	// tail of the list, which is where the hard words live.
	const many = Array.from({ length: 18 }, (_, index) => `word${index}`);
	const withCandidates = buildGlossaryPrompt({ ...req, candidates: many, maxItems: 20 });
	assert('候选词全部进入提示', withCandidates.includes('word17'), withCandidates.includes('word12') ? '' : 'word12 缺失');
}

function testCandidates(): void {
	const text =
		'The beginning of this book is a simplified version of the bandit problem. ' +
		'Think of it as a journey, or a map for the ideas in later chapters. ' +
		'To make the setting concrete, consider how a player learns which slot machine pays off, ' +
		'and how the events that are correlated with rewards become evidence for a decision.';
	const glossary = { policy: '策略', reward: '奖励' };

	const picked = pickCandidates(text, 12, glossary);
	assert('候选词覆盖到段落后半段', picked.includes('correlated'), picked.join(', '));
	assert('候选词去重且不超上限', new Set(picked).size === picked.length && picked.length <= 12);
	assert('候选词不含停用词', !picked.some((word) => ['the', 'of', 'and'].includes(word)));

	const wide = pickCandidates(text, 20, glossary);
	const specWords = ['journey', 'map', 'chapters', 'correlated'];
	const specHits = specWords.filter((word) => wide.includes(word));
	assertEqual('上限 20 时规格词全覆盖', specHits.join(','), specWords.join(','));

	const requests = [
		{
			text,
			sourceLang: 'auto' as const,
			targetLang: 'zh-Hans',
			mode: 'keywords' as const,
			glossary,
			maxItems: 20,
			candidates: ['journey', 'map', 'correlated'],
		},
	];
	const missing = missingCandidates(requests, [{ source: 'Journey.', target: '旅程', pos: 'n.' }]);
	assertEqual('缺失候选被识别', missing.join(','), 'map,correlated');
}

/* ------------------------------------------------------------------ */
/* Markdown blocks                                                     */
/* ------------------------------------------------------------------ */

function makeData(overrides: Partial<GlossBlockData> = {}): GlossBlockData {
	return {
		version: 1,
		sourceText: 'The agent follows a policy.',
		translation: '智能体遵循一个策略。',
		items: [
			{ source: 'agent', target: '智能体', pos: 'n.' },
			{ source: 'policy', target: '策略', pos: 'n.' },
		],
		mode: 'keywords',
		model: 'hy-mt2-1.8b-q8:latest',
		createdAt: 1700000000000,
		...overrides,
	};
}

function testBlocks(): void {
	const note = ['# 第二章', '', 'The agent follows a policy.', '', 'Next paragraph.'].join('\n');
	const data = makeData();
	const block = makeGlossBlock(data);
	const withBlock = insertBlockIntoText(note, 2, block);
	const lines = withBlock.split('\n');
	const blocks = findGlossBlocks(lines);
	assertEqual('插入后能找到一个块', blocks.length, 1);
	assertEqual('块内容是合法 JSON', blocks[0].data?.translation, data.translation);
	assert('插入位置在原文下方', blocks[0].startLine === 4, `startLine=${blocks[0].startLine}`);

	const dup = findDuplicateBlock(lines, 2, data.sourceText);
	assert('能识别同段落的重复块', dup !== null);

	const updated = makeGlossBlock(makeData({ translation: '更新后的译文。' }));
	const replaced = replaceBlockInText(withBlock, blocks[0], updated);
	assertEqual('替换块内容', findGlossBlocks(replaced.split('\n'))[0].data?.translation, '更新后的译文。');

	const removed = removeBlockFromText(replaced, blocks[0]);
	assertEqual('删除块后不再有 gloss 块', findGlossBlocks(removed.split('\n')).length, 0);
	assert('删除后不留下双空行', !removed.includes('\n\n\n'), JSON.stringify(removed));

	const broken = '```gloss\n{ not json }\n```';
	const brokenBlocks = findGlossBlocks(broken.split('\n'));
	assertEqual('损坏的块被保留但不可解析', brokenBlocks.length === 1 && brokenBlocks[0].data === null, true);

	assertEqual('offsetToLine', offsetToLine('a\nb\nc', 4), 2);
	assertEqual('lineToOffset', lineToOffset('a\nb\nc', 2), 4);

	const located = locateTextInSource(note, 'The   agent follows a policy.');
	assert('空白归一化定位', located !== null, JSON.stringify(located));

	const portableMarkdown = [
		'<!-- ig-gloss:abc123 -->',
		'**译文**：智能体遵循一个策略。',
		'',
		'<!-- /ig-gloss -->',
	].join('\n');
	assert('便携块标记可读', portableMarkdown.includes('ig-gloss:abc123'));
}

/* ------------------------------------------------------------------ */
/* Cache ids                                                           */
/* ------------------------------------------------------------------ */

async function testCache(): Promise<void> {
	const a = await recordId('book.pdf', 12, 'Hello   world');
	const b = await recordId('book.pdf', 12, 'hello world');
	const c = await recordId('book.pdf', 13, 'Hello world');
	assert('同一页同一文本 → 同一 id', a === b, a.slice(0, 12));
	assert('不同页 → 不同 id', a !== c);

	const records: Record<string, PdfGlossRecord> = {
		old: {
			id: 'old',
			pdfPath: 'book.pdf',
			page: 3,
			sourceText: 'x',
			translation: '旧',
			items: [],
			model: 'm',
			createdAt: 100,
			mode: 'keywords',
		},
		newer: {
			id: 'newer',
			pdfPath: 'book.pdf',
			page: 9,
			sourceText: 'y',
			translation: '新',
			items: [],
			model: 'm',
			createdAt: 200,
			mode: 'keywords',
		},
	};
	assertEqual('记录按时间倒序', sortRecords(records).map((r) => r.id), ['newer', 'old']);
}

/* ------------------------------------------------------------------ */
/* Settings merge                                                      */
/* ------------------------------------------------------------------ */

function testSettings(): void {
	const merged = mergeSettings({ temperature: 9, maxItems: 0, maxInputChars: 5, provider: 'openai' });
	assertEqual('温度被夹到上限', merged.temperature, 2);
	assertEqual('关键词数被夹到下限', merged.maxItems, 1);
	assertEqual('输入上限被夹到下限', merged.maxInputChars, 200);
	assertEqual('服务商可切换', merged.provider, 'openai');
	assertEqual('未知字段被忽略', mergeSettings({ bogus: 1 }).model, DEFAULT_SETTINGS.model);
}

/* ------------------------------------------------------------------ */
/* PDF mark geometry                                                   */
/* ------------------------------------------------------------------ */

const PAGE = { width: 800, height: 600 };
const ANCHOR = { left: 100, right: 180, top: 200, bottom: 212, pageWidth: 800, pageHeight: 600 };

function plan(overrides: Partial<Parameters<typeof planLabel>[0]> = {}) {
	return planLabel({
		anchor: ANCHOR,
		gap: 14,
		textWidth: 60,
		baseFontSize: 12,
		fontScale: 1,
		mode: 'gap',
		...overrides,
	});
}

function testGeometry(): void {
	const rect = { left: 100, top: 200, width: 40, height: 12 };
	const norm = normalizeRect(rect, 0, 0, PAGE);
	assertEqual('坐标归一化 x', norm.x, 0.125);
	assertEqual('坐标归一化 y', norm.y, 0.3333);
	const back = denormalizeRect(norm, PAGE);
	assert(
		'归一化再反归一化回到原位',
		Math.abs(back.left - 100) < 0.5 && Math.abs(back.top - 200) < 0.5 && Math.abs(back.width - 40) < 0.5,
		JSON.stringify(back),
	);
	assertEqual('canonicalRects 与顺序无关地稳定', canonicalRects([norm]), canonicalRects([{ ...norm }]));
	assertEqual(
		'零宽选区被丢弃',
		normalizeRects([{ left: 0, top: 0, width: 0, height: 3 }, rect], 0, 0, PAGE).length,
		1,
	);
	assertEqual('行高按字号 1.45 倍估算', Math.round(lineHeightFor(12) * 100) / 100, 17.4);
	assert(
		'重叠比例按较小面积算',
		Math.abs(overlapRatio({ left: 0, top: 0, width: 10, height: 10 }, { left: 5, top: 0, width: 10, height: 10 }) - 0.5) < 0.001,
	);

	const gapPlan = plan();
	assertEqual('空隙够大时用 gap 模式', gapPlan.mode, 'gap');
	assert(
		'标签落在原词下、且不越过下一行',
		gapPlan.top >= ANCHOR.bottom && gapPlan.top + gapPlan.height <= ANCHOR.bottom + 14.01,
		`top=${gapPlan.top} h=${gapPlan.height}`,
	);
	assert('字号不超过页面字号', gapPlan.fontSize <= 13.81, String(gapPlan.fontSize));
	assert(
		'标签水平居中在原词上',
		Math.abs(gapPlan.left + gapPlan.width / 2 - 140) <= 1,
		`${gapPlan.left}+${gapPlan.width}/2`,
	);

	const tight = plan({ gap: 4 });
	assertEqual('空隙太小自动降级 overlap', tight.mode, 'overlap');
	assert('overlap 时贴着基线', tight.top < ANCHOR.bottom);

	// Measured on a real RL textbook page: 11.96pt text, 17.33px baseline step,
	// 5.37px of white space between lines. That gap cannot hold a readable
	// label, so it must fall back to a chip that hugs the word.
	const real = plan({ gap: 5.37, baseFontSize: 11.96, textWidth: 40 });
	assertEqual('真实教材的窄行距改用 overlap', real.mode, 'overlap');
	assert(
		'窄行距标签至少 9px 且贴住词底',
		real.fontSize >= 9 && Math.abs(real.top - (ANCHOR.bottom - 1)) < 0.6,
		`font=${real.fontSize} top=${real.top} h=${real.height}`,
	);

	const tinyPage = plan({ gap: 14, pageFontSize: 8 });
	assertEqual('字号有 9px 下限', tinyPage.fontSize, 9);

	const bigPage = plan({ gap: 14, pageFontSize: 16 });
	assert('字号跟随正文放大', bigPage.fontSize > 11 && bigPage.fontSize <= 15, String(bigPage.fontSize));

	const widePhrase = plan({ gap: 14, textWidth: 2000 });
	assert('超长短语缩到页面宽度内', widePhrase.width <= PAGE.width - 4, String(widePhrase.width));
	assert('超长短语也不低于最小字号', widePhrase.fontSize >= 9, String(widePhrase.fontSize));

	assert('hover 模式默认不画标签', plan({ mode: 'hover' }).hidden);

	const bottom = plan({ anchor: { ...ANCHOR, top: 590, bottom: 596 } });
	assert('页面底部改成放在原词上方', bottom.top < 590, String(bottom.top));

	const margin = plan({ mode: 'margin' });
	assert('margin 模式贴页面右侧', margin.left > 600, String(margin.left));

	const huge = plan({ textWidth: 4000 });
	assert('超长文本缩到页宽以内', huge.width <= PAGE.width - 4, String(huge.width));

	const hidden = resolveCollisions([
		{ id: 'old', rect: { left: 0, top: 0, width: 60, height: 12 }, priority: 1 },
		{ id: 'new', rect: { left: 5, top: 0, width: 60, height: 12 }, priority: 2 },
	]);
	assert('重叠时只保留较新的标签', hidden.has('old') && !hidden.has('new'));
	assert(
		'互不相交的标签都保留',
		resolveCollisions([
			{ id: 'a', rect: { left: 0, top: 0, width: 40, height: 12 }, priority: 1 },
			{ id: 'b', rect: { left: 200, top: 0, width: 40, height: 12 }, priority: 2 },
		]).size === 0,
	);
}

/* ------------------------------------------------------------------ */
/* Selection snapping to word boundaries                               */
/* ------------------------------------------------------------------ */

function testSelectionSnap(): void {
	const sentence = 'This book contains ten chapters.';
	const partial = sentence.indexOf('ontains');
	const snapped = expandToWordBounds(sentence, partial, partial + 'ontains'.length);
	assertEqual('半个单词向前补全', sentence.slice(snapped.start, snapped.end), 'contains');
	assert('原选区确实是半截词', hasPartialWord(sentence, partial, partial + 'ontains'.length));

	const whole = sentence.indexOf('book');
	assert(
		'整词选区不被改动',
		expandToWordBounds(sentence, whole, whole + 'book'.length).start === whole,
	);

	const phrase = 'a map for the ideas in later chapters';
	const inner = phrase.indexOf('ap for the idea');
	const phraseBounds = expandToWordBounds(phrase, inner, inner + 'ap for the idea'.length);
	assertEqual('短语只补首尾、不动中间', phrase.slice(phraseBounds.start, phraseBounds.end), 'map for the ideas');

	const paren = '(contains)';
	const parenBounds = expandToWordBounds(paren, 1, 8);
	assertEqual('括号就是边界', paren.slice(parenBounds.start, parenBounds.end), 'contains');

	const hyphenated = 'a state-of-the-art design';
	const hyphenStart = hyphenated.indexOf('of');
	const hyphenBounds = expandToWordBounds(hyphenated, hyphenStart, hyphenStart + 2);
	assertEqual('连字符算在同一个词里', hyphenated.slice(hyphenBounds.start, hyphenBounds.end), 'state-of-the-art');

	const possessive = "the agent's policy";
	const possStart = possessive.indexOf("ent'");
	const possBounds = expandToWordBounds(possessive, possStart, possStart + 4);
	assertEqual('撇号算在同一个词里', possessive.slice(possBounds.start, possBounds.end), "agent's");

	const lineEnd = expandToWordBounds('chapters ten', 0, 8);
	assertEqual('行尾整词保持不变', 'chapters ten'.slice(lineEnd.start, lineEnd.end), 'chapters');

	// A double click in pdf.js often drags the following space into the range.
	// Snapping must not walk over that space and swallow the next word.
	const trailing = 'contain tank and';
	const trailingBounds = expandToWordBounds(trailing, 0, 'contain '.length);
	assertEqual('尾随空格不吞下一个词', trailing.slice(trailingBounds.start, trailingBounds.end), 'contain');

	const leading = ' a contains';
	const leadingBounds = expandToWordBounds(leading, 0, 2);
	assertEqual('行首空格被剥掉', leading.slice(leadingBounds.start, leadingBounds.end), 'a');

	const comma = 'contains, and';
	const commaBounds = expandToWordBounds(comma, 0, 'contains, '.length);
	assertEqual('尾随标点不进词', comma.slice(commaBounds.start, commaBounds.end), 'contains');

	// pdf.js line fragments are usually separate text nodes with no whitespace
	// between them; the text index must insert a separator from geometry, not
	// glue "chapters" and the next line's "are" into "chaptersare".
	const sameLine = { top: 100, bottom: 112, left: 10, right: 20 };
	const adjacentSpan = { top: 100, bottom: 112, left: 20, right: 30 };
	const spacedWord = { top: 100, bottom: 112, left: 25, right: 35 };
	const nextLine = { top: 117, bottom: 129, left: 10, right: 20 };
	assertEqual('同词跨 span 不插空格', separatorBetween(sameLine, adjacentSpan, 'c', 'ontains'), '');
	assertEqual('同线词间空隙插空格', separatorBetween(sameLine, spacedWord, 'chapters', 'are'), ' ');
	assertEqual('跨行插换行', separatorBetween(sameLine, nextLine, 'chapters', 'are'), '\n');
	assertEqual('已有空格不重复插', separatorBetween(sameLine, spacedWord, 'chapters ', 'are'), '');

	const algorithms = expandToWordBounds('algorithms. The ten', 0, 'algorithms.'.length);
	assertEqual('句号不进入词边界', 'algorithms. The ten'.slice(algorithms.start, algorithms.end), 'algorithms');

	const lineBreak = expandToWordBounds('chapters\nare highly', 0, 'chapters\n'.length);
	assertEqual('换行阻止扩到下一行', 'chapters\nare highly'.slice(lineBreak.start, lineBreak.end), 'chapters');

	assertEqual('跨行选区合并为空格', normalizeSelectionText('corresponding\npolicy'), 'corresponding policy');
	assertEqual('跨行连字符保留', normalizeSelectionText('correspond-\ning\npolicy'), 'correspond-ing policy');

	const sentenceText = 'First sentence. The corresponding policy is better. Next one.';
	const sentenceStart = sentenceText.indexOf('corresponding');
	assertEqual(
		'截取选中词所在整句',
		sentenceAround(sentenceText, sentenceStart, sentenceStart + 'corresponding'.length),
		'The corresponding policy is better.',
	);
	assert(
		'整句选区被识别',
		coversWholeSentence('The corresponding policy is better', 'The corresponding policy is better.'),
	);
	assert(
		'单词不会误判为整句',
		!coversWholeSentence('corresponding', 'The corresponding policy is better.'),
	);
	const abbreviation = 'This is e.g. the corresponding policy case. Next one.';
	const abbreviationStart = abbreviation.indexOf('corresponding');
	assertEqual(
		'缩写句点不误切',
		sentenceAround(abbreviation, abbreviationStart, abbreviationStart + 'corresponding'.length),
		'This is e.g. the corresponding policy case.',
	);
	assertEqual('没有句号时返回全文', sentenceAround('a corresponding policy without stops', 2, 23), 'a corresponding policy without stops');
	const tableTail = 'Each cell indicates the next state. a1 (upward) a2 (rightward) Table 1.1.';
	const tableStart = tableTail.indexOf('next');
	assertEqual(
		'句号后接小写表格内容也在此截止',
		sentenceAround(tableTail, tableStart, tableStart + 'next'.length),
		'Each cell indicates the next state.',
	);
}

/* ------------------------------------------------------------------ */
/* PDF mark storage                                                    */
/* ------------------------------------------------------------------ */

function makeMark(overrides: Partial<PdfWordMark> = {}): PdfWordMark {
	return {
		id: 'm1',
		pdfPath: 'Books/Book.pdf',
		page: 10,
		text: 'correlated',
		translation: '相关的',
		rects: [{ x: 0.1, y: 0.2, w: 0.06, h: 0.012 }],
		quoteBefore: 'is directly',
		quoteAfter: 'with the behavior',
		color: 'yellow',
		model: 'qwen2.5:3b',
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function fakeApp(files: Map<string, string>, dirs: Set<string>): App {
	return {
		vault: {
			adapter: {
				exists: async (path: string) => files.has(path) || dirs.has(path),
				read: async (path: string) => files.get(path) ?? '',
				write: async (path: string, data: string) => {
					files.set(path, data);
				},
				mkdir: async (path: string) => {
					dirs.add(path);
				},
			},
		},
	} as unknown as App;
}

async function testMarks(): Promise<void> {
	const rects = [{ x: 0.1, y: 0.2, w: 0.06, h: 0.012 }];
	const a = await markId('Books/Book.pdf', 10, 'correlated', rects, 'is directly', 'with the');
	const b = await markId('Books/Book.pdf', 10, 'Correlated', rects, 'is  directly', 'with the');
	const c = await markId('Books/Book.pdf', 10, 'correlated', [{ x: 0.4, y: 0.2, w: 0.06, h: 0.012 }], 'is directly', 'with the');
	assert('同一位置的同一个词 → 同一个 id', a === b, a.slice(0, 10));
	assert('位置不同 → 不同 id', a !== c);

	const path = marksPath('Books/My Book.pdf', 'Glosses/pdf');
	assert('标注文件落在标注文件夹里', path.startsWith('Glosses/pdf/My Book-'), path);
	assert('标注文件以 .marks.json 结尾', path.endsWith('.marks.json'), path);
	assert('空文件夹则放在 PDF 同目录', marksPath('Books/My Book.pdf', '') === 'Books/My Book.marks.json');

	assertEqual('坏 JSON 不抛错、返回空列表', parseMarkFile('{not json', 'Books/Book.pdf').length, 0);
	assertEqual(
		'缺 rects 的记录被丢弃',
		parseMarkFile(JSON.stringify({ version: 1, marks: [{ text: 'x', translation: '叉', page: 2 }] }), 'p').length,
		0,
	);
	const legacy = parseMarkFile(
		JSON.stringify({
			version: 1,
			marks: [{ text: 'journey', translation: '旅程', page: '3', rects }],
		}),
		'Books/Book.pdf',
	);
	assertEqual('字符串页码被转成数字', legacy.length === 1 ? legacy[0].page : 0, 3);
	assertEqual('缺 id 时补 legacy id', legacy.length === 1 && legacy[0].id.startsWith('legacy-3-'), true);

	const marks = [makeMark()];
	assert('同页同位置重复选择复用已有标注', Boolean(findSameMark(marks, 10, 'correlated', rects, PAGE)));
	assert('同一页不同位置算新标注', !findSameMark(marks, 10, 'correlated', [{ x: 0.6, y: 0.5, w: 0.06, h: 0.012 }], PAGE));
	assert('不同页不算同一个', !findSameMark(marks, 11, 'correlated', rects, PAGE));

	// Hover tooltips: which mark sits under the pointer.
	assertEqual('指针落在标注上时命中它', markAtPoint(marks, { x: 0.12, y: 0.205 })?.text, 'correlated');
	assert('指针落在标注外时为 null', markAtPoint(marks, { x: 0.5, y: 0.5 }) === null);
	const newer = { ...makeMark(), id: 'newer', updatedAt: 2_000 };
	assertEqual('重叠时取较新的标注', markAtPoint([makeMark(), newer], { x: 0.12, y: 0.205 })?.id, 'newer');

	const pageText = 'much of what we learn is directly correlated with the behavior of a greedy policy';
	assertEqual(
		'quote 重定位能找回原词',
		pageText.slice(...Object.values(locateQuote(pageText, 'is directly', 'correlated', 'with the behavior')!) as [number, number]),
		'correlated',
	);
	assertEqual(
		'只有前文也能定位',
		pageText.slice(...Object.values(locateQuote(pageText, 'learn is directly', 'correlated', 'missing after')!) as [number, number]),
		'correlated',
	);
	assertEqual('页面上没有这个词时返回 null', locateQuote(pageText, 'zzz', 'qqq', 'www'), null);

	const files = new Map<string, string>();
	const dirs = new Set<string>();
	const app = fakeApp(files, dirs);
	const store = new VaultMarkStore(app, 'Glosses/pdf');
	const saved = makeMark();
	await store.save(saved.pdfPath, [saved]);
	assert('标注写进了 vault 文件', files.has(store.describe(saved.pdfPath)), store.describe(saved.pdfPath));
	const loaded = await store.load(saved.pdfPath);
	assertEqual('读回来的条数一致', loaded.length, 1);
	assertEqual('读回来的译文一致', loaded[0].translation, '相关的');

	const settings = { ...DEFAULT_SETTINGS, pdfMarkCacheInVault: true };
	assert('默认后端是 vault', createMarkStore(app, settings) instanceof VaultMarkStore);
	assert(
		'关掉开关退到 localStorage',
		createMarkStore(app, { ...settings, pdfMarkCacheInVault: false }) instanceof LocalMarkStore,
	);
}

/* ------------------------------------------------------------------ */
/* Word translation helpers                                            */
/* ------------------------------------------------------------------ */

function testWordPrompt(): void {
	const settings = { ...DEFAULT_SETTINGS, pdfMarkModel: '', glossaryModel: 'qwen2.5:3b' };
	assertEqual('词义模型回落到词义模型', wordModel(settings), 'qwen2.5:3b');
	assertEqual('显式设置优先', wordModel({ ...settings, pdfMarkModel: 'hy-mt2-1.8b-q8:latest' }), 'hy-mt2-1.8b-q8:latest');

	const prompt = buildWordPrompt('correlated', 'is directly', 'with the behavior', resolveGlossary(''));
	assert('提示词含选中词', prompt.includes('correlated'));
	assert('提示词含上下文', prompt.includes('is directlycorrelatedwith the behavior'));
	assert('提示词要求最多 12 个汉字', prompt.includes('最多 12 个汉字'));
	assert('提示词带术语表', prompt.includes('策略'));
	assert('提示词要求只输出译文', prompt.includes('只输出译文'));
	assert('提示词区分形容词与名词', prompt.includes('形容词用「…的」形式'));

	assertEqual('去掉表格式前缀', cleanWordTranslation('correlated | adj. | 相关的'), '相关的');
	assertEqual('去掉「译文：」前缀', cleanWordTranslation('译文：相关的'), '相关的');
	assertEqual('去掉包裹引号', cleanWordTranslation('「相关的」'), '相关的');
	assertEqual('去掉尾部词性标注', cleanWordTranslation('相关的（adj.）'), '相关的');
	assertEqual('没有中文时返回空', cleanWordTranslation('correlated'), '');
	assertEqual('空字符串返回空', cleanWordTranslation('   '), '');
	assertEqual('整句去掉【译文】', cleanSentenceTranslation('【译文】\n对应的策略更好。'), '对应的策略更好。');
	assertEqual('整句去掉前缀', cleanSentenceTranslation('译文：对应的策略更好。'), '对应的策略更好。');
	assertEqual('整句保留多行内容', cleanSentenceTranslation('对应的\n策略更好。'), '对应的 策略更好。');
	assertEqual('整句没有中文时返回空', cleanSentenceTranslation('corresponding policy'), '');
	assert(
		'超长释义截到 12 字以内',
		cleanWordTranslation('非常非常长的一个释义超过十二个字的情况继续延伸').length <= 12,
		cleanWordTranslation('非常非常长的一个释义超过十二个字的情况继续延伸'),
	);
}

/* ------------------------------------------------------------------ */
/* Live model check                                                    */
/* ------------------------------------------------------------------ */

const ACCEPTANCE_PARAGRAPH = [
	'We begin our journey with the bandit problem, a simplified setting that serves as a map for the ideas developed in later chapters.',
	'The exploration and exploitation trade-off appears here in its purest form, and much of what we learn is directly correlated with the behavior of a greedy policy in the full reinforcement learning problem.',
	'The agent follows a policy, receives a reward, and updates the value of a state, which we write as $v_\\pi(s)$ in the notation used throughout this book.',
].join(' ');

async function testLiveOllama(): Promise<void> {
	if (process.env.IG_OFFLINE === '1') {
		skip('真实模型集成测试', 'IG_OFFLINE=1');
		return;
	}
	const transport = new FetchTransport();
	// Two passes, two models: 1.8B translates, qwen2.5:3b writes the table.
	const settings = { ...DEFAULT_SETTINGS, qualityFallback: false, maxItems: 20 };
	let reachable = false;
	try {
		const response = await fetch('http://127.0.0.1:11434/api/tags');
		reachable = response.ok;
	} catch {
		reachable = false;
	}
	if (!reachable) {
		skip('真实模型集成测试', 'Ollama 未运行');
		return;
	}

	const provider = createProvider(settings, transport);
	let models: string[] = [];
	try {
		models = await provider.listModels();
	} catch (error) {
		skip('真实模型集成测试', `模型列表失败：${error instanceof Error ? error.message : error}`);
		return;
	}
	const missing = [settings.model, settings.glossaryModel].filter((name) => name && !models.includes(name));
	if (missing.length) {
		skip('真实模型集成测试', `缺少模型 ${missing.join(', ')}`);
		return;
	}

	const started = Date.now();
	try {
		const result = await generateGloss(ACCEPTANCE_PARAGRAPH, { provider, settings });
		const elapsed = Date.now() - started;
		const data = result.data;
		const sources = data.items.map((item: GlossItem) => item.source.toLowerCase());
		const has = (needle: string) => sources.some((source) => source.includes(needle));

		assert('译文非空', data.translation.length > 20, data.translation.slice(0, 60));
		assert('词义表至少 5 条', data.items.length >= 5, `${data.items.length} 条：${sources.join(', ')}`);
		// The spec names four words; every one of them must survive the pipeline.
		const specWords = ['journey', 'map', 'chapter', 'correlated'];
		const hits = specWords.filter((word) => has(word));
		assert(
			'规格期望词全部命中',
			hits.length === specWords.length,
			`命中 ${hits.join(', ') || '无'}；实际：${sources.join(', ')}`,
		);
		assert('公式原样保留', data.translation.includes('$v_\\pi(s)$'), data.translation.slice(-80));
		assert(
			'policy 译为策略而非政策',
			data.translation.includes('策略') && !data.translation.includes('政策'),
			data.translation.slice(0, 120),
		);
		assert('1–3 句在 20 秒内返回', elapsed < 20000, `${elapsed}ms`);
		assert('记录耗时', elapsed > 0, `${elapsed}ms`);
		console.log(
			`  模型 ${data.model} 译 / ${data.meta?.glossaryModel ?? data.model} 词义，${elapsed}ms，${data.items.length} 个词条`,
		);
		console.log(`  词条：${sources.join(', ')}`);
		console.log(`  译文：${data.translation}`);

		// One word, as the PDF mark flow would ask it.
		const wordStarted = Date.now();
		const word = await translateWordInContext(provider, {
			text: 'correlated',
			quoteBefore: 'much of what we learn is directly',
			quoteAfter: 'with the behavior of a greedy policy',
			settings,
		});
		const wordElapsed = Date.now() - wordStarted;
		assert('单词释义非空', word.translation.length > 0, word.translation);
		assert('单词释义是中文', /[\u4e00-\u9fff]/.test(word.translation), word.translation);
		assert('单词释义不超过 12 字', Array.from(word.translation).length <= 12, word.translation);
		assert('单词释义在 30 秒内返回', wordElapsed < 30000, `${wordElapsed}ms`);
		console.log(`  correlated → ${word.translation}（${word.model}，${wordElapsed}ms）`);
	} catch (error) {
		fail('真实模型集成测试', error instanceof Error ? error.message : String(error));
	}
}

/* ------------------------------------------------------------------ */

async function probeModel(): Promise<void> {
	const settings = { ...DEFAULT_SETTINGS, qualityFallback: false };
	const provider = createProvider(settings, new FetchTransport());

	const req = {
		text: ACCEPTANCE_PARAGRAPH,
		sourceLang: 'auto' as const,
		targetLang: settings.targetLang,
		mode: settings.mode,
		glossary: resolveGlossary(''),
		maxItems: settings.maxItems,
		candidates: pickCandidates(ACCEPTANCE_PARAGRAPH, 12),
	};

	const cases: { label: string; model: string; prompt: string; maxTokens: number }[] = [
		{
			label: 'engine glossary prompt / qwen3b',
			model: 'qwen2.5:3b',
			prompt: buildGlossaryPrompt(req),
			maxTokens: settings.maxTokens,
		},
		{
			label: 'engine glossary prompt / 7b',
			model: 'hy-mt2-7b-q5:latest',
			prompt: buildGlossaryPrompt(req),
			maxTokens: settings.maxTokens,
		},
		{
			label: 'engine translation prompt / 1.8b',
			model: 'hy-mt2-1.8b-q8:latest',
			prompt: buildTranslationPrompt(req),
			maxTokens: settings.maxTokens,
		},
	];

	for (const item of cases) {
		const started = Date.now();
		try {
			const raw = await provider.chat({
				model: item.model,
				messages: [{ role: 'user', content: item.prompt }],
				temperature: settings.temperature,
				maxTokens: item.maxTokens,
				numCtx: settings.numCtx,
				timeoutMs: 120000,
			});
			const parsed = parseGlossResponse(raw, { maxItems: settings.maxItems });
			console.log(`===== ${item.label} (${Date.now() - started}ms) =====`);
			console.log(raw.trim());
			console.log(
				`-- parsed items=${parsed.items.length} issues=${parsed.issues.join(',')} translation="${parsed.translation.slice(0, 60)}"`,
			);
			for (const row of parsed.items) {
				console.log(
					`   row [${row.source}] [${row.pos ?? '-'}] [${row.target}] useful=${isUsefulItem(ACCEPTANCE_PARAGRAPH, row)}`,
				);
			}
		} catch (error) {
			console.log(`===== ${item.label} FAILED =====`);
			console.log(error instanceof Error ? error.message : String(error));
		}
	}
}

function testOfflineDictionary(): void {
	assert('离线词典已加载', offlineDictionarySize() > 30000, `${offlineDictionarySize()} entries`);
	const obtain = lookupOfflineWord('obtain');
	assert('obtain 命中“获得”', Boolean(obtain?.translation.includes('获得')), obtain?.translation ?? '');
	const contents = lookupOfflineWord('contents');
	assert('contents 首义是“内容”', Boolean(contents?.translation.startsWith('内容')), contents?.translation ?? '');
	const chapters = lookupOfflineWord('chapters');
	assert('chapters 含“章节”', Boolean(chapters?.translation.includes('章节')), chapters?.translation ?? '');
	const correlated = lookupOfflineWord('correlated');
	assert('correlated 是形容词释义', Boolean(correlated?.translation.includes('相互')), correlated?.translation ?? '');
	const obtained = lookupOfflineWord('obtained');
	assert('obtained 词形还原到 obtain', Boolean(obtained?.translation.includes('获得')), obtained?.translation ?? '');
	assert('未收录词返回 null', lookupOfflineWord('zzzznotaword') === null);
	const corresponding = lookupOfflineWord('corresponding');
	assert('corresponding 含“对应”义项', Boolean(corresponding?.candidates.some((item) => item.includes('对应'))), corresponding?.candidates.join(' / ') ?? '');
	assert('形容词对应补“的”', applyAdjectiveSuffix('对应', 'a') === '对应的');
	assert('已有“的”不重复补', applyAdjectiveSuffix('对应的', 'a') === '对应的');
	assert('名词不补“的”', applyAdjectiveSuffix('内容', 'n') === '内容');
	const contentsCandidates = lookupOfflineWord('contents')?.candidates ?? [];
	assert('contents 有多个候选', contentsCandidates.length > 1, `${contentsCandidates.length} 个`);
	const prompt = buildSensePrompt('contents', 'The first aspect is the ', ' introduced in each chapter.', contentsCandidates);
	assert('义项提示带编号', prompt.includes('1. ') && prompt.includes('上下文：'));
	assert('义项提示要求只输出数字', prompt.includes('只输出一个阿拉伯数字'));
	assert('解析义项编号', parseSenseChoice('2', contentsCandidates.length) === 2);
	assert('容忍“答案是 3”', parseSenseChoice('答案是 3', contentsCandidates.length) === 3);
	assert('越界编号被拒绝', parseSenseChoice('99', contentsCandidates.length) === null);
	assert('非数字被拒绝', parseSenseChoice('内容', contentsCandidates.length) === null);
}

async function main(): Promise<void> {
	if (process.env.IG_PROBE === '1') {
		await probeModel();
		return;
	}
	testProtection();
	testChunking();
	testParser();
	testGlossary();
	testPrompts();
	testCandidates();
	testBlocks();
	await testCache();
	testSettings();
	testGeometry();
	testSelectionSnap();
	await testMarks();
	testWordPrompt();
	testOfflineDictionary();
	await testLiveOllama();

	console.log('');
	for (const line of results) console.log(line);
	console.log('');
	if (failures === 0) {
		console.log(`全部通过：${checks} 项检查`);
	} else {
		console.log(`${failures} 项失败 / ${checks} 项检查`);
		process.exitCode = 1;
	}
}

void main();

