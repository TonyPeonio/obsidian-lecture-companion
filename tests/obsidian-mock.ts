// Minimal stand-in for the `obsidian` module so core modules that import types from it
// can be loaded under vitest. Only what the tested code touches is defined.
export class Plugin {}
export class ItemView {}
export class Modal {}
export class PluginSettingTab {}
export class Setting {}
export class Notice {}
export class TFile {}
export class TFolder {}
export class MarkdownView {}
export class WorkspaceLeaf {}
export class FileSystemAdapter {}
export const Platform = { isDesktopApp: true, isWin: false, isMacOS: false, isLinux: true };
export const MarkdownRenderer = { render: async () => {} };
export function setIcon(): void {}
export function normalizePath(p: string): string {
	return p.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");
}
export async function loadPdfJs(): Promise<never> {
	throw new Error("loadPdfJs is not available in tests");
}
export async function requestUrl(): Promise<never> {
	throw new Error("requestUrl is not available in tests");
}
