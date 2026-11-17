// End-to-end tests in a real Obsidian (wdio-obsidian-service downloads it into .obsidian-cache).
// Run with `npm run e2e:obsidian` after `npm run build`. Each test starts from a fresh copy of
// e2e/vault with this plugin installed.
import * as path from "path";

export const config: WebdriverIO.Config = {
	runner: "local",
	framework: "mocha",
	specs: ["./e2e/specs/**/*.e2e.ts"],
	maxInstances: 1,
	capabilities: [
		{
			browserName: "obsidian",
			browserVersion: process.env.OBSIDIAN_VERSION ?? "latest",
			"wdio:obsidianOptions": {
				installerVersion: "latest",
				plugins: ["."],
				vault: "e2e/vault",
			},
		},
	],
	services: ["obsidian"],
	reporters: ["spec"],
	cacheDir: path.resolve(".obsidian-cache"),
	mochaOpts: { ui: "bdd", timeout: 90_000 },
	logLevel: "warn",
};
