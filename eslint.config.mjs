import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
	globalIgnores(["node_modules", "main.js", ".e2e", "esbuild.config.mjs", "version-bump.mjs", "vitest.config.mts", "scripts", "tests", "test-vault", "models", "e2e", "wdio.conf.mts", ".obsidian-cache"]),
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			parserOptions: {
				projectService: { allowDefaultProject: ["eslint.config.*", "vitest.config.*"] },
			},
		},
		// Obsidian provides CodeMirror at runtime (esbuild marks it external), so it is not a dependency.
		settings: { "import/core-modules": ["@codemirror/state", "@codemirror/view"] },
	},
]);
