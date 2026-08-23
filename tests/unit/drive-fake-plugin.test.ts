/**
 * The `driveFake()` helix plugin (AdonisJS `drive.fake()` parity): registers a
 * `drive` getter that swaps the disk for a FakeStorageManager per test and
 * auto-restores it via `ctx.cleanup`. Verified with a mock drive + mock ctx.
 */

import { createAssert, type TestContext, type TestInstance } from "@c9up/helix";
import { describe, expect, it } from "vitest";
import {
	driveFake,
	FakeStorageManager,
} from "../../src/testing/FakeStorage.js";

const stubInstance: TestInstance = {
	title: "t",
	fullName: "t",
	options: {
		title: "t",
		timeout: 0,
		retries: 0,
		tags: [],
		isTodo: false,
		isFailing: false,
		meta: {},
	},
	isPinned: false,
	resetTimeout: () => {},
	cleanup: () => {},
};

describe("helix plugin > driveFake()", () => {
	it("injects a per-test fake and auto-restores the drive", async () => {
		const fake = new FakeStorageManager();
		let fakeCalls = 0;
		let restoreCalls = 0;
		const drive = {
			fake: () => {
				fakeCalls += 1;
				return fake;
			},
			restore: () => {
				restoreCalls += 1;
			},
		};

		let getter: ((ctx: TestContext) => unknown) | undefined;
		await driveFake(drive)({
			context: {
				macro() {},
				getter(name: string, fn: (ctx: TestContext) => unknown) {
					if (name === "drive") getter = fn;
				},
			},
		});
		expect(getter).toBeDefined();

		const cleanups: Array<() => void | Promise<void>> = [];
		// `drive` is part of the augmented context, so a full TestContext carries
		// one. The getter never reads it — it produces the value that replaces
		// it — but the stub has to be a whole context to be handed to it.
		const ctx: TestContext = {
			drive: new FakeStorageManager(),
			cleanup: (fn) => {
				cleanups.push(fn);
			},
			assert: createAssert(),
			test: stubInstance,
		};

		const injected = getter?.(ctx);
		expect(injected).toBe(fake);
		expect(fakeCalls).toBe(1);
		expect(restoreCalls).toBe(0);

		for (const fn of cleanups) await fn();
		expect(restoreCalls).toBe(1);
	});
});
