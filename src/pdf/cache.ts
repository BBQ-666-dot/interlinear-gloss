import { App, normalizePath } from 'obsidian';
import type { GlossSettings, PdfCacheFile, PdfGlossRecord } from '../types';
import { normalizeForHash, sha256Hex } from '../cache/hash';

/**
 * PDF gloss persistence. Two backends:
 *  - sidecar JSON in the vault (`<book>.gloss.json`), human readable and syncable
 *  - localStorage, when the user does not want extra files in the vault
 */
export interface GlossRecordStore {
	load(pdfPath: string): Promise<Record<string, PdfGlossRecord>>;
	save(pdfPath: string, records: Record<string, PdfGlossRecord>): Promise<void>;
	describe(pdfPath: string): string;
}

export function recordId(pdfPath: string, page: number | null, text: string): Promise<string> {
	return sha256Hex(`${pdfPath}::${page ?? '?'}::${normalizeForHash(text)}`);
}

function sidecarPath(pdfPath: string, folder: string): string {
	const base = pdfPath.replace(/\.pdf$/i, '');
	const trimmedFolder = folder.trim().replace(/^\/+|\/+$/g, '');
	if (!trimmedFolder) return `${base}.gloss.json`;
	const name = base.split('/').pop() ?? 'gloss';
	return normalizePath(`${trimmedFolder}/${name}.gloss.json`);
}

export class VaultRecordStore implements GlossRecordStore {
	private folder: string;

	constructor(private app: App, folder: string) {
		this.folder = folder;
	}

	describe(pdfPath: string): string {
		return sidecarPath(pdfPath, this.folder);
	}

	async load(pdfPath: string): Promise<Record<string, PdfGlossRecord>> {
		const path = this.describe(pdfPath);
		try {
			if (!(await this.app.vault.adapter.exists(path))) return {};
			const raw = await this.app.vault.adapter.read(path);
			return parseCache(raw, pdfPath);
		} catch {
			return {};
		}
	}

	async save(pdfPath: string, records: Record<string, PdfGlossRecord>): Promise<void> {
		const path = this.describe(pdfPath);
		const payload: PdfCacheFile = {
			version: 1,
			pdfPath,
			updatedAt: Date.now(),
			records,
		};
		try {
			const dir = path.split('/').slice(0, -1).join('/');
			if (dir && !(await this.app.vault.adapter.exists(dir))) {
				await this.app.vault.adapter.mkdir(dir);
			}
			await this.app.vault.adapter.write(path, JSON.stringify(payload, null, 2));
		} catch (error) {
			console.error('[interlinear-gloss] 无法写入 PDF 词义缓存', path, error);
			throw error;
		}
	}
}

const LOCAL_PREFIX = 'interlinear-gloss:pdf:';

export class LocalRecordStore implements GlossRecordStore {
	private memo = new Map<string, Record<string, PdfGlossRecord>>();

	constructor(private app: App) {}

	describe(pdfPath: string): string {
		return `localStorage（${pdfPath}）`;
	}

	private async key(pdfPath: string): Promise<string> {
		return LOCAL_PREFIX + (await sha256Hex(pdfPath)).slice(0, 32);
	}

	async load(pdfPath: string): Promise<Record<string, PdfGlossRecord>> {
		const cached = this.memo.get(pdfPath);
		if (cached) return cached;
		try {
			const raw = window.localStorage.getItem(await this.key(pdfPath));
			if (!raw) return {};
			const records = parseCache(raw, pdfPath);
			this.memo.set(pdfPath, records);
			return records;
		} catch {
			return {};
		}
	}

	async save(pdfPath: string, records: Record<string, PdfGlossRecord>): Promise<void> {
		this.memo.set(pdfPath, records);
		const payload: PdfCacheFile = { version: 1, pdfPath, updatedAt: Date.now(), records };
		try {
			window.localStorage.setItem(await this.key(pdfPath), JSON.stringify(payload));
		} catch (error) {
			console.error('[interlinear-gloss] 无法写入 localStorage 缓存', error);
			throw error;
		}
	}
}

function parseCache(raw: string, pdfPath: string): Record<string, PdfGlossRecord> {
	try {
		const parsed = JSON.parse(raw) as Partial<PdfCacheFile>;
		if (!parsed || typeof parsed !== 'object' || !parsed.records) return {};
		const out: Record<string, PdfGlossRecord> = {};
		for (const [id, record] of Object.entries(parsed.records)) {
			if (!record || typeof record !== 'object') continue;
			if (typeof record.translation !== 'string' || typeof record.sourceText !== 'string') continue;
			out[id] = {
				...record,
				id,
				pdfPath,
				page: typeof record.page === 'number' ? record.page : null,
				items: Array.isArray(record.items) ? record.items : [],
				createdAt: typeof record.createdAt === 'number' ? record.createdAt : Date.now(),
				mode: record.mode ?? 'keywords',
			} as PdfGlossRecord;
		}
		return out;
	} catch {
		return {};
	}
}

export function createRecordStore(app: App, settings: GlossSettings): GlossRecordStore {
	return settings.pdfCacheInVault
		? new VaultRecordStore(app, settings.pdfCacheFolder)
		: new LocalRecordStore(app);
}

export function sortRecords(records: Record<string, PdfGlossRecord>): PdfGlossRecord[] {
	return Object.values(records).sort((a, b) => b.createdAt - a.createdAt);
}
