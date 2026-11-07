/** Small, dependency-free hashing helpers used for cache keys and block de-duplication. */

/** FNV-1a 32 bit; fast and stable, good enough for version tags and block identity. */
export function fnv1a(input: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, '0');
}

/** 64 bit-ish string built from two seeded FNV passes; used for PDF record ids. */
export function shortHash(input: string): string {
	return fnv1a(input) + fnv1a('#' + input) + fnv1a('|' + input.length);
}

export function normalizeForHash(text: string): string {
	return text.replace(/\s+/g, ' ').replace(/\u00a0/g, ' ').trim().toLowerCase();
}

/** WebCrypto SHA-256 with a deterministic fallback (older/odd runtimes). */
export async function sha256Hex(text: string): Promise<string> {
	const subtle = globalThis.crypto?.subtle;
	if (subtle) {
		try {
			const bytes = new TextEncoder().encode(text);
			const digest = await subtle.digest('SHA-256', bytes);
			return Array.from(new Uint8Array(digest))
				.map((b) => b.toString(16).padStart(2, '0'))
				.join('');
		} catch {
			/* fall through */
		}
	}
	return shortHash(text) + shortHash(text + '~');
}

export async function cacheKey(parts: (string | number)[]): Promise<string> {
	return sha256Hex(parts.join('|'));
}
