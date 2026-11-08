import {
	App,
	Editor,
	MarkdownView,
	Modal,
	Notice,
	Plugin,
	TFile,
	WorkspaceLeaf,
	debounce,
	setIcon,
} from 'obsidian';
import type { MarkdownFileInfo, MarkdownPostProcessorContext, MarkdownSectionInformation } from 'obsidian';

import type { GlossBlockData, GlossMode, GlossSettings, PdfGlossRecord, PdfWordMark } from './types';
import { DEFAULT_SETTINGS, mergeSettings } from './settings';
import { consoleLogger } from './log';
import { shortHash, normalizeForHash } from './cache/hash';
import { generateGloss } from './gloss/engine';
import type { GeneratedGloss } from './gloss/engine';
import { translateSentence, translateWordInContext } from './gloss/word';
import { applyAdjectiveSuffix, lookupOfflineWord } from './dictionary/offline';
import { chooseOfflineSense } from './dictionary/sense';
import { resolveGlossary } from './gloss/glossary';
import { createProvider, ProviderError } from './providers/provider';
import type { TranslationProvider } from './providers/provider';
import { ObsidianTransport } from './providers/obsidianTransport';
import {
	GLOSS_FENCE_OPEN,
	findBlockAtLine,
	findDuplicateBlock,
	findGlossBlockNear,
	findGlossBlocks,
	findPortableBlocks,
	insertBlockIntoText,
	makeGlossBlock,
	offsetToLine,
	portableMarkers,
	replaceBlockInText,
	removeBlockFromText,
	locateTextInSource,
	type BlockSpan,
	type PortableSpan,
} from './markdown/blocks';
import {
	getParagraphAtCursor,
	getSelectionLines,
	getSelectionText,
	insertBlockAtLine,
	removeBlockSpan,
	replaceBlockSpan,
} from './markdown/insert';
import { glossToMarkdown, renderGlossBlock } from './markdown/render';
import {
	describePdfView,
	getActivePdfView,
	getCurrentPdfPage,
	getPdfSelection,
} from './pdf/adapter';
import type { PdfViewLike } from './pdf/adapter';
import { createRecordStore, recordId, sortRecords } from './pdf/cache';
import type { GlossRecordStore } from './pdf/cache';
import { createMarkStore, findSameMark, markId, sortMarks } from './pdf/marks';
import type { MarkStore } from './pdf/marks';
import { PdfMarkOverlay } from './pdf/overlay';
import { GlossSidebarView, VIEW_TYPE_GLOSS } from './pdf/sidebar';
import type { PdfSidebarContext, PdfSidebarHost } from './pdf/sidebar';
import { captureWordSelection, PAGE_SELECTOR } from './pdf/wordSelection';
import { GlossSettingTab } from './ui/settingsTab';

const SECRET_ID = 'interlinear-gloss-api-key';

interface LocatedBlock {
	kind: 'fence' | 'portable';
	startLine: number;
	endLine: number;
	data: GlossBlockData | null;
}

class DuplicateBlockModal extends Modal {
	private onRegenerate: () => void;
	private onRemove: () => void;

	constructor(app: App, onRegenerate: () => void, onRemove: () => void) {
		super(app);
		this.onRegenerate = onRegenerate;
		this.onRemove = onRemove;
	}

	onOpen(): void {
		this.titleEl.setText('这里已经有词义了');
		this.contentEl.createEl('p', {
			text: '同一段文字下方已经有一个词义块。重新生成会覆盖它的内容，删除会把它从笔记里移除。',
		});
		const row = this.contentEl.createDiv({ cls: 'ig-modal-actions' });

		const regen = row.createEl('button', { cls: 'mod-cta', text: '重新生成' });
		regen.addEventListener('click', () => {
			this.close();
			this.onRegenerate();
		});

		const remove = row.createEl('button', { cls: 'mod-warning', text: '删除词义块' });
		remove.addEventListener('click', () => {
			this.close();
			this.onRemove();
		});

		const cancel = row.createEl('button', { text: '取消' });
		cancel.addEventListener('click', () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class WordMarkModal extends Modal {
	constructor(
		app: App,
		private mark: PdfWordMark,
		private onSave: (translation: string) => void,
		private onDelete: () => void,
		private onLocate: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass('ig-mark-modal');
		this.titleEl.setText(`编辑标注 · ${this.mark.text}`);

		contentEl.createDiv({
			cls: 'ig-mark-meta',
			text: `第 ${this.mark.page} 页${this.mark.pos ? ` · ${this.mark.pos}` : ''} · ${this.mark.model || '未知模型'}`,
		});

		if (this.mark.sentenceTranslation) {
			const sentence = contentEl.createDiv({ cls: 'ig-mark-sentence' });
			sentence.createDiv({ cls: 'ig-mark-sentence-label', text: '整句翻译' });
			sentence.createDiv({ cls: 'ig-mark-sentence-text', text: this.mark.sentenceTranslation });
			if (this.mark.sentence) sentence.title = this.mark.sentence;
		}

		const input = contentEl.createEl('input', {
			cls: 'ig-mark-input',
			attr: { type: 'text', value: this.mark.translation, placeholder: '中文释义' },
		});
		input.focus();
		input.select();

		const row = contentEl.createDiv({ cls: 'ig-modal-actions' });

		const save = row.createEl('button', { cls: 'mod-cta', text: '保存' });
		const commit = () => {
			const value = input.value.trim();
			if (!value) {
				new Notice('释义不能为空');
				return;
			}
			this.close();
			this.onSave(value);
		};
		save.addEventListener('click', commit);
		input.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') {
				event.preventDefault();
				commit();
			}
		});

		const locate = row.createEl('button', { text: '在页面中定位' });
		locate.addEventListener('click', () => {
			this.close();
			this.onLocate();
		});

		const remove = row.createEl('button', { cls: 'mod-warning', text: '删除标注' });
		remove.addEventListener('click', () => {
			this.close();
			this.onDelete();
		});

		const cancel = row.createEl('button', { text: '取消' });
		cancel.addEventListener('click', () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export default class InterlinearGlossPlugin extends Plugin implements PdfSidebarHost {
	settings: GlossSettings = { ...DEFAULT_SETTINGS };

	private transport = new ObsidianTransport();
	private provider: TranslationProvider | null = null;
	private providerSignature = '';
	private apiKey = '';
	private recordStore: GlossRecordStore | null = null;
	private recordSignature = '';
	private recordCache = new Map<string, Record<string, PdfGlossRecord>>();
	private sidebar: GlossSidebarView | null = null;
	private refreshSidebarSoon!: () => void;
	private markStore: MarkStore | null = null;
	private markSignature = '';
	private markCache = new Map<string, PdfWordMark[]>();
	private overlay: PdfMarkOverlay | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.registerView(VIEW_TYPE_GLOSS, (leaf: WorkspaceLeaf) => {
			const view = new GlossSidebarView(leaf, this);
			this.sidebar = view;
			return view;
		});

		this.refreshSidebarSoon = debounce(() => void this.refreshSidebar(), 150, true);

		const ribbon = this.addRibbonIcon('languages', 'Interlinear Gloss：译选中', () => {
			const pdf = getActivePdfView(this.app);
			const pdfSelection = pdf ? getPdfSelection(pdf) : null;
			if (pdfSelection) {
				void this.glossPdfText(pdfSelection.text, pdfSelection.page);
				return;
			}
			const view = this.activeMarkdownView();
			if (!view) {
				new Notice('请先在 Markdown 笔记或 PDF 里选中一段文字');
				return;
			}
			const selection = getSelectionText(view.editor);
			if (!selection) {
				new Notice('请先选中一段文字，或改用命令「Gloss current paragraph」');
				return;
			}
			void this.glossMarkdownSelection(view);
		});
		ribbon.setAttribute('aria-label', 'Interlinear Gloss');

		this.registerCommands();
		this.registerCodeBlockRenderer();
		this.registerWorkspaceEvents();

		this.addSettingTab(new GlossSettingTab(this.app, this));

		this.overlay = new PdfMarkOverlay(
			{
				marksFor: (pdfPath: string, page: number) =>
					this.getMarks(pdfPath).filter((mark) => mark.page === page),
				onEdit: (mark: PdfWordMark) => this.editMark(mark),
			},
			() => this.settings,
		);
		this.register(() => this.overlay?.destroy());

		this.app.workspace.onLayoutReady(() => {
			this.syncOverlay();
			this.refreshSidebarSoon();
		});
	}

	onunload(): void {
		this.sidebar = null;
		this.overlay?.destroy();
		this.overlay = null;
	}

	private registerCommands(): void {
		this.addCommand({
			id: 'gloss-selection',
			name: 'Gloss selection（译选中）',
			checkCallback: (checking: boolean) => {
				const view = this.activeMarkdownView();
				const selection = view ? getSelectionText(view.editor) : '';
				const pdf = getActivePdfView(this.app);
				const pdfSelection = pdf ? getPdfSelection(pdf) : null;

				if (!selection && !pdfSelection) return false;
				if (checking) return true;

				if (selection && view) {
					void this.glossMarkdownSelection(view);
				} else if (pdf && pdfSelection) {
					void this.glossPdfText(pdfSelection.text, pdfSelection.page);
				}
				return true;
			},
		});

		this.addCommand({
			id: 'gloss-paragraph',
			name: 'Gloss current paragraph（译当前段落）',
			editorCallback: (editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => {
				const view = this.resolveMarkdownView(ctx);
				if (!view) return;
				const paragraph = getParagraphAtCursor(editor);
				if (!paragraph) {
					new Notice('光标没有停在一个段落里（可能是空行或代码块）');
					return;
				}
				void this.glossMarkdownTarget(view, paragraph, 'paragraph');
			},
		});

		this.addCommand({
			id: 'regenerate-gloss',
			name: 'Regenerate gloss（重新生成）',
			editorCallback: (editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => {
				const view = this.resolveMarkdownView(ctx);
				if (!view) return;
				const located = this.locateBlockAtCursor(editor);
				if (!located) {
					new Notice('光标附近没有找到词义块');
					return;
				}
				if (!view.file) return;
				void this.regenerateLocated(view.file, located);
			},
		});

		this.addCommand({
			id: 'remove-gloss',
			name: 'Remove gloss（删除词义块）',
			editorCallback: (editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => {
				const view = this.resolveMarkdownView(ctx);
				if (!view) return;
				const located = this.locateBlockAtCursor(editor);
				if (!located) {
					new Notice('光标附近没有找到词义块');
					return;
				}
				this.removeLocatedFromEditor(editor, located);
			},
		});

		this.addCommand({
			id: 'pdf-mark-word',
			name: 'Mark PDF word（标注 PDF 选中词）',
			hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'z' }],
			checkCallback: (checking: boolean) => {
				const pdf = getActivePdfView(this.app);
				if (!pdf) return false;
				const capture = captureWordSelection(pdf, this.settings);
				if (!capture.ok) return false;
				if (checking) return true;
				void this.markPdfSelection();
				return true;
			},
		});

		this.addCommand({
			id: 'pdf-mark-edit',
			name: 'Edit PDF word mark（编辑 PDF 标注）',
			checkCallback: (checking: boolean) => {
				const pdf = getActivePdfView(this.app);
				if (!pdf) return false;
				const capture = captureWordSelection(pdf, this.settings);
				if (!capture.ok) return false;
				if (checking) return true;
				void this.editSelectedMark();
				return true;
			},
		});

		this.addCommand({
			id: 'pdf-mark-delete',
			name: 'Delete PDF word mark（删除 PDF 标注）',
			checkCallback: (checking: boolean) => {
				const pdf = getActivePdfView(this.app);
				if (!pdf) return false;
				const capture = captureWordSelection(pdf, this.settings);
				if (!capture.ok) return false;
				if (checking) return true;
				void this.deleteSelectedMark();
				return true;
			},
		});

		this.addCommand({
			id: 'pdf-mark-toggle',
			name: 'Toggle PDF word marks（显示 / 隐藏 PDF 标注）',
			callback: () => void this.toggleMarks(),
		});

		this.addCommand({
			id: 'open-pdf-gloss-sidebar',
			name: 'Open PDF gloss sidebar（打开 PDF 词义侧栏）',
			callback: () => void this.openSidebar(),
		});

		this.addCommand({
			id: 'gloss-diagnostics',
			name: 'Diagnostics（诊断：PDF 与模型连通性）',
			callback: () => void this.runDiagnostics(),
		});
	}

	private registerCodeBlockRenderer(): void {
		this.registerMarkdownCodeBlockProcessor('gloss', (source, el, ctx) => {
			const info = ctx.getSectionInfo(el);
			const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
			const targetFile = file instanceof TFile ? file : null;
			renderGlossBlock(el, source, {
				onCopy: () => {
					const data = this.parseBlockData(source);
					if (data) void this.copyData(data);
				},
				onRegenerate: targetFile && info
					? () => void this.regenerateAtLine(targetFile, ctx.sourcePath, info.lineStart)
					: undefined,
				onRemove: targetFile && info
					? () => void this.removeAtLine(targetFile, info.lineStart)
					: undefined,
			});

			// The buttons live inside the rendered block; give them a stable hook.
			if (info) {
				el.setAttribute('data-ig-line', String(info.lineStart));
			}
		});
	}

	private registerWorkspaceEvents(): void {
		this.registerEvent(
			this.app.workspace.on('file-open', () => {
				this.refreshSidebarSoon();
				this.syncOverlay();
			}),
		);
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', () => {
				this.refreshSidebarSoon();
				this.syncOverlay();
			}),
		);
		this.registerEvent(
			this.app.workspace.on('layout-change', () => this.syncOverlay()),
		);

		const onSelectionChange = debounce(() => {
			if (!this.sidebar) return;
			const active = document.activeElement;
			if (active instanceof HTMLElement && this.sidebar.contentEl.contains(active)) return;
			this.sidebar.render();
		}, 350);
		this.registerDomEvent(document, 'selectionchange', onSelectionChange);
	}

	/* ------------------------------------------------------------------ */
	/* Settings                                                            */
	/* ------------------------------------------------------------------ */

	async loadSettings(): Promise<void> {
		const raw = (await this.loadData()) as unknown;
		this.settings = mergeSettings(raw);
		this.apiKey = this.readApiKey();
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.recordStore = null;
		this.provider = null;
	}

	readApiKey(): string {
		try {
			return this.app.secretStorage?.getSecret(SECRET_ID) ?? '';
		} catch {
			return '';
		}
	}

	setApiKey(value: string): void {
		const key = value.trim();
		try {
			if (key) this.app.secretStorage.setSecret(SECRET_ID, key);
		} catch (error) {
			console.error('[interlinear-gloss] 无法保存 API Key', error);
			new Notice('无法写入系统钥匙串，API Key 只在本次会话内生效');
		}
		this.apiKey = key;
	}

	hasApiKey(): boolean {
		return Boolean(this.apiKey);
	}

	/* ------------------------------------------------------------------ */
	/* Provider / engine                                                   */
	/* ------------------------------------------------------------------ */

	private getProvider(): TranslationProvider {
		const signature = [
			this.settings.provider,
			this.settings.baseUrl,
			this.apiKey ? 'k' : '-',
		].join('|');
		if (!this.provider || signature !== this.providerSignature) {
			this.provider = createProvider(this.settings, this.transport, this.apiKey);
			this.providerSignature = signature;
		}
		return this.provider;
	}

	async listModels(): Promise<string[]> {
		return this.getProvider().listModels();
	}

	private modelLabel(): string {
		return this.settings.model;
	}

	async generate(text: string): Promise<GeneratedGloss | null> {
		const notice = new Notice('正在翻译…', 0);
		try {
			const result = await generateGloss(text, {
				provider: this.getProvider(),
				settings: this.settings,
				log: consoleLogger,
				onProgress: (done, total, phase) => {
					const label = phase === 'translate' ? '正在翻译' : '正在整理词义';
					notice.setMessage(total > 1 ? `${label}…（${done}/${total} 段）` : `${label}…`);
				},
			});
			notice.hide();
			const seconds = (result.elapsedMs / 1000).toFixed(1);
			const glossModel = result.data.meta?.glossaryModel;
			const models =
				glossModel && glossModel !== result.data.model
					? `${result.data.model} 译 / ${glossModel} 词义`
					: result.data.model;
			new Notice(`词义已生成（${models}，${seconds}s）`);
			return result;
		} catch (error) {
			notice.hide();
			this.reportError(error);
			return null;
		}
	}

	private reportError(error: unknown): void {
		if (error instanceof ProviderError) {
			const hint = error.retryable ? '\n可以稍后再试，或检查设置里的服务地址与模型名。' : '';
			new Notice(`${error.message}${hint}`, 8000);
			console.error('[interlinear-gloss]', error.message, error.detail ?? '');
			return;
		}
		const message = error instanceof Error ? error.message : String(error);
		new Notice(`生成失败：${message}`, 8000);
		console.error('[interlinear-gloss]', error);
	}

	/* ------------------------------------------------------------------ */
	/* Markdown                                                            */
	/* ------------------------------------------------------------------ */

	private activeMarkdownView(): MarkdownView | null {
		return this.app.workspace.getActiveViewOfType(MarkdownView);
	}

	/** Commands may run against a MarkdownView or a bare MarkdownFileInfo. */
	private resolveMarkdownView(ctx?: MarkdownView | MarkdownFileInfo | null): MarkdownView | null {
		if (ctx instanceof MarkdownView) return ctx;
		return this.activeMarkdownView();
	}

	async glossMarkdownSelection(view: MarkdownView): Promise<void> {
		const selection = getSelectionText(view.editor);
		if (!selection) {
			new Notice('没有选中文字');
			return;
		}
		const lines = getSelectionLines(view.editor);
		await this.glossMarkdownTarget(
			view,
			{ text: selection, startLine: lines.startLine, endLine: lines.endLine },
			'selection',
		);
	}

	private async glossMarkdownTarget(
		view: MarkdownView,
		target: { text: string; startLine: number; endLine: number },
		origin: 'selection' | 'paragraph',
	): Promise<void> {
		const file = view.file;
		if (!file) {
			new Notice('这个笔记还没有保存到磁盘，无法插入');
			return;
		}
		if (target.text.trim().length < 4) {
			new Notice('选中的内容太短了，至少选一个词');
			return;
		}
		if (view.getMode() === 'source') {
			await this.glossInEditor(file, view.editor, target);
		} else {
			await this.glossInReadingView(file, target.text, origin);
		}
	}

	private async glossInEditor(
		file: TFile,
		editor: Editor,
		target: { text: string; startLine: number; endLine: number },
	): Promise<void> {
		const lines = editor.getValue().split('\n');
		const duplicate = findDuplicateBlock(lines, target.endLine, target.text);
		const portable = this.findPortableDuplicate(lines, target.endLine, target.text);

		if (duplicate || portable) {
			new DuplicateBlockModal(
				this.app,
				() => {
					void (async () => {
						const existing = duplicate ?? portable;
						if (!existing) return;
						await this.regenerateEditorSpan(file, editor, existing);
					})();
				},
				() => this.removeEditorSpan(editor, duplicate ?? portable),
			).open();
			return;
		}

		const generated = await this.generate(target.text);
		if (!generated) return;

		const block = this.formatBlock(generated.data);
		const anchorLine = this.trimTrailingBlankAbove(lines, target.endLine, target.startLine);
		insertBlockAtLine(editor, anchorLine, block);
		this.refreshSidebarSoon();
	}

	private async glossInReadingView(
		file: TFile,
		text: string,
		origin: 'selection' | 'paragraph',
	): Promise<void> {
		let located = null as { start: number; end: number } | null;
		try {
			const content = await this.app.vault.read(file);
			located = locateTextInSource(content, text);
		} catch (error) {
			this.reportError(error);
			return;
		}
		if (!located) {
			new Notice(
				origin === 'paragraph'
					? '阅读模式里定位不到这一段，请切到编辑模式（Ctrl/Cmd+E）再试'
					: '阅读模式里定位不到选中的文字（可能跨了表格或链接），请切到编辑模式再试',
			);
			return;
		}

		const generated = await this.generate(text);
		if (!generated) return;
		const block = this.formatBlock(generated.data);

		try {
			await this.app.vault.process(file, (data) => {
				const lines = data.split('\n');
				const anchor = Math.max(0, Math.min(lines.length - 1, offsetToLine(data, located!.end)));
				const shifted = this.trimTrailingBlankAbove(lines, anchor, 0);
				return insertBlockIntoText(data, shifted, block);
			});
			new Notice('词义已插入到原文下方');
			this.refreshSidebarSoon();
		} catch (error) {
			this.reportError(error);
		}
	}

	/** Do not insert after trailing blank lines inside a selection. */
	private trimTrailingBlankAbove(lines: string[], anchorLine: number, floor: number): number {
		let anchor = Math.min(anchorLine, lines.length - 1);
		while (anchor > floor && lines[anchor].trim() === '') anchor--;
		return anchor;
	}

	private findPortableDuplicate(
		lines: string[],
		anchorLine: number,
		text: string,
	): PortableSpan | null {
		const hash = shortHash(normalizeForHash(text));
		const end = Math.min(lines.length - 1, anchorLine + 30);
		for (const span of findPortableBlocks(lines)) {
			if (span.startLine <= anchorLine || span.startLine > end) continue;
			if (span.hash === hash) return span;
		}
		return null;
	}

	private formatBlock(data: GlossBlockData): string {
		return data.mode === 'portable' ? this.formatPortable(data) : makeGlossBlock(data);
	}

	private formatPortable(data: GlossBlockData): string {
		const hash = shortHash(normalizeForHash(data.sourceText));
		const markers = portableMarkers(hash);
		return glossToMarkdown(data, markers.start, markers.end);
	}

	/** Locate a gloss block (fenced or portable) at or below the cursor. */
	private locateBlockAtCursor(editor: Editor): LocatedBlock | null {
		const lines = editor.getValue().split('\n');
		const cursor = editor.getCursor().line;
		const fence = findBlockAtLine(lines, cursor) ?? findGlossBlockNear(lines, cursor, 80, 40);
		if (fence) {
			return { kind: 'fence', startLine: fence.startLine, endLine: fence.endLine, data: fence.data };
		}
		const portable = findPortableBlocks(lines).find(
			(span) => cursor >= span.startLine && cursor <= span.endLine,
		) ?? findPortableBlocks(lines).find((span) => span.startLine > cursor && span.startLine <= cursor + 80);
		if (portable) {
			return {
				kind: 'portable',
				startLine: portable.startLine,
				endLine: portable.endLine,
				data: null,
			};
		}
		return null;
	}

	private removeEditorSpan(editor: Editor, span: BlockSpan | PortableSpan | null): void {
		if (!span) return;
		if ('source' in span) {
			removeBlockSpan(editor, span);
		} else {
			editor.replaceRange(
				'',
				{ line: span.startLine, ch: 0 },
				{ line: span.endLine, ch: (editor.getLine(span.endLine) ?? '').length },
			);
		}
	}

	private async regenerateEditorSpan(
		file: TFile,
		editor: Editor,
		span: BlockSpan | PortableSpan,
	): Promise<void> {
		const lines = editor.getValue().split('\n');
		const sourceText = 'source' in span ? span.data?.sourceText ?? '' : this.paragraphAbove(lines, span.startLine);
		if (!sourceText.trim()) {
			new Notice('找不到这个词义块对应的原文，请手动重新生成');
			return;
		}
		const generated = await this.generate(sourceText);
		if (!generated) return;
		const block = this.formatBlock(generated.data);
		if ('source' in span) {
			replaceBlockSpan(editor, span, block);
		} else {
			editor.replaceRange(
				block,
				{ line: span.startLine, ch: 0 },
				{ line: span.endLine, ch: (editor.getLine(span.endLine) ?? '').length },
			);
		}
		void file;
	}

	private paragraphAbove(lines: string[], markerLine: number): string {
		let i = markerLine - 1;
		while (i >= 0 && lines[i].trim() === '') i--;
		const end = i;
		while (i >= 0 && lines[i].trim() !== '') i--;
		const start = i + 1;
		if (end < start) return '';
		return lines.slice(start, end + 1).join('\n');
	}

	/** File-based regenerate used by the buttons inside rendered blocks. */
	private async regenerateAtLine(file: TFile, sourcePath: string, lineStart: number): Promise<void> {
		try {
			const content = await this.app.vault.read(file);
			const lines = content.split('\n');
			const span = findGlossBlockNear(lines, lineStart, 4) ?? findGlossBlocks(lines)[0];
			if (!span || !span.data) {
				new Notice('找不到这个词义块（笔记可能刚被修改过），请刷新后重试');
				return;
			}
			const generated = await this.generate(span.data.sourceText);
			if (!generated) return;
			const block = makeGlossBlock(generated.data);
			await this.app.vault.process(file, (data) => {
				const currentLines = data.split('\n');
				const current = findGlossBlocks(currentLines).find(
					(item) => item.startLine === span.startLine || item.startLine === lineStart,
				);
				return current ? replaceBlockInText(data, current, block) : data;
			});
			void sourcePath;
		} catch (error) {
			this.reportError(error);
		}
	}

	private async removeAtLine(file: TFile, lineStart: number): Promise<void> {
		try {
			await this.app.vault.process(file, (data) => {
				const lines = data.split('\n');
				const span = findBlockAtLine(lines, lineStart);
				return span ? removeBlockFromText(data, span) : data;
			});
			new Notice('词义块已删除');
		} catch (error) {
			this.reportError(error);
		}
	}

	private parseBlockData(source: string): GlossBlockData | null {
		try {
			const parsed = JSON.parse(source) as GlossBlockData;
			return parsed && parsed.version === 1 ? parsed : null;
		} catch {
			return null;
		}
	}

	private async regenerateLocated(file: TFile, located: LocatedBlock): Promise<void> {
		const view = this.activeMarkdownView();
		if (view && view.file?.path === file.path && view.getMode() === 'source') {
			const lines = view.editor.getValue().split('\n');
			const span =
				located.kind === 'fence'
					? findBlockAtLine(lines, located.startLine)
					: findPortableBlocks(lines).find((item) => item.startLine === located.startLine) ?? null;
			if (span) {
				await this.regenerateEditorSpan(file, view.editor, span);
				return;
			}
		}
		await this.regenerateAtLine(file, file.path, located.startLine);
	}

	private removeLocatedFromEditor(editor: Editor, located: LocatedBlock): void {
		const lines = editor.getValue().split('\n');
		if (located.kind === 'fence') {
			const span = findBlockAtLine(lines, located.startLine);
			if (span) removeBlockSpan(editor, span);
			return;
		}
		const span = findPortableBlocks(lines).find((item) => item.startLine === located.startLine);
		if (!span) return;
		editor.replaceRange(
			'',
			{ line: span.startLine, ch: 0 },
			{ line: span.endLine, ch: (editor.getLine(span.endLine) ?? '').length },
		);
	}

	/* ------------------------------------------------------------------ */
	/* PDF                                                                 */
	/* ------------------------------------------------------------------ */

	getPdfContext(): PdfSidebarContext {
		const pdf = getActivePdfView(this.app);
		if (!pdf) return { pdfPath: null, page: null, selection: '' };
		const selection = getPdfSelection(pdf);
		return {
			pdfPath: pdf.file.path,
			page: selection?.page ?? getCurrentPdfPage(pdf),
			selection: selection?.text ?? '',
		};
	}

	getRecords(pdfPath: string): PdfGlossRecord[] {
		const cached = this.recordCache.get(pdfPath);
		return cached ? sortRecords(cached) : [];
	}

	async openSidebar(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_GLOSS);
		let leaf: WorkspaceLeaf | null = existing[0] ?? null;
		if (!leaf) {
			leaf = this.app.workspace.getRightLeaf(false);
			if (!leaf) return;
			await leaf.setViewState({ type: VIEW_TYPE_GLOSS, active: true });
		}
		this.app.workspace.revealLeaf(leaf);
		await this.refreshSidebar();
	}

	private getRecordStore(): GlossRecordStore {
		const signature = `${this.settings.pdfCacheInVault}|${this.settings.pdfCacheFolder}`;
		if (!this.recordStore || signature !== this.recordSignature) {
			this.recordStore = createRecordStore(this.app, this.settings);
			this.recordSignature = signature;
			this.recordCache.clear();
		}
		return this.recordStore;
	}

	private async loadRecords(pdfPath: string): Promise<Record<string, PdfGlossRecord>> {
		const cached = this.recordCache.get(pdfPath);
		if (cached) return cached;
		const records = await this.getRecordStore().load(pdfPath);
		this.recordCache.set(pdfPath, records);
		return records;
	}

	private async saveRecords(
		pdfPath: string,
		records: Record<string, PdfGlossRecord>,
	): Promise<void> {
		this.recordCache.set(pdfPath, records);
		await this.getRecordStore().save(pdfPath, records);
	}

	async refreshSidebar(): Promise<void> {
		const context = this.getPdfContext();
		if (context.pdfPath) await this.loadRecords(context.pdfPath);
		this.sidebar?.render();
	}

	async glossSelection(): Promise<void> {
		const context = this.getPdfContext();
		if (!context.pdfPath) {
			new Notice('请先打开一个 PDF');
			return;
		}
		if (!context.selection) {
			new Notice('先在 PDF 正文里划选一段文字');
			return;
		}
		await this.glossPdfText(context.selection, context.page);
	}

	async glossText(text: string): Promise<void> {
		const context = this.getPdfContext();
		if (!context.pdfPath) {
			new Notice('请先打开一个 PDF');
			return;
		}
		await this.glossPdfText(text, context.page);
	}

	private async glossPdfText(text: string, page: number | null): Promise<void> {
		const pdf = getActivePdfView(this.app);
		if (!pdf) {
			new Notice('没有打开的 PDF');
			return;
		}
		if (text.trim().length < 4) {
			new Notice('选中的内容太短了');
			return;
		}
		const generated = await this.generate(text);
		if (!generated) return;

		const pdfPath = pdf.file.path;
		const id = await recordId(pdfPath, page, text);
		const records = await this.loadRecords(pdfPath);
		records[id] = {
			id,
			pdfPath,
			page,
			sourceText: generated.data.sourceText,
			translation: generated.data.translation,
			items: generated.data.items,
			model: generated.data.model,
			createdAt: generated.data.createdAt,
			mode: generated.data.mode,
			meta: generated.data.meta,
		};
		await this.saveRecords(pdfPath, records);
		new Notice('已保存到这本书的 PDF 词义记录');
		this.refreshSidebarSoon();
	}

	async regenerate(record: PdfGlossRecord): Promise<void> {
		const generated = await this.generate(record.sourceText);
		if (!generated) return;
		const records = await this.loadRecords(record.pdfPath);
		records[record.id] = {
			...record,
			translation: generated.data.translation,
			items: generated.data.items,
			model: generated.data.model,
			createdAt: generated.data.createdAt,
			mode: generated.data.mode,
			meta: generated.data.meta,
		};
		await this.saveRecords(record.pdfPath, records);
		this.refreshSidebarSoon();
	}

	async removeRecord(record: PdfGlossRecord): Promise<void> {
		const records = await this.loadRecords(record.pdfPath);
		delete records[record.id];
		await this.saveRecords(record.pdfPath, records);
		this.refreshSidebarSoon();
	}

	async copyRecord(record: PdfGlossRecord): Promise<string> {
		const text = this.dataToPlainText({
			version: 1,
			sourceText: record.sourceText,
			translation: record.translation,
			items: record.items,
			mode: record.mode,
			model: record.model,
			createdAt: record.createdAt,
		});
		await this.copyText(text);
		return text;
	}

	private async copyData(data: GlossBlockData): Promise<void> {
		await this.copyText(this.dataToPlainText(data));
	}

	private async copyText(text: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(text);
			new Notice('已复制到剪贴板');
		} catch {
			const textarea = document.createElement('textarea');
			textarea.value = text;
			document.body.appendChild(textarea);
			textarea.select();
			document.execCommand('copy');
			textarea.remove();
			new Notice('已复制到剪贴板');
		}
	}

	private dataToPlainText(data: GlossBlockData): string {
		const lines: string[] = [`**译文**：${data.translation}`, ''];
		if (data.items.length) {
			lines.push('| 单词 / 短语 | 词性 | 释义 |', '| --- | --- | --- |');
			for (const item of data.items) {
				lines.push(`| ${item.source} | ${item.pos ?? ''} | ${item.target} |`);
			}
		}
		return lines.join('\n');
	}

	/* ------------------------------------------------------------------ */
	/* PDF word marks                                                      */
	/* ------------------------------------------------------------------ */

	private getMarkStore(): MarkStore {
		const signature = `${this.settings.pdfMarkCacheInVault}|${this.settings.pdfMarkCacheFolder}`;
		if (!this.markStore || signature !== this.markSignature) {
			this.markStore = createMarkStore(this.app, this.settings);
			this.markSignature = signature;
			this.markCache.clear();
		}
		return this.markStore;
	}

	private async loadMarks(pdfPath: string): Promise<PdfWordMark[]> {
		const cached = this.markCache.get(pdfPath);
		if (cached) return cached;
		const marks = await this.getMarkStore().load(pdfPath);
		this.markCache.set(pdfPath, marks);
		return marks;
	}

	private async saveMarks(pdfPath: string, marks: PdfWordMark[]): Promise<void> {
		const sorted = sortMarks(marks);
		this.markCache.set(pdfPath, sorted);
		await this.getMarkStore().save(pdfPath, sorted);
		this.overlay?.refresh();
	}

	getMarks(pdfPath: string): PdfWordMark[] {
		const cached = this.markCache.get(pdfPath);
		return cached ? [...cached] : [];
	}

	/** Attach the overlay to the active PDF, or take it down. */
	syncOverlay(): void {
		const pdf = getActivePdfView(this.app);
		if (!pdf || !this.settings.pdfMarksEnabled) {
			this.overlay?.detach();
			return;
		}
		this.overlay?.attach(pdf);
		if (!this.markCache.has(pdf.file.path)) {
			void this.loadMarks(pdf.file.path).then(() => this.overlay?.refresh());
		}
	}

	private pageSizeOf(pdf: PdfViewLike, page: number): { width: number; height: number } {
		const element = pdf.containerEl.querySelector<HTMLElement>(
			`${PAGE_SELECTOR}[data-page-number="${page}"]`,
		);
		const rect = element?.getBoundingClientRect();
		return { width: rect?.width || 1, height: rect?.height || 1 };
	}

	private async findMarkForSelection(
		pdf: PdfViewLike,
		selection: { text: string; page: number; rects: PdfWordMark['rects'] },
	): Promise<PdfWordMark | null> {
		const marks = await this.loadMarks(pdf.file.path);
		const exact = findSameMark(
			marks,
			selection.page,
			selection.text,
			selection.rects,
			this.pageSizeOf(pdf, selection.page),
		);
		if (exact) return exact;
		const needle = normalizeForHash(selection.text);
		return (
			marks.find((mark) => mark.page === selection.page && normalizeForHash(mark.text) === needle) ?? null
		);
	}

	async markSelection(): Promise<void> {
		await this.markPdfSelection();
	}

	private async markPdfSelection(): Promise<void> {
		const pdf = getActivePdfView(this.app);
		if (!pdf) {
			new Notice('请先打开一个 PDF');
			return;
		}
		if (!this.settings.pdfMarksEnabled) {
			new Notice('PDF 词标注已关闭，可在设置或命令面板里重新打开');
			return;
		}
		const capture = captureWordSelection(pdf, this.settings);
		if (!capture.ok) {
			new Notice(capture.message);
			return;
		}
		const selection = capture.selection;
		const pdfPath = pdf.file.path;
		const marks = await this.loadMarks(pdfPath);
		const existing = await this.findMarkForSelection(pdf, selection);
		if (existing) {
			new Notice(`这里已经标注过：${existing.text} → ${existing.translation}`);
			this.overlay?.focusMark(existing);
			return;
		}

		const notice = new Notice(`正在查「${selection.text}」…`, 0);
		let result: { translation: string; model: string; pos?: string } | null = null;
		const glossary = resolveGlossary(this.settings.customGlossary);
		const glossaryHit = glossary[selection.text.trim().toLowerCase()];
		if (glossaryHit) {
			result = { translation: glossaryHit, model: '术语表' };
		} else {
			const offline = this.settings.offlineDictionaryEnabled ? lookupOfflineWord(selection.text) : null;
			if (offline) {
				let translation = offline.translation;
				let model = 'ECDICT';
				if (offline.candidates.length > 1 && this.settings.offlineSenseSelection) {
					const chosen = await chooseOfflineSense(
						this.getProvider(),
						this.settings,
						selection.text,
						selection.quoteBefore,
						selection.quoteAfter,
						offline.candidates,
						consoleLogger,
					);
					if (chosen) {
						translation = applyAdjectiveSuffix(chosen.translation, offline.pos);
						model = 'ECDICT+AI';
					} else {
						// Constrained selection failed: keep a dictionary sense rather
						// than falling back to an unconstrained model translation.
						translation = applyAdjectiveSuffix(offline.candidates[0] ?? offline.translation, offline.pos);
					}
				} else if (offline.candidates.length > 1) {
					// AI selection is off: keep the whole dictionary entry.
					translation = offline.translation;
				} else {
					translation = applyAdjectiveSuffix(offline.translation, offline.pos);
				}
				result = {
					translation,
					model,
					...(offline.pos ? { pos: offline.pos } : {}),
				};
			} else if (!this.settings.offlineDictionaryFallback) {
				notice.hide();
				new Notice(`离线词典未收录「${selection.text}」；可在设置里开启模型兜底`);
				return;
			} else {
				try {
					result = await translateWordInContext(
						this.getProvider(),
						{
							text: selection.text,
							quoteBefore: selection.quoteBefore,
							quoteAfter: selection.quoteAfter,
							settings: this.settings,
						},
						consoleLogger,
					);
				} catch (error) {
					notice.hide();
					this.reportError(error);
					return;
				}
			}
		}
		let sentenceTranslation: string | undefined;
		let sentenceModel: string | undefined;
		if (this.settings.pdfMarkTranslateSentence && selection.sentence) {
			try {
				notice.setMessage('正在翻译整句…');
				const full = await translateSentence(this.getProvider(), selection.sentence, this.settings, consoleLogger);
				sentenceTranslation = full.translation;
				sentenceModel = full.model;
			} catch (error) {
				consoleLogger.warn('整句翻译失败，词标注仍会保存', error);
			}
		}
		notice.hide();

		const now = Date.now();
		const mark: PdfWordMark = {
			id: await markId(pdfPath, selection.page, selection.text, selection.rects, selection.quoteBefore, selection.quoteAfter),
			pdfPath,
			page: selection.page,
			text: selection.text,
			translation: result.translation,
			...(result.pos ? { pos: result.pos } : {}),
			rects: selection.rects,
			quoteBefore: selection.quoteBefore,
			quoteAfter: selection.quoteAfter,
			...(sentenceTranslation
				? {
						sentence: selection.sentence,
						sentenceTranslation,
						...(sentenceModel ? { sentenceModel } : {}),
					}
				: {}),
			color: this.settings.pdfMarkColor,
			labelMode: this.settings.pdfMarkLabelMode,
			model: result.model,
			createdAt: now,
			updatedAt: now,
		};
		await this.saveMarks(pdfPath, [...marks.filter((item) => item.id !== mark.id), mark]);
		new Notice(`${selection.text} → ${result.translation}`);
		this.refreshSidebarSoon();
	}

	private async editSelectedMark(): Promise<void> {
		const pdf = getActivePdfView(this.app);
		if (!pdf) return;
		const capture = captureWordSelection(pdf, this.settings);
		if (!capture.ok) {
			new Notice(capture.message);
			return;
		}
		const mark = await this.findMarkForSelection(pdf, capture.selection);
		if (!mark) {
			new Notice('这个位置还没有标注');
			return;
		}
		this.editMark(mark);
	}

	private async deleteSelectedMark(): Promise<void> {
		const pdf = getActivePdfView(this.app);
		if (!pdf) return;
		const capture = captureWordSelection(pdf, this.settings);
		if (!capture.ok) {
			new Notice(capture.message);
			return;
		}
		const mark = await this.findMarkForSelection(pdf, capture.selection);
		if (!mark) {
			new Notice('这个位置还没有标注');
			return;
		}
		await this.removeMark(mark);
	}

	editMark(mark: PdfWordMark): void {
		new WordMarkModal(
			this.app,
			mark,
			(translation: string) => void this.updateMark(mark, translation),
			() => void this.removeMark(mark),
			() => this.locateMark(mark),
		).open();
	}

	private async updateMark(mark: PdfWordMark, translation: string): Promise<void> {
		const marks = await this.loadMarks(mark.pdfPath);
		const next = marks.map((item) =>
			item.id === mark.id ? { ...item, translation, updatedAt: Date.now() } : item,
		);
		await this.saveMarks(mark.pdfPath, next);
		new Notice('标注已更新');
		this.refreshSidebarSoon();
	}

	async removeMark(mark: PdfWordMark): Promise<void> {
		const marks = await this.loadMarks(mark.pdfPath);
		await this.saveMarks(
			mark.pdfPath,
			marks.filter((item) => item.id !== mark.id),
		);
		new Notice('标注已删除');
		this.refreshSidebarSoon();
	}

	locateMark(mark: PdfWordMark): void {
		const moved = this.overlay?.focusMark(mark) ?? false;
		if (!moved) new Notice(`没有找到第 ${mark.page} 页，打开这本书后再试`);
	}

	async toggleMarks(): Promise<void> {
		this.settings.pdfMarksEnabled = !this.settings.pdfMarksEnabled;
		await this.saveSettings();
		this.syncOverlay();
		if (this.settings.pdfMarksEnabled) this.overlay?.refresh();
		new Notice(this.settings.pdfMarksEnabled ? '已显示 PDF 词标注' : '已隐藏 PDF 词标注');
	}

	/* ------------------------------------------------------------------ */
	/* Diagnostics                                                         */
	/* ------------------------------------------------------------------ */

	async runDiagnostics(): Promise<void> {
		const pdf = getActivePdfView(this.app);
		const pdfLine = describePdfView(pdf);
		const store = this.getRecordStore();
		const cacheLine = pdf ? `缓存：${store.describe(pdf.file.path)}` : '缓存：尚未打开 PDF';
		const markLine = pdf
			? `标注：${this.getMarkStore().describe(pdf.file.path)}（${this.getMarks(pdf.file.path).length} 条）`
			: '标注：尚未打开 PDF';

		let models = '';
		try {
			const list = await this.listModels();
			models = list.length ? `可用模型：${list.slice(0, 8).join(', ')}` : '可用模型：（空）';
		} catch (error) {
			models = `模型列表获取失败：${error instanceof Error ? error.message : String(error)}`;
		}

		const text = [
			`服务商：${this.settings.provider}（${this.settings.baseUrl}）`,
			`当前模型：${this.modelLabel()}`,
			models,
			`PDF：${pdfLine}`,
			cacheLine,
			markLine,
		].join('\n');
		new Notice(text, 12000);
		console.log('[interlinear-gloss] diagnostics\n' + text);
	}

	/* ------------------------------------------------------------------ */
	/* Small helpers used by the settings tab                              */
	/* ------------------------------------------------------------------ */

	activePdf(): PdfViewLike | null {
		return getActivePdfView(this.app);
	}

	describeBlockModes(): string {
		const modes: Record<GlossMode, string> = {
			keywords: '关键词表（默认）',
			strict: '严格逐词（实验）',
			portable: '便携 Markdown',
		};
		return modes[this.settings.mode];
	}
}

export { DuplicateBlockModal };
