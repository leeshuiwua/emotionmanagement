import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";

const EnvSchema = z.object({
	NODE_ENV: z
		.enum(["development", "test", "production"])
		.default("development"),
	HOST: z.string().default("127.0.0.1"),
	PORT: z.coerce.number().int().min(1).max(65535).default(3102),
	DATABASE_PATH: z.string().default("./data/guanxinjing.db"),
	PUBLIC_BASE_URL: z.string().url().default("http://localhost:3002"),
	MASTER_KEY: z.string().optional(),
	COOKIE_SECURE: z.enum(["true", "false", "auto", "force"]).default("auto"),
	BOOTSTRAP_ADMIN_USERNAME: z.string().min(3).default("admin"),
	BOOTSTRAP_ADMIN_PASSWORD: z.string().min(12).optional(),
});

export type AppConfig = {
	env: "development" | "test" | "production";
	host: string;
	port: number;
	databasePath: string;
	publicBaseUrl: string;
	masterKey: Buffer;
	cookieSecure: boolean | "auto" | "force";
	bootstrapAdminUsername: string;
	bootstrapAdminPassword?: string;
};

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
	const env = EnvSchema.parse(source);
	const key = env.MASTER_KEY
		? Buffer.from(env.MASTER_KEY, "base64")
		: randomBytes(32);
	if (key.length !== 32)
		throw new Error("MASTER_KEY must decode to exactly 32 bytes");
	if (env.NODE_ENV === "production" && !env.MASTER_KEY) {
		throw new Error("MASTER_KEY is required in production");
	}
	return {
		env: env.NODE_ENV,
		host: env.HOST,
		port: env.PORT,
		databasePath:
			env.DATABASE_PATH === ":memory:"
				? env.DATABASE_PATH
				: resolve(env.DATABASE_PATH),
		publicBaseUrl: env.PUBLIC_BASE_URL.replace(/\/$/, ""),
		masterKey: key,
		cookieSecure:
			env.COOKIE_SECURE === "auto" || env.COOKIE_SECURE === "force"
				? env.COOKIE_SECURE
				: env.COOKIE_SECURE === "true",
		bootstrapAdminUsername: env.BOOTSTRAP_ADMIN_USERNAME,
		bootstrapAdminPassword: env.BOOTSTRAP_ADMIN_PASSWORD,
	};
}
