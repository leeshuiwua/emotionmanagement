import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { classifySafety } from "../src/server/core/safety.js";
import { sqliteNativeBindingHint } from "../src/server/db.js";
import {
	decryptSecret,
	encryptSecret,
	maskSecret,
} from "../src/server/security/crypto.js";

describe("secret protection", () => {
	it("encrypts with authenticated encryption and masks output", () => {
		const key = randomBytes(32);
		const encrypted = encryptSecret("sk-sensitive-123456", key);
		expect(encrypted).not.toContain("sensitive");
		expect(decryptSecret(encrypted, key)).toBe("sk-sensitive-123456");
		expect(maskSecret("sk-sensitive-123456")).toBe("sk-••••••••3456");
	});

	it("rejects tampered ciphertext", () => {
		const key = randomBytes(32);
		const encrypted = encryptSecret("secret", key);
		expect(() => decryptSecret(`${encrypted.slice(0, -1)}x`, key)).toThrow();
	});
});

describe("safety routing", () => {
	it("routes imminent language before normal coaching", () => {
		expect(classifySafety("我现在就想死，已经准备好了")).toBe("IMMINENT");
		expect(classifySafety("我最近很绝望")).toBe("CARE");
		expect(classifySafety("今天有点失落")).toBe("NONE");
	});
});

describe("SQLite runtime diagnostics", () => {
	it("turns a missing native binding into an actionable server hint", () => {
		const hint = sqliteNativeBindingHint(
			new Error("Could not locate the bindings file: better_sqlite3.node"),
		);
		expect(hint).toContain("npm ci");
		expect(hint).toContain("npm run build");
		expect(hint).toContain(process.version);
	});

	it("does not replace unrelated database errors", () => {
		expect(sqliteNativeBindingHint(new Error("database is locked"))).toBeNull();
	});
});
