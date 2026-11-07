/**
 * Formula / code / URL protection.
 *
 * Text is rewritten so the model never sees LaTeX, code spans or URLs: those
 * spans become single tokens like `⟦MATH1⟧`, which models tend to keep intact.
 * After the round-trip we restore the originals verbatim.
 */

export type ProtectedKind = 'code' | 'math' | 'url' | 'ref';

export interface ProtectedToken {
	key: string;
	placeholder: string;
	original: string;
	kind: ProtectedKind;
}

export interface ProtectedText {
	text: string;
	tokens: ProtectedToken[];
}

interface Rule {
	kind: ProtectedKind;
	label: string;
	re: RegExp;
}

/**
 * Order matters: fenced code first (it may contain `$`), then display math,
 * then inline code, then inline math, then URLs and wiki links.
 */
const RULES: Rule[] = [
	{ kind: 'code', label: 'CODE', re: /```[\s\S]*?```/g },
	{ kind: 'code', label: 'CODE', re: /~~~[\s\S]*?~~~/g },
	{ kind: 'math', label: 'MATH', re: /\$\$[\s\S]*?\$\$/g },
	{ kind: 'math', label: 'MATH', re: /\\\[[\s\S]*?\\\]/g },
	{ kind: 'code', label: 'CODE', re: /`[^`\n]+`/g },
	{ kind: 'math', label: 'MATH', re: /\\\([\s\S]*?\\\)/g },
	// Inline math: no whitespace just inside the dollars, no newline, not a price.
	{ kind: 'math', label: 'MATH', re: /\$(?![\s$])(?:[^$\n]|\\\$){1,200}?(?<![\s\\])\$(?!\d)/g },
	{ kind: 'url', label: 'URL', re: /https?:\/\/[^\s<>()[\]{}"'`]+/g },
	{ kind: 'ref', label: 'REF', re: /!?\[\[[^\]\n]+\]\]/g },
	{ kind: 'ref', label: 'CITE', re: /\[@[A-Za-z0-9_:.#$%&+?<>~/=-]+\]/g },
];

export function protectText(input: string): ProtectedText {
	let text = input;
	const tokens: ProtectedToken[] = [];
	let counter = 0;

	for (const rule of RULES) {
		text = text.replace(rule.re, (match) => {
			// Skip markup-only matches such as a bare `[[` fragment.
			if (!match.trim()) return match;
			counter += 1;
			const key = `${rule.label}${counter}`;
			const placeholder = `⟦${key}⟧`;
			tokens.push({ key, placeholder, original: match, kind: rule.kind });
			return placeholder;
		});
	}

	return { text, tokens };
}

const BRACKETS: [string, string][] = [
	['⟦', '⟧'],
	['【', '】'],
	['[', ']'],
	['［', '］'],
	['{', '}'],
];

function variantsFor(token: ProtectedToken): string[] {
	const out: string[] = [token.placeholder];
	for (const [open, close] of BRACKETS) {
		out.push(`${open}${token.key}${close}`);
		out.push(`${open} ${token.key} ${close}`);
		out.push(`${open}${token.key} ${close}`);
		out.push(`${open} ${token.key}${close}`);
	}
	return out;
}

export interface RestoreResult {
	text: string;
	missing: ProtectedToken[];
}

/**
 * Put the originals back. Tolerates the small formatting variations models
 * introduce (added spaces, swapped bracket style).
 */
export function restoreText(text: string, protectedText: ProtectedText): RestoreResult {
	let out = text;
	const missing: ProtectedToken[] = [];

	for (const token of protectedText.tokens) {
		let replaced = false;
		for (const variant of variantsFor(token)) {
			if (!variant) continue;
			if (out.includes(variant)) {
				out = out.split(variant).join(token.original);
				replaced = true;
				break;
			}
		}
		if (!replaced) missing.push(token);
	}

	return { text: out, missing };
}

/** True when the text still contains any protection token. */
export function hasPlaceholder(text: string): boolean {
	return /⟦\s*[A-Z]+\d+\s*⟧/.test(text);
}
