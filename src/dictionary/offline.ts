import dictionaryText from '../../data/dictionary.tsv';
import lemmaText from '../../data/lemma.tsv';

/**
 * Compact offline English→Chinese dictionary derived from ECDICT (MIT).
 *
 * The data is bundled into main.js, so word lookups work without Ollama or a
 * network connection. Inflected forms first go through the lemma table, then
 * through a small suffix fallback for forms the lemma list missed.
 */

export interface OfflineLookup {
	translation: string;
	candidates: string[];
	pos?: string;
	source: 'ECDICT';
	matched: string;
}

interface DictEntry {
	pos: string;
	translation: string;
}

let dictionary: Map<string, DictEntry> | null = null;
let lemmas: Map<string, string> | null = null;

function load(): void {
	if (dictionary && lemmas) return;

	const nextDictionary = new Map<string, DictEntry>();
	for (const line of dictionaryText.split('\n')) {
		if (!line) continue;
		const first = line.indexOf('\t');
		const second = first >= 0 ? line.indexOf('\t', first + 1) : -1;
		if (first < 0 || second < 0) continue;
		const word = line.slice(0, first).trim().toLowerCase();
		const pos = line.slice(first + 1, second).trim();
		const translation = line.slice(second + 1).trim();
		if (word && translation) nextDictionary.set(word, { pos, translation });
	}

	const nextLemmas = new Map<string, string>();
	for (const line of lemmaText.split('\n')) {
		if (!line) continue;
		const tab = line.indexOf('\t');
		if (tab < 0) continue;
		const form = line.slice(0, tab).trim().toLowerCase();
		const base = line.slice(tab + 1).trim().toLowerCase();
		if (form && base) nextLemmas.set(form, base);
	}

	dictionary = nextDictionary;
	lemmas = nextLemmas;
}

export function applyAdjectiveSuffix(translation: string, pos?: string): string {
	const text = translation.trim();
	if (!text || !/^(a|ad|adj)$/i.test(pos ?? '')) return text;
	if (/[的地得]$/.test(text)) return text;
	// A bare adjective sense from a domain line ("对应" from [计]) needs the
	// adjective marker; multi-word/phrasal senses already carry their own form.
	if (/^[\u4e00-\u9fff]{1,8}$/.test(text)) return `${text}的`;
	return text;
}

export function normalizeDictionaryWord(raw: string): string {
	return raw
		.trim()
		.toLowerCase()
		.replace(/^[^a-z0-9]+|[^a-z0-9'’\- ]+$/g, '')
		.replace(/\s+/g, ' ');
}

function resultFor(word: string, entry: DictEntry): OfflineLookup {
	const candidates = entry.translation
		.split('；')
		.map((item) => item.trim())
		.filter(Boolean);
	return {
		translation: candidates.join('；'),
		candidates,
		...(entry.pos ? { pos: entry.pos } : {}),
		source: 'ECDICT',
		matched: word,
	};
}

function suffixForms(word: string): string[] {
	const forms: string[] = [];
	const add = (value: string): void => {
		if (value && value !== word && !forms.includes(value)) forms.push(value);
	};
	if (word.endsWith("'s")) add(word.slice(0, -2));
	if (word.endsWith('ies')) add(`${word.slice(0, -3)}y`);
	if (word.endsWith('es')) add(word.slice(0, -2));
	if (word.endsWith('s')) add(word.slice(0, -1));
	if (word.endsWith('ied')) add(`${word.slice(0, -3)}y`);
	if (word.endsWith('ed')) add(word.slice(0, -2));
	if (word.endsWith('ing')) add(word.slice(0, -3));
	if (word.endsWith('ing')) add(`${word.slice(0, -3)}e`);
	if (word.endsWith('ed')) add(`${word.slice(0, -1)}`);
	if (/([b-df-hj-np-tv-z])\1(ed|ing)$/.test(word)) {
		add(word.replace(/([b-df-hj-np-tv-z])\1(?:ed|ing)$/, '$1'));
	}
	return forms;
}

export function lookupOfflineWord(raw: string): OfflineLookup | null {
	load();
	const word = normalizeDictionaryWord(raw);
	if (!word || !dictionary || !lemmas) return null;

	const direct = dictionary.get(word);
	if (direct) return resultFor(word, direct);

	const lemma = lemmas.get(word);
	if (lemma) {
		const base = dictionary.get(lemma);
		if (base) return resultFor(lemma, base);
	}

	for (const form of suffixForms(word)) {
		const exact = dictionary.get(form);
		if (exact) return resultFor(form, exact);
		const base = lemmas.get(form);
		if (base) {
			const entry = dictionary.get(base);
			if (entry) return resultFor(base, entry);
		}
	}

	return null;
}

/** Number of loaded entries, useful in diagnostics/tests. */
export function offlineDictionarySize(): number {
	load();
	return dictionary?.size ?? 0;
}
