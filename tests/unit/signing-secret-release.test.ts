import { createHmac } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join, resolve } from "node:path";
import { Secret } from "@c9up/ream";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DriveManager, services } from "../../src/DriveManager.js";
import { ArchiveError, LocalDriver } from "../../src/index.js";
import { stubsRoot } from "../../src/stubs.js";

const KEY = "a-signing-key-of-32-bytes-aaaaaa";

/** The `sig` a URL carries, recomputed under `key`. */
function signatureUnder(key: string, url: string): string {
	const parsed = new URL(url, "http://local");
	const filePath = decodeURIComponent(parsed.pathname).replace(
		/^\/[^/]+\//,
		"",
	);
	return createHmac("sha256", key)
		.update(`${filePath}\n${parsed.searchParams.get("exp") ?? ""}`)
		.digest("hex");
}

function sigOf(url: string): string {
	return new URL(url, "http://local").searchParams.get("sig") ?? "";
}

describe("LocalDriver > signingSecret given as a Secret", () => {
	let root: string;

	beforeEach(() => {
		root = fs.mkdtempSync(join(os.tmpdir(), "archive-secret-"));
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("signs with anything that releases a string", () => {
		const driver = new LocalDriver(root, {
			signingSecret: { release: () => KEY },
		});
		const url = driver.getSignedUrl("cat.txt");
		expect(sigOf(url)).toBe(signatureUnder(KEY, url));
	});

	it("signs with the released value of ream's Secret, not its redacted text", () => {
		const driver = new LocalDriver(root, { signingSecret: new Secret(KEY) });
		const url = driver.getSignedUrl("cat.txt");
		expect(sigOf(url)).toBe(signatureUnder(KEY, url));
		expect(sigOf(url)).not.toBe(signatureUnder("[redacted]", url));
		// The handler re-computes the HMAC from this: it must be the key.
		expect(driver.getSigningSecret()).toBe(KEY);
	});

	it("refuses a Secret that wraps an empty or short string", () => {
		for (const weak of [new Secret(""), new Secret("short")]) {
			let thrown: unknown;
			try {
				new LocalDriver(root, { signingSecret: weak });
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toBeInstanceOf(ArchiveError);
			expect(thrown).toMatchObject({ code: "E_ARCHIVE_WEAK_SIGNING_SECRET" });
		}
	});

	it("refuses a Secret that does not release a string", () => {
		// What an untyped (JavaScript) config can hand over: the type guard,
		// not the compiler, is what stands between it and the HMAC key.
		for (const bogus of [
			new Secret(KEY.length),
			{ release: "not-a-function" },
			42,
		]) {
			expect(() =>
				Reflect.construct(LocalDriver, [root, { signingSecret: bogus }]),
			).toThrow(/must be a string or a Secret wrapping one/);
		}
	});

	it("reaches the driver through services.fs", async () => {
		const drive = new DriveManager({
			default: "fs",
			services: {
				fs: services.fs({ location: root, signingSecret: new Secret(KEY) }),
			},
		});
		const url = await drive.use().getSignedUrl("cat.txt");
		expect(sigOf(url)).toBe(signatureUnder(KEY, url));
	});
});

/**
 * Type-check the configure stub as a new app receives it.
 *
 * The files live only in this host, under the package root so `@c9up/ream`
 * and `@c9up/archive` resolve exactly as in an app. `start/env.ts` is the
 * one a new app is scaffolded with: APP_KEY is `Env.schema.secret()`.
 */
function stubDiagnostics(): string[] {
	const pkgRoot = resolve(import.meta.dirname, "..", "..");
	const appRoot = join(pkgRoot, ".stub-app");
	const raw = fs.readFileSync(
		join(stubsRoot, "config", "archive.stub"),
		"utf8",
	);
	const [, front = "", body = ""] = raw.split(/^---\r?\n/m, 3);
	const to = /^to:\s*(.+)$/m.exec(front)?.[1]?.trim() ?? "";
	const configFile = join(appRoot, to);
	const envFile = join(appRoot, "start", "env.ts");
	const files = new Map<string, string>([
		[configFile, body],
		[
			envFile,
			[
				"import { Env } from '@c9up/ream'",
				"export default await Env.create(new URL('../', import.meta.url), {",
				"  APP_KEY: Env.schema.secret(),",
				"})",
			].join("\n"),
		],
	]);
	const options: ts.CompilerOptions = {
		target: ts.ScriptTarget.ES2022,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		strict: true,
		noEmit: true,
		skipLibCheck: true,
		experimentalDecorators: true,
		types: ["node"],
		typeRoots: [join(pkgRoot, "node_modules", "@types")],
		paths: { "#start/env": [envFile] },
	};
	const host = ts.createCompilerHost(options);
	const fileExists = host.fileExists.bind(host);
	const readFile = host.readFile.bind(host);
	const getSourceFile = host.getSourceFile.bind(host);
	host.fileExists = (name) => files.has(name) || fileExists(name);
	host.readFile = (name) => files.get(name) ?? readFile(name);
	host.directoryExists = (name) =>
		name === appRoot || [...files.keys()].some((f) => dirname(f) === name)
			? true
			: ts.sys.directoryExists(name);
	host.getSourceFile = (name, version, onError, create) => {
		const text = files.get(name);
		return text === undefined
			? getSourceFile(name, version, onError, create)
			: ts.createSourceFile(name, text, version);
	};
	const program = ts.createProgram([configFile], options, host);
	const source = program.getSourceFile(configFile);
	if (source === undefined) return ["the rendered stub was not loaded"];
	return [
		...program.getSyntacticDiagnostics(source),
		...program.getSemanticDiagnostics(source),
	].map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

describe("archive > configure stub", () => {
	it("type-checks against an env whose APP_KEY is a Secret", () => {
		expect(stubDiagnostics()).toEqual([]);
	}, 60_000);
});
