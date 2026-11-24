import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Ignitor } from "@c9up/ream";
import { createHyperServerFactory } from "@c9up/ream/bootstrap";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StaticMiddleware } from "../../src/index.js";

const HIDDEN = [
	"/.vite/manifest.json",
	"/.vscode/settings.json",
	"/.deploy.json",
	"/%2Edeploy.json",
	"/sub/.hidden.txt",
];

describe("archive > StaticMiddleware and dot-files", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "archive-dotfiles-"));
	let ignitor: Ignitor;
	let base: string;

	beforeAll(async () => {
		fs.mkdirSync(path.join(root, ".vite"));
		fs.writeFileSync(path.join(root, ".vite/manifest.json"), '{"build":1}');
		fs.mkdirSync(path.join(root, ".vscode"));
		fs.writeFileSync(path.join(root, ".vscode/settings.json"), '{"pw":"x"}');
		fs.writeFileSync(path.join(root, ".deploy.json"), '{"token":"t"}');
		fs.mkdirSync(path.join(root, "sub"));
		fs.writeFileSync(path.join(root, "sub/.hidden.txt"), "hidden");
		fs.writeFileSync(path.join(root, "app.css"), "body{}");
		const middlewares = [
			new StaticMiddleware({ root, prefix: "/ignore" }),
			new StaticMiddleware({ root, prefix: "/deny", dotFiles: "deny" }),
			new StaticMiddleware({ root, prefix: "/allow", dotFiles: "allow" }),
		];
		ignitor = new Ignitor({
			port: 0,
			gracefulShutdown: false,
			serverFactory: createHyperServerFactory(),
		});
		ignitor.getServer().use(middlewares.map((m) => m.handle.bind(m)));
		await ignitor.httpServer().start();
		base = `http://127.0.0.1:${await ignitor.port()}`;
	});
	afterAll(async () => {
		await ignitor.stop();
		fs.rmSync(root, { recursive: true, force: true });
	});

	const statusOf = async (url: string) => {
		const res = await fetch(`${base}${url}`);
		await res.arrayBuffer();
		return res.status;
	};

	it.each(HIDDEN)("ignores %s by default (falls through)", async (file) => {
		expect(await statusOf(`/ignore${file}`)).toBe(404);
	});

	it.each(HIDDEN)("answers 403 for %s under 'deny'", async (file) => {
		expect(await statusOf(`/deny${file}`)).toBe(403);
	});

	it.each(HIDDEN)("serves %s under 'allow'", async (file) => {
		expect(await statusOf(`/allow${file}`)).toBe(200);
	});

	it("serves an ordinary file under every policy", async () => {
		for (const prefix of ["/ignore", "/deny", "/allow"]) {
			expect(await statusOf(`${prefix}/app.css`)).toBe(200);
		}
	});
});
