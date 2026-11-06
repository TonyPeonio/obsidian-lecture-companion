import { type App, normalizePath, TFile, TFolder } from "obsidian";
import { nestedSectionBody, sectionBody, upsertNestedSection, upsertSection } from "./core/notes";

/** Where a lecture's sections live: a note, optionally nested under a date heading. */
export interface NoteTarget {
	path: string;
	parentHeading?: string;
}

/** Thin, awaitable wrapper around the parts of the Vault API the plugin needs. */
export class VaultIO {
	constructor(private app: App) {}

	exists(path: string): boolean {
		return this.app.vault.getAbstractFileByPath(normalizePath(path)) !== null;
	}

	file(path: string): TFile | null {
		const f = this.app.vault.getAbstractFileByPath(normalizePath(path));
		return f instanceof TFile ? f : null;
	}

	async ensureFolder(folder: string): Promise<void> {
		const parts = normalizePath(folder).split("/").filter(Boolean);
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!this.app.vault.getAbstractFileByPath(current)) {
				try {
					await this.app.vault.createFolder(current);
				} catch {
					// created concurrently
				}
			}
		}
	}

	async read(path: string): Promise<string> {
		const f = this.file(path);
		if (!f) throw new Error(`Note not found: ${path}`);
		return this.app.vault.read(f);
	}

	/** Creates the note (and folders) or replaces its content. */
	async write(path: string, content: string): Promise<TFile> {
		const p = normalizePath(path);
		const existing = this.file(p);
		if (existing) {
			await this.app.vault.process(existing, () => content);
			return existing;
		}
		const dir = p.split("/").slice(0, -1).join("/");
		if (dir) await this.ensureFolder(dir);
		return this.app.vault.create(p, content);
	}

	/** Creates the note only when missing; returns true when it was created. */
	async createIfMissing(path: string, content: string): Promise<boolean> {
		if (this.file(path)) return false;
		await this.write(path, content);
		return true;
	}

	async createBinary(path: string, data: ArrayBuffer): Promise<TFile> {
		const p = normalizePath(path);
		const dir = p.split("/").slice(0, -1).join("/");
		if (dir) await this.ensureFolder(dir);
		const existing = this.file(p);
		if (existing) {
			await this.app.vault.modifyBinary(existing, data);
			return existing;
		}
		return this.app.vault.createBinary(p, data);
	}

	/** Respects the user's attachment-folder setting; de-duplicates names. */
	attachmentPath(filename: string, forNotePath: string): Promise<string> {
		return this.app.fileManager.getAvailablePathForAttachment(filename, normalizePath(forNotePath));
	}

	/** Read-modify-write of one section, atomically via `Vault.process`. */
	async writeSection(target: NoteTarget, heading: string, body: string, mode: "append" | "replace", skeleton = ""): Promise<void> {
		const p = normalizePath(target.path);
		let f = this.file(p);
		if (!f) f = await this.write(p, skeleton);
		await this.app.vault.process(f, (md) =>
			target.parentHeading
				? upsertNestedSection(md, target.parentHeading, heading, body, mode)
				: upsertSection(md, heading, body, mode),
		);
	}

	async readSection(target: NoteTarget, heading: string): Promise<string | null> {
		const f = this.file(target.path);
		if (!f) return null;
		const md = await this.app.vault.read(f);
		return target.parentHeading ? nestedSectionBody(md, target.parentHeading, heading) : sectionBody(md, heading);
	}

	async open(path: string): Promise<void> {
		const f = this.file(path);
		if (!f) return;
		await this.app.workspace.getLeaf(false).openFile(f);
	}

	/** Course names implied by the course folder: sub-folders and top-level notes. */
	coursesInFolder(folder: string): string[] {
		const f = this.app.vault.getAbstractFileByPath(normalizePath(folder));
		if (!(f instanceof TFolder)) return [];
		const names = new Set<string>();
		for (const child of f.children) {
			if (child instanceof TFolder) names.add(child.name);
			else if (child instanceof TFile && child.extension === "md") names.add(child.basename);
		}
		return [...names].sort((a, b) => a.localeCompare(b));
	}

	/** Absolute filesystem path of the plugin's folder (desktop only). */
	pluginDir(pluginId: string, manifestDir?: string): string {
		const adapter = this.app.vault.adapter as { getBasePath?: () => string };
		const base = adapter.getBasePath ? adapter.getBasePath() : "";
		const rel = manifestDir ?? `${this.app.vault.configDir}/plugins/${pluginId}`;
		return base ? `${base}/${rel}` : rel;
	}
}
