import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";

export function encryptSecret(value: string, key: Buffer): string {
	const nonce = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, nonce);
	const ciphertext = Buffer.concat([
		cipher.update(value, "utf8"),
		cipher.final(),
	]);
	const tag = cipher.getAuthTag();
	return [
		VERSION,
		nonce.toString("base64url"),
		tag.toString("base64url"),
		ciphertext.toString("base64url"),
	].join(".");
}

export function decryptSecret(payload: string, key: Buffer): string {
	const [version, nonce, tag, ciphertext] = payload.split(".");
	if (version !== VERSION || !nonce || !tag || !ciphertext)
		throw new Error("Invalid encrypted secret");
	const decipher = createDecipheriv(
		"aes-256-gcm",
		key,
		Buffer.from(nonce, "base64url"),
	);
	decipher.setAuthTag(Buffer.from(tag, "base64url"));
	return Buffer.concat([
		decipher.update(Buffer.from(ciphertext, "base64url")),
		decipher.final(),
	]).toString("utf8");
}

export function maskSecret(value?: string | null): string | null {
	if (!value) return null;
	if (value.length <= 8) return "•".repeat(8);
	return `${value.slice(0, 3)}${"•".repeat(8)}${value.slice(-4)}`;
}
