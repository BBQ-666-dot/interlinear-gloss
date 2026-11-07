import type { Editor } from 'obsidian';
import type { BlockSpan } from './blocks';

/**
 * Editor-level glue: resolve what the user is pointing at, then write.
 * Kept tiny so the command handlers in main.ts stay readable.
 */

export interface TextTarget {
	text: string;
	startLine: number;
	endLine: number;
}

const FENCE = /^\s{0,3}(```|~~~)/;
const HEADING = /^\s{0,3}#{1,6}\s/;
const BLANK = /^\s*$/;

export function getSelectionText(editor: Editor): string {
	return editor.getSelection().replace(/\r\n?/g, '\n').trim();
}

/** Selection range in line numbers (0 based). */
export function getSelectionLines(editor: Editor): { startLine: number; endLine: number } {
	const from = editor.getCursor('from');
	const to = editor.getCursor('to');
	const startLine = from.line;
	const endLine = to.ch === 0 && to.line > from.line ? to.line - 1 : to.line;
	return { startLine, endLine };
}

/** Paragraph around the cursor: bounded by blank lines / fences / headings. */
export function getParagraphAtCursor(editor: Editor): TextTarget | null {
	const cursor = editor.getCursor();
	let start = cursor.line;
	let end = cursor.line;

	if (BLANK.test(editor.getLine(start))) return null;
	if (FENCE.test(editor.getLine(start))) return null;

	while (start > 0 && !BLANK.test(editor.getLine(start - 1)) && !FENCE.test(editor.getLine(start - 1))) {
		start--;
	}
	while (
		end < editor.lineCount() - 1 &&
		!BLANK.test(editor.getLine(end + 1)) &&
		!FENCE.test(editor.getLine(end + 1)) &&
		!HEADING.test(editor.getLine(end + 1))
	) {
		end++;
	}

	// Do not swallow a heading that starts the block.
	while (start < end && HEADING.test(editor.getLine(start))) start++;

	const lines: string[] = [];
	for (let i = start; i <= end; i++) lines.push(editor.getLine(i));
	const text = lines.join('\n').trim();
	if (!text) return null;
	return { text, startLine: start, endLine: end };
}

export function resolveEditorTarget(editor: Editor, mode: 'selection' | 'paragraph'): TextTarget | null {
	const selection = getSelectionText(editor);
	if (mode === 'selection' && selection) {
		const lines = getSelectionLines(editor);
		return { text: selection, startLine: lines.startLine, endLine: lines.endLine };
	}
	if (selection) {
		const lines = getSelectionLines(editor);
		return { text: selection, startLine: lines.startLine, endLine: lines.endLine };
	}
	return getParagraphAtCursor(editor);
}

/** Insert a block right below `anchorLine`, keeping one blank line of padding. */
export function insertBlockAtLine(editor: Editor, anchorLine: number, block: string): void {
	const lineText = editor.getLine(anchorLine);
	editor.replaceRange(`\n\n${block}\n`, { line: anchorLine, ch: lineText.length });
	editor.setCursor({ line: Math.min(anchorLine + 3, editor.lineCount() - 1), ch: 0 });
}

export function replaceBlockSpan(editor: Editor, span: BlockSpan, block: string): void {
	const endLineText = editor.getLine(span.endLine) ?? '';
	editor.replaceRange(
		block,
		{ line: span.startLine, ch: 0 },
		{ line: span.endLine, ch: endLineText.length },
	);
	editor.setCursor({ line: span.startLine + 1, ch: 0 });
}

export function removeBlockSpan(editor: Editor, span: BlockSpan): void {
	const from = { line: span.startLine, ch: 0 };
	const to = { line: span.endLine, ch: (editor.getLine(span.endLine) ?? '').length };
	editor.replaceRange('', from, to);
	// Drop the leftover blank line so the note does not accumulate gaps.
	const line = span.startLine;
	if (line > 0 && line < editor.lineCount() && editor.getLine(line) !== undefined) {
		if (editor.getLine(line).trim() === '' && editor.getLine(line - 1).trim() === '') {
			editor.replaceRange('', { line, ch: 0 }, { line: line + 1, ch: 0 });
		}
	}
}
