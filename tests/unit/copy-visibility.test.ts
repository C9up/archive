import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Ignitor } from "@c9up/ream";
import { createHyperServerFactory } from "@c9up/ream/bootstrap";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalDriver, StorageManager } from "../../src/index.js";
import { createSignedRouteHandler } from "../../src/signed-route.js";

describe("archive > copy() of a private file on the local disk", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "archive-copy-vis-"));
	const driver = new LocalDriver(root, {
		signingSecret: "app-key-0123456789abcdef0123456789",
	});
	const disk = new StorageManager(driver);
	let ignitor: Ignitor;
	let base: string;

	beforeAll(async () => {
		ignitor = new Ignitor({
			port: 0,
			gracefulShutdown: false,
			serverFactory: createHyperServerFactory(),
		});
		ignitor
			.getServer()
			.use([createSignedRouteHandler({ storage: disk, driver })]);
		await ignitor.httpServer().start();
		base = `http://127.0.0.1:${await ignitor.port()}`;
	});
	afterAll(async () => {
		await ignitor.stop();
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("is private too, and refused without a signature", async () => {
		await disk.put("invoices/42.pdf", "PRIVATE INVOICE", {
			visibility: "private",
		});
		await disk.copy("invoices/42.pdf", "archive/2026/42.pdf");

		expect(await disk.getVisibility("archive/2026/42.pdf")).toBe("private");
		const url = await disk.getUrl("archive/2026/42.pdf");
		expect(url).toMatch(/^\/storage\/archive\/2026\/42\.pdf\?exp=/);
		expect((await fetch(`${base}/storage/archive/2026/42.pdf`)).status).toBe(
			403,
		);
		const signed = await fetch(`${base}${url}`);
		expect(await signed.text()).toBe("PRIVATE INVOICE");
	});

	it("replaces a public file with a private copy without a public window", async () => {
		await disk.put("dst.pdf", "public before", { visibility: "public" });
		await disk.put("src.pdf", "PRIVATE", { visibility: "private" });
		await disk.copy("src.pdf", "dst.pdf");
		expect(await disk.getVisibility("dst.pdf")).toBe("private");
		expect((await fetch(`${base}/storage/dst.pdf`)).status).toBe(403);
	});

	it("as move() keeps it", async () => {
		await disk.put("invoices/43.pdf", "PRIVATE 43", { visibility: "private" });
		await disk.move("invoices/43.pdf", "archive/2026/43.pdf");
		expect((await fetch(`${base}/storage/archive/2026/43.pdf`)).status).toBe(
			403,
		);
	});
});
