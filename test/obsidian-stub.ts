/* Minimal `obsidian` stand-in so the Node test bundle can resolve the module.
   Type-only imports are erased by esbuild; this exists so any accidental
   runtime import fails loudly instead of being silently undefined. */
export function normalizePath(path: string): string {
	return path.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
}

export class App {}
export class TFile {}
export class Notice {
	constructor(_message?: string, _timeout?: number) {}
}
export class Plugin {}
export class ItemView {}
export class Modal {}
export class PluginSettingTab {}
export class Setting {}
export class Editor {}
export class MarkdownView {}
