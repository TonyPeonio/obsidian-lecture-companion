// A small translation layer. `t("panel.record")` looks the key up in the dictionary for
// Obsidian's interface language and falls back to English; `{name}` placeholders are filled from
// `vars`. Only English ships today: to add a language, copy `EN` in i18n-en.ts, translate the
// values, and register it in LOCALES (keys missing from a translation fall back to English).

import { getLanguage } from "obsidian";
import { EN, type Messages } from "./i18n-en";

export type MessageKey = keyof Messages;

const LOCALES: Record<string, Partial<Messages>> = { en: EN };

/** Obsidian's interface language ("en" when it cannot be read). */
export function currentLocale(): string {
	try {
		return getLanguage().toLowerCase();
	} catch {
		return "en";
	}
}

export function translate(locale: string, key: MessageKey, vars?: Record<string, string | number>): string {
	const dict = LOCALES[locale] ?? LOCALES[locale.split("-")[0] ?? ""] ?? EN;
	const text = dict[key] ?? EN[key] ?? key;
	return vars ? text.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m)) : text;
}

export function t(key: MessageKey, vars?: Record<string, string | number>): string {
	return translate(currentLocale(), key, vars);
}
