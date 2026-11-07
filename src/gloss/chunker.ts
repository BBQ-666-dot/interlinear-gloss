/**
 * Sentence-aware chunking. Long paragraphs are split on sentence boundaries
 * first so the model never sees a truncated thought, and only oversized single
 * sentences fall back to clause / hard cuts.
 */

const SENTENCE_CLOSERS = '"\')]}”’」』】';

/** Split into sentences, keeping the terminal punctuation with the sentence. */
export function splitSentences(text: string): string[] {
	const parts: string[] = [];
	let start = 0;

	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (!'.!?。！？'.includes(ch)) continue;

		// "0.5", "Fig.1" and "e.g.x" must not end a sentence.
		const next = text[i + 1];
		if (next && !/[\s"'”’)\]]/.test(next)) continue;

		let end = i + 1;
		while (end < text.length && SENTENCE_CLOSERS.includes(text[end])) end++;
		const sentence = text.slice(start, end).trim();
		if (sentence) parts.push(sentence);
		start = end;
		i = end - 1;
	}

	const tail = text.slice(start).trim();
	if (tail) parts.push(tail);
	return parts;
}

function hardSplit(text: string, maxChars: number): string[] {
	const out: string[] = [];
	let rest = text;

	while (rest.length > maxChars) {
		let cut = -1;
		for (const sep of ['; ', '；', ', ', '，', ' - ', ' ']) {
			const idx = rest.lastIndexOf(sep, maxChars);
			if (idx > maxChars * 0.4) {
				cut = idx + sep.length;
				break;
			}
		}
		if (cut <= 0) cut = maxChars;
		const head = rest.slice(0, cut).trim();
		if (head) out.push(head);
		rest = rest.slice(cut);
	}
	if (rest.trim()) out.push(rest.trim());
	return out;
}

export interface ChunkOptions {
	maxChars: number;
	/** Keep blank-line separated paragraphs in separate chunks. */
	respectParagraphs?: boolean;
}

export function chunkText(text: string, options: ChunkOptions): string[] {
	const maxChars = Math.max(200, Math.floor(options.maxChars || 1400));
	const normalized = text.replace(/\r\n?/g, '\n').trim();
	if (!normalized) return [];
	if (normalized.length <= maxChars) return [normalized];

	const blocks = options.respectParagraphs === false ? [normalized] : normalized.split(/\n\s*\n/);
	const chunks: string[] = [];

	for (const block of blocks) {
		const trimmed = block.trim();
		if (!trimmed) continue;
		if (trimmed.length <= maxChars) {
			chunks.push(trimmed);
			continue;
		}

		let current = '';
		const flush = () => {
			const value = current.trim();
			if (value) chunks.push(value);
			current = '';
		};

		for (const sentence of splitSentences(trimmed)) {
			if (sentence.length > maxChars) {
				flush();
				chunks.push(...hardSplit(sentence, maxChars));
				continue;
			}
			if (current && current.length + 1 + sentence.length > maxChars) flush();
			current = current ? `${current} ${sentence}` : sentence;
		}
		flush();
	}

	// Merge tiny remainders into the previous chunk to avoid one-word requests.
	const merged: string[] = [];
	for (const chunk of chunks) {
		const prev = merged[merged.length - 1];
		if (prev && chunk.length < 60 && prev.length + chunk.length + 1 <= maxChars) {
			merged[merged.length - 1] = `${prev} ${chunk}`;
		} else {
			merged.push(chunk);
		}
	}
	return merged;
}
