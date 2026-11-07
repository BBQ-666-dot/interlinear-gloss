import { ItemView, WorkspaceLeaf } from 'obsidian';
import type { GlossBlockData, PdfGlossRecord, PdfWordMark } from '../types';
import { renderGlossContent } from '../markdown/render';

export const VIEW_TYPE_GLOSS = 'interlinear-gloss-sidebar';

export interface PdfSidebarContext {
	pdfPath: string | null;
	page: number | null;
	selection: string;
}

/**
 * Everything the sidebar needs from the plugin, declared here to keep the
 * import graph one-directional (`main` → `sidebar`, never the reverse).
 */
export interface PdfSidebarHost {
	getPdfContext(): PdfSidebarContext;
	getRecords(pdfPath: string): PdfGlossRecord[];
	glossSelection(): Promise<void>;
	glossText(text: string): Promise<void>;
	regenerate(record: PdfGlossRecord): Promise<void>;
	copyRecord(record: PdfGlossRecord): Promise<string>;
	removeRecord(record: PdfGlossRecord): Promise<void>;
	getMarks(pdfPath: string): PdfWordMark[];
	markSelection(): Promise<void>;
	editMark(mark: PdfWordMark): void;
	removeMark(mark: PdfWordMark): Promise<void>;
	locateMark(mark: PdfWordMark): void;
}

function recordToData(record: PdfGlossRecord): GlossBlockData {
	return {
		version: 1,
		sourceText: record.sourceText,
		translation: record.translation,
		items: record.items,
		mode: record.mode,
		model: record.model,
		createdAt: record.createdAt,
		meta: record.meta,
	};
}

export class GlossSidebarView extends ItemView {
	private host: PdfSidebarHost;
	private busy = false;

	constructor(leaf: WorkspaceLeaf, host: PdfSidebarHost) {
		super(leaf);
		this.host = host;
	}

	getViewType(): string {
		return VIEW_TYPE_GLOSS;
	}

	getDisplayText(): string {
		return 'PDF 词义';
	}

	getIcon(): string {
		return 'languages';
	}

	async onOpen(): Promise<void> {
		this.render();
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}

	async refresh(): Promise<void> {
		this.render();
	}

	private setBusy(value: boolean): void {
		this.busy = value;
		this.render();
	}

	render(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass('ig-sidebar');

		const context = this.host.getPdfContext();
		const head = root.createDiv({ cls: 'ig-sb-head' });
		if (!context.pdfPath) {
			head.createDiv({ cls: 'ig-sb-title', text: '没有打开的 PDF' });
			head.createDiv({
				cls: 'ig-sb-hint',
				text: '在左侧文件树里打开一本书，再在正文中划选一段，然后点「译选中」。',
			});
			root.createDiv({ cls: 'ig-sb-empty', text: '也可以把段落粘贴到下面的输入框里生成。' });
			this.renderManualInput(root);
			return;
		}

		const name = context.pdfPath.split('/').pop() ?? context.pdfPath;
		head.createDiv({ cls: 'ig-sb-title', text: name });
		const pageLabel = context.page ? `第 ${context.page} 页` : '页码未知';
		const selectionLabel = context.selection
			? `已选中 ${context.selection.length} 字符`
			: '未选中文字';
		head.createDiv({ cls: 'ig-sb-hint', text: `${pageLabel} · ${selectionLabel}` });

		const actions = head.createDiv({ cls: 'ig-sb-actions' });
		const glossButton = actions.createEl('button', { cls: 'ig-btn ig-btn-primary', text: '译选中' });
		glossButton.disabled = !context.selection || this.busy;
		glossButton.addEventListener('click', () => {
			if (this.busy) return;
			this.setBusy(true);
			void this.host.glossSelection().finally(() => this.setBusy(false));
		});

		const markButton = actions.createEl('button', { cls: 'ig-btn', text: '标注选中词' });
		markButton.disabled = this.busy;
		markButton.addEventListener('click', () => {
			if (this.busy) return;
			this.setBusy(true);
			void this.host.markSelection().finally(() => this.setBusy(false));
		});

		const refreshButton = actions.createEl('button', { cls: 'ig-btn', text: '刷新' });
		refreshButton.addEventListener('click', () => {
			void this.refresh();
		});

		this.renderManualInput(root);
		this.renderRecords(root, context.pdfPath);
		this.renderMarks(root, context.pdfPath);
	}

	private renderManualInput(root: HTMLElement): void {
		const box = root.createDiv({ cls: 'ig-sb-manual' });
		const textarea = box.createEl('textarea', {
			cls: 'ig-sb-textarea',
			attr: { placeholder: '选中不了？把段落粘贴到这里，回车生成（Shift+Enter 换行）' },
		});
		const row = box.createDiv({ cls: 'ig-sb-row' });
		const button = row.createEl('button', { cls: 'ig-btn', text: '生成' });
		const submit = () => {
			const text = textarea.value.trim();
			if (!text || this.busy) return;
			this.setBusy(true);
			void this.host.glossText(text).finally(() => {
				this.setBusy(false);
				textarea.value = '';
			});
		};
		button.addEventListener('click', submit);
		textarea.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' && !event.shiftKey) {
				event.preventDefault();
				submit();
			}
		});
	}

	private renderRecords(root: HTMLElement, pdfPath: string): void {
		const records = this.host.getRecords(pdfPath);
		const list = root.createDiv({ cls: 'ig-sb-list' });
		if (!records.length) {
			list.createDiv({ cls: 'ig-sb-empty', text: '这本书还没有词义记录。' });
			return;
		}
		list.createDiv({ cls: 'ig-sb-count', text: `共 ${records.length} 条记录` });

		for (const record of records) {
			const card = list.createDiv({ cls: 'ig-sb-card' });
			const top = card.createDiv({ cls: 'ig-sb-card-head' });
			top.createSpan({
				cls: 'ig-sb-page',
				text: record.page ? `P${record.page}` : 'P?',
			});
			top.createSpan({ cls: 'ig-sb-model', text: record.model });

			const tools = top.createDiv({ cls: 'ig-sb-tools' });
			const regen = tools.createEl('button', { cls: 'ig-icon-btn', text: '重新生成' });
			regen.disabled = this.busy;
			regen.addEventListener('click', () => {
				if (this.busy) return;
				this.setBusy(true);
				void this.host.regenerate(record).finally(() => this.setBusy(false));
			});
			const copy = tools.createEl('button', { cls: 'ig-icon-btn', text: '复制' });
			copy.addEventListener('click', () => {
				void this.host.copyRecord(record);
			});
			const remove = tools.createEl('button', { cls: 'ig-icon-btn is-danger', text: '删除' });
			remove.disabled = this.busy;
			remove.addEventListener('click', () => {
				if (this.busy) return;
				this.setBusy(true);
				void this.host.removeRecord(record).finally(() => this.setBusy(false));
			});

			const body = card.createDiv({ cls: 'ig-sb-body' });
			renderGlossContent(body, recordToData(record), { showSource: true, compact: true });
		}
	}

	private renderMarks(root: HTMLElement, pdfPath: string): void {
		const marks = this.host.getMarks(pdfPath);
		const section = root.createDiv({ cls: 'ig-sb-marks' });
		section.createDiv({
			cls: 'ig-sb-count',
			text: marks.length ? `词标注（${marks.length}）` : '词标注',
		});
		if (!marks.length) {
			section.createDiv({
				cls: 'ig-sb-empty',
				text: '在正文里选中一个单词，运行「标注 PDF 选中词」，标签会贴在原词下方。',
			});
			return;
		}

		for (const mark of marks) {
			const row = section.createDiv({ cls: 'ig-sb-mark' });
			const line = row.createDiv({ cls: 'ig-sb-mark-line' });
			line.createSpan({ cls: 'ig-sb-page', text: mark.page ? `P${mark.page}` : 'P?' });
			line.createSpan({ cls: 'ig-sb-mark-word', text: mark.text });
			line.createSpan({ cls: 'ig-sb-mark-arrow', text: '→' });
			line.createSpan({ cls: 'ig-sb-mark-trans', text: mark.translation });
			if (mark.pos) {
				line.createSpan({ cls: 'ig-sb-mark-pos', text: mark.pos });
			}

			const tools = row.createDiv({ cls: 'ig-sb-tools' });
			const locate = tools.createEl('button', { cls: 'ig-icon-btn', text: '定位' });
			locate.addEventListener('click', () => this.host.locateMark(mark));

			const edit = tools.createEl('button', { cls: 'ig-icon-btn', text: '编辑' });
			edit.addEventListener('click', () => this.host.editMark(mark));

			const remove = tools.createEl('button', { cls: 'ig-icon-btn is-danger', text: '删除' });
			remove.disabled = this.busy;
			remove.addEventListener('click', () => {
				if (this.busy) return;
				this.setBusy(true);
				void this.host.removeMark(mark).finally(() => this.setBusy(false));
			});
		}
	}
}
