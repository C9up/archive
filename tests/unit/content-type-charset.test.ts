import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Ignitor } from "@c9up/ream";
import { createHyperServerFactory } from "@c9up/ream/bootstrap";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	LocalDriver,
	StaticMiddleware,
	StorageManager,
} from "../../src/index.js";
import { contentTypeHeader } from "../../src/mime-types.js";
import { createSignedRouteHandler } from "../../src/signed-route.js";

describe("archive > a served text file names its charset", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "archive-charset-"));
	const driver = new LocalDriver(root, {
		signingSecret: "app-key-0123456789abcdef0123456789",
	});
	const disk = new StorageManager(driver);
	let ignitor: Ignitor;
	let base: string;

	beforeAll(async () => {
		const assets = new StaticMiddleware({ root, prefix: "/assets" });
		ignitor = new Ignitor({
			port: 0,
			gracefulShutdown: false,
			serverFactory: createHyperServerFactory(),
		});
		ignitor
			.getServer()
			.use([
				createSignedRouteHandler({ storage: disk, driver }),
				assets.handle.bind(assets),
			]);
		await ignitor.httpServer().start();
		base = `http://127.0.0.1:${await ignitor.port()}`;
		await disk.put("page.html", "<p>sanitised comment</p>");
		await disk.put("notes.txt", "notes");
		await disk.put("data.json", "{}");
		await disk.put("app.js", "1");
		await disk.put("logo.png", Buffer.from([0x89, 0x50]));
	});
	afterAll(async () => {
		await ignitor.stop();
		fs.rmSync(root, { recursive: true, force: true });
	});

	const typeOf = async (url: string) => {
		const res = await fetch(`${base}${url}`);
		await res.arrayBuffer();
		return res.headers.get("content-type");
	};

	it.each([
		["page.html", "text/html; charset=utf-8"],
		["notes.txt", "text/plain; charset=utf-8"],
		["data.json", "application/json; charset=utf-8"],
		["app.js", "application/javascript; charset=utf-8"],
		["logo.png", "image/png"],
	])(
		"%s is sent as %s by the signed route and the static middleware",
		async (file, type) => {
			expect(await typeOf(`/storage/${file}`)).toBe(type);
			expect(await typeOf(`/assets/${file}`)).toBe(type);
		},
	);

	it("sends a signed contentType override exactly as signed", async () => {
		const url = driver.getSignedUrl("page.html", { contentType: "text/plain" });
		expect(await typeOf(url)).toBe("text/plain");
	});

	it("keeps a type that already names a charset", () => {
		expect(contentTypeHeader("text/html; charset=iso-8859-1")).toBe(
			"text/html; charset=iso-8859-1",
		);
		expect(contentTypeHeader("TEXT/CSS")).toBe("TEXT/CSS; charset=utf-8");
		expect(contentTypeHeader("application/octet-stream")).toBe(
			"application/octet-stream",
		);
	});
});
