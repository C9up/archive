import { generateKeyPairSync } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { Ignitor } from "@c9up/ream";
import { createHyperServerFactory } from "@c9up/ream/bootstrap";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	DriveManager,
	GcsDriver,
	LocalDriver,
	S3Driver,
	StorageManager,
	services,
} from "../../src/index.js";
import { createSignedRouteHandler } from "../../src/signed-route.js";

const SECRET = "app-key-0123456789abcdef0123456789";

describe("archive > a streamed write keeps visibility: 'private' on the local disk", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "archive-stream-root-"));
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "archive-stream-tmp-"));
	const driver = new LocalDriver(root, { signingSecret: SECRET });
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
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	const assertPrivate = async (key: string, body: string) => {
		expect(await disk.getVisibility(key)).toBe("private");
		const url = await disk.getUrl(key);
		expect(url).toMatch(/\?exp=\d+&sig=[a-f0-9]{64}$/);
		expect((await fetch(`${base}/storage/${key}`)).status).toBe(403);
		const signed = await fetch(`${base}${url}`);
		expect(signed.status).toBe(200);
		expect(await signed.text()).toBe(body);
	};

	it("copyFromFs and moveFromFs store the file private", async () => {
		const a = path.join(tmp, "a");
		const b = path.join(tmp, "b");
		fs.writeFileSync(a, "SECRET INVOICE 42");
		fs.writeFileSync(b, "SECRET PAYSLIP 7");
		await disk.copyFromFs(a, "invoices/42.pdf", { visibility: "private" });
		await disk.moveFromFs(b, "payslips/7.pdf", { visibility: "private" });

		await assertPrivate("invoices/42.pdf", "SECRET INVOICE 42");
		await assertPrivate("payslips/7.pdf", "SECRET PAYSLIP 7");
		expect(fs.existsSync(b)).toBe(false);
	});

	it("putStream takes the visibility as put() does", async () => {
		await disk.putStream(
			"contracts/9.pdf",
			Readable.from([Buffer.from("SECRET CONTRACT 9")]),
			{ contentType: "application/pdf", visibility: "private" },
		);
		await assertPrivate("contracts/9.pdf", "SECRET CONTRACT 9");
	});

	it("leaves nothing behind when a private stream fails half-way", async () => {
		const failing = new Readable({
			read() {
				this.push(Buffer.from("half of a secret"));
				this.destroy(new Error("client went away"));
			},
		});
		await expect(
			disk.putStream("broken.pdf", failing, { visibility: "private" }),
		).rejects.toThrow();
		expect(fs.existsSync(path.join(root, "broken.pdf"))).toBe(false);
		expect(
			fs.existsSync(path.join(root, "broken.pdf.archive-visibility.json")),
		).toBe(false);
	});

	it("marks a public stream public after its bytes", async () => {
		await disk.put("doc.txt", "old", { visibility: "private" });
		await disk.putStream("doc.txt", Readable.from(["new"]), {
			visibility: "public",
		});
		expect(await disk.getVisibility("doc.txt")).toBe("public");
		const res = await fetch(`${base}/storage/doc.txt`);
		expect(await res.text()).toBe("new");
	});
});

describe("archive > a private disk", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "archive-private-disk-"));
	const driver = new LocalDriver(root, {
		signingSecret: SECRET,
		visibility: "private",
	});
	const disk = new StorageManager(driver);

	afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

	it("makes a write without options private, and signs its URL", async () => {
		await disk.put("a.txt", "a");
		await disk.putStream("b.txt", Readable.from(["b"]));
		for (const key of ["a.txt", "b.txt"]) {
			expect(await disk.getVisibility(key)).toBe("private");
			expect(await disk.getUrl(key)).toMatch(/\?exp=\d+&sig=/);
			// A marker beside the file, so a static server over the root and
			// a disk later switched to public still see it as private.
			expect(
				fs.readFileSync(
					path.join(root, `${key}.archive-visibility.json`),
					"utf8",
				),
			).toBe('{"visibility":"private"}');
		}
	});

	it("keeps an object private whatever a write or setVisibility asks for", async () => {
		await disk.put("c.txt", "c", { visibility: "public" });
		expect(await disk.getVisibility("c.txt")).toBe("private");
		await disk.setVisibility("c.txt", "public");
		expect(await disk.getVisibility("c.txt")).toBe("private");
		await disk.copy("c.txt", "d.txt", { visibility: "public" });
		await disk.move("d.txt", "e.txt", { visibility: "public" });
		expect(await disk.getVisibility("e.txt")).toBe("private");
		expect((await disk.getMetadata("e.txt")).visibility).toBe("private");
	});

	it("answers private for a file that predates the option (no marker)", async () => {
		fs.writeFileSync(path.join(root, "old.txt"), "old");
		expect(await disk.getVisibility("old.txt")).toBe("private");
	});

	it("reports its visibility to the signed route", () => {
		expect(driver.getDiskVisibility()).toBe("private");
		expect(new LocalDriver(root).getDiskVisibility()).toBe("public");
	});

	it("comes from services.fs", () => {
		const drive = new DriveManager({
			default: "fs",
			services: {
				fs: services.fs({ location: root, visibility: "private" }),
			},
		});
		return expect(
			drive
				.use()
				.put("f.txt", "f")
				.then(() => drive.use().getVisibility("f.txt")),
		).resolves.toBe("private");
	});

	it("refuses a visibility that is neither value, rather than defaulting", () => {
		const options: { visibility?: "public" | "private" } = JSON.parse(
			'{"visibility":"Private"}',
		);
		expect(() => new LocalDriver(root, options)).toThrow(
			expect.objectContaining({ code: "E_ARCHIVE_INVALID_DRIVER_CONFIG" }),
		);
	});
});

describe("archive > a streamed write sends its visibility to the cloud", () => {
	afterEach(() => vi.restoreAllMocks());

	const s3 = () =>
		new S3Driver({
			bucket: "my-bucket",
			region: "us-east-1",
			accessKeyId: "AKIATEST",
			secretAccessKey: "secret",
		});

	it("S3 signs the ACL on the single PUT", async () => {
		const spy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response("", { status: 200 }))
			.mockRejectedValue(new Error("unmocked network call"));
		await s3().putStream("a.txt", Readable.from([Buffer.from("x")]), {
			contentLength: 1,
			visibility: "private",
		});
		const headers = spy.mock.calls[0]?.[1]?.headers;
		expect(headers).toMatchObject({ "x-amz-acl": "private" });
		expect(JSON.stringify(headers)).toMatch(/SignedHeaders=[^,]*x-amz-acl/);
	});

	it("S3 sets the ACL when a multipart upload is initiated", async () => {
		const spy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				new Response(
					"<InitiateMultipartUploadResult><UploadId>u1</UploadId></InitiateMultipartUploadResult>",
					{ status: 200 },
				),
			)
			.mockResolvedValueOnce(
				new Response("", { status: 200, headers: { etag: '"e1"' } }),
			)
			.mockResolvedValueOnce(
				new Response("<CompleteMultipartUploadResult/>", { status: 200 }),
			)
			.mockRejectedValue(new Error("unmocked network call"));
		await s3().putStream("a.txt", Readable.from([Buffer.from("x")]), {
			visibility: "public",
		});
		expect(String(spy.mock.calls[0]?.[0])).toContain("?uploads");
		expect(spy.mock.calls[0]?.[1]?.headers).toMatchObject({
			"x-amz-acl": "public-read",
		});
	});

	it("S3 keeps it for an empty stream", async () => {
		const spy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response("", { status: 200 }))
			.mockRejectedValue(new Error("unmocked network call"));
		await s3().putStream("empty.txt", Readable.from([]), {
			visibility: "private",
		});
		expect(spy.mock.calls[0]?.[1]?.headers).toMatchObject({
			"x-amz-acl": "private",
		});
	});

	it("GCS applies it after the upload, as put() does", async () => {
		const { privateKey } = generateKeyPairSync("rsa", {
			modulusLength: 2048,
			publicKeyEncoding: { type: "spki", format: "pem" },
			privateKeyEncoding: { type: "pkcs8", format: "pem" },
		});
		const driver = new GcsDriver({
			bucket: "my-bucket",
			serviceAccount: {
				client_email: "test@test.iam.gserviceaccount.com",
				private_key: privateKey,
			},
		});
		const spy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), {
					status: 200,
				}),
			)
			.mockResolvedValueOnce(new Response("{}", { status: 200 }))
			.mockResolvedValueOnce(new Response("{}", { status: 200 }))
			.mockRejectedValue(new Error("unmocked network call"));
		await driver.putStream("a.txt", Readable.from([Buffer.from("x")]), {
			contentLength: 1,
			visibility: "public",
		});
		const [url, init] = spy.mock.calls[2] ?? [];
		expect(String(url)).toContain("/o/a.txt/acl");
		expect(init?.method).toBe("POST");
		expect(String(init?.body)).toContain("allUsers");
	});
});
