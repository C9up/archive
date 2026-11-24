import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Ignitor } from "@c9up/ream";
import { createHyperServerFactory } from "@c9up/ream/bootstrap";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalDriver, StorageManager } from "../../src/index.js";
import { createSignedRouteHandler } from "../../src/signed-route.js";

const APP_KEY = "app-key-0123456789abcdef0123456789";

/**
 * Three local disks sharing one secret, as the config stub gives every local
 * disk `APP_KEY`: two private ones that name files after a record id, and a
 * public one holding a few private files.
 */
describe("archive > the signed route over several disks", () => {
	const roots = ["inv", "con", "pub"].map((name) =>
		fs.mkdtempSync(path.join(os.tmpdir(), `archive-route-${name}-`)),
	);
	const [rootA = "", rootB = "", rootC = ""] = roots;
	const invoicesDriver = new LocalDriver(rootA, {
		signingSecret: APP_KEY,
		routeBasePath: "/files/invoices",
		visibility: "private",
	});
	const contractsDriver = new LocalDriver(rootB, {
		signingSecret: APP_KEY,
		routeBasePath: "/files/contracts",
		visibility: "private",
	});
	const publicDriver = new LocalDriver(rootC, {
		signingSecret: APP_KEY,
		routeBasePath: "/files/public",
	});
	const invoices = new StorageManager(invoicesDriver);
	const contracts = new StorageManager(contractsDriver);
	const shared = new StorageManager(publicDriver);
	let ignitor: Ignitor;
	let base: string;

	beforeAll(async () => {
		ignitor = new Ignitor({
			port: 0,
			gracefulShutdown: false,
			serverFactory: createHyperServerFactory(),
		});
		const routes = [
			createSignedRouteHandler({ storage: invoices, driver: invoicesDriver }),
			createSignedRouteHandler({ storage: contracts, driver: contractsDriver }),
			createSignedRouteHandler({ storage: shared, driver: publicDriver }),
		];
		ignitor.getServer().use(routes);
		await ignitor.httpServer().start();
		base = `http://127.0.0.1:${await ignitor.port()}`;
	});
	afterAll(async () => {
		await ignitor.stop();
		for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
	});

	const answer = async (url: string) => {
		const res = await fetch(`${base}${url}`);
		return { status: res.status, body: await res.text() };
	};

	describe("a URL signed by one disk", () => {
		it("opens its own file", async () => {
			await invoices.put("42.pdf", "invoice 42");
			const res = await answer(await invoices.getUrl("42.pdf"));
			expect(res).toEqual({ status: 200, body: "invoice 42" });
		});

		it("is refused by another disk sharing its secret", async () => {
			await contracts.put("42.pdf", "CONTRACT 42");
			const signed = await invoices.getUrl("42.pdf");
			const replayed = signed.replace("/files/invoices/", "/files/contracts/");
			const res = await answer(replayed);
			expect(res.status).toBe(403);
			expect(res.body).toContain("E_ARCHIVE_INVALID_SIGNATURE");
			expect(res.body).not.toContain("CONTRACT");
		});

		it("is refused there even for a key the signing disk does not hold", async () => {
			await contracts.put("77.pdf", "CONTRACT 77");
			const signed = await invoices.getSignedUrl("77.pdf", { expiresIn: 60 });
			const res = await answer(
				signed.replace("/files/invoices/", "/files/contracts/"),
			);
			expect(res.status).toBe(403);
		});
	});

	describe("an unsigned request", () => {
		it("on a private disk gets one answer, stored or not", async () => {
			await invoices.put("exports/alice@example.com.csv", "rows");
			const stored = await answer(
				"/files/invoices/exports/alice@example.com.csv",
			);
			const absent = await answer(
				"/files/invoices/exports/bob@example.com.csv",
			);
			expect(stored).toEqual(absent);
			expect(stored.status).toBe(403);
			expect(stored.body).toContain("E_ARCHIVE_ACCESS_DENIED");
		});

		it("on a public disk gets the same answer for a private file and an absent one", async () => {
			await shared.put("exports/alice@example.com.csv", "rows", {
				visibility: "private",
			});
			const stored = await answer(
				"/files/public/exports/alice@example.com.csv",
			);
			const absent = await answer("/files/public/exports/bob@example.com.csv");
			expect(stored).toEqual(absent);
			expect(stored.status).toBe(403);
		});

		it("on a public disk still gets a public file", async () => {
			await shared.put("logo.txt", "logo");
			expect(await answer("/files/public/logo.txt")).toEqual({
				status: 200,
				body: "logo",
			});
		});
	});
});
