import { fnv1a } from '../cache/hash';

/**
 * Reinforcement-learning glossary. The point is not completeness but
 * consistency: "policy" must never become "政策".
 */
export const DEFAULT_GLOSSARY: Record<string, string> = {
	policy: '策略',
	'state value': '状态值',
	'action value': '动作值',
	reward: '奖励',
	return: '回报',
	obtain: '获得',
	episode: '回合',
	trajectory: '轨迹',
	'Bellman equation': '贝尔曼方程',
	'Bellman optimality equation': '贝尔曼最优方程',
	'contraction mapping': '压缩映射',
	greedy: '贪婪',
	'temporal difference': '时序差分',
	'stochastic approximation': '随机逼近',
	'Monte Carlo': '蒙特卡洛',
	'value iteration': '值迭代',
	'policy iteration': '策略迭代',
	'actor-critic': '演员-评论家',
	'experience sample': '经验样本',
	state: '状态',
	action: '动作',
	agent: '智能体',
	environment: '环境',
	optimal: '最优',
	'value function': '价值函数',
	exploration: '探索',
	exploitation: '利用',
	'on-policy': '同策略',
	'off-policy': '异策略',
	baseline: '基线',
	advantage: '优势',
	convergence: '收敛',
	discount: '折扣',
	'discount rate': '折扣率',
	'Markov decision process': '马尔可夫决策过程',
};

export function defaultGlossaryText(): string {
	return Object.entries(DEFAULT_GLOSSARY)
		.map(([term, target]) => `${term} = ${target}`)
		.join('\n');
}

/**
 * Parse a user glossary. Accepts `term = 译名`, `term: 译名`, `term|译名`,
 * ignores `#` comments and blank lines.
 */
export function parseGlossaryText(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const rawLine of (text ?? '').split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#') || line.startsWith('//')) continue;
		const match = line.match(/^(.+?)\s*(?:=|:|\||→|——)\s*(.+)$/);
		if (!match) continue;
		const term = match[1].trim();
		const target = match[2].trim();
		if (!term || !target) continue;
		out[term] = target;
	}
	return out;
}

/** Defaults overlaid with the user's entries (user wins). */
export function resolveGlossary(customText: string): Record<string, string> {
	return { ...DEFAULT_GLOSSARY, ...parseGlossaryText(customText) };
}

export function glossaryVersion(glossary: Record<string, string>): string {
	const entries = Object.entries(glossary)
		.map(([term, target]) => `${term.toLowerCase()}=${target}`)
		.sort();
	return `${entries.length}-${fnv1a(entries.join('\n'))}`;
}

export function glossaryPromptLines(glossary: Record<string, string>, limit = 60): string {
	const entries = Object.entries(glossary).slice(0, limit);
	return entries.map(([term, target]) => `- ${term} = ${target}`).join('\n');
}

export interface GlossaryIssue {
	term: string;
	expected: string;
	found: string;
}

/**
 * Very small sanity check: for every glossary term that appears in the source
 * and is a "hard" term (one with a distinctive translation), warn when the
 * translation contains an obvious wrong alternative instead.
 */
const WRONG_VARIANTS: Record<string, string[]> = {
	policy: ['政策', '方针'],
	reward: ['奖赏'],
	episode: ['情节', '插曲'],
};

export function checkGlossaryUsage(
	sourceText: string,
	translation: string,
	glossary: Record<string, string>,
): GlossaryIssue[] {
	const issues: GlossaryIssue[] = [];
	const lowerSource = sourceText.toLowerCase();
	for (const [term, expected] of Object.entries(glossary)) {
		const wrong = WRONG_VARIANTS[term.toLowerCase()];
		if (!wrong) continue;
		if (!lowerSource.includes(term.toLowerCase())) continue;
		for (const variant of wrong) {
			if (translation.includes(variant) && !translation.includes(expected)) {
				issues.push({ term, expected, found: variant });
				break;
			}
		}
	}
	return issues;
}
