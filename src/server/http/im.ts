import { type Request, type Response, Router } from "express";
import QRCode from "qrcode";
import type { AppConfig } from "../config.js";
import { audit, type SqliteDb } from "../db.js";
import { syncChannels } from "../im/index.js";
import {
	listContactProfiles,
	listConversationRecords,
} from "../im/insights.js";
import {
	createChannel,
	deleteChannel,
	getChannel,
	listChannels,
	updateChannel,
} from "../im/store.js";
import {
	getWechatLoginState,
	startWechatLogin,
	stopWechatLogin,
	submitWechatVerifyCode,
} from "../im/wechat.js";
import { requireAdmin } from "./auth.js";

const loginLimiter = (await import("express-rate-limit")).default({
	windowMs: 60_000,
	max: 3,
	standardHeaders: true,
	legacyHeaders: false,
	skip: (req) => req.app.get("env") === "test",
	message: {
		error: { code: "RATE_LIMITED", message: "扫码请求过于频繁，请稍后再试" },
	},
});

export function createImRouter(db: SqliteDb, config: AppConfig): Router {
	const router = Router();

	function conversationFilters(req: Request) {
		const from =
			typeof req.query.from === "string" ? req.query.from : undefined;
		const to = typeof req.query.to === "string" ? req.query.to : undefined;
		return {
			from: from
				? from.length === 10
					? `${from}T00:00:00.000Z`
					: from
				: undefined,
			to: to ? (to.length === 10 ? `${to}T23:59:59.999Z` : to) : undefined,
			channelId:
				typeof req.query.channelId === "string"
					? req.query.channelId
					: undefined,
			contactId:
				typeof req.query.contactId === "string"
					? req.query.contactId
					: undefined,
		};
	}

	router.get("/conversations", requireAdmin(db), (req, res) => {
		const page = Math.max(
			1,
			Number.parseInt(String(req.query.page ?? "1"), 10) || 1,
		);
		const pageSize = Math.min(
			100,
			Math.max(
				1,
				Number.parseInt(String(req.query.pageSize ?? "20"), 10) || 20,
			),
		);
		res.json(
			listConversationRecords(db, conversationFilters(req), page, pageSize),
		);
	});

	router.get("/profiles", requireAdmin(db), (req, res) => {
		res.json({ profiles: listContactProfiles(db, conversationFilters(req)) });
	});

	/* ------------------------- IM 渠道 CRUD ------------------------- */

	router.get("/channels", requireAdmin(db), (_req, res) => {
		res.json({ channels: listChannels(db) });
	});

	router.post("/channels", requireAdmin(db, true), (req, res) => {
		const { type, name, enabled, config: channelConfig } = req.body || {};
		if (type !== "wechat") {
			res.status(400).json({ error: { message: "invalid channel type" } });
			return;
		}
		try {
			const channel = createChannel(db, {
				type: "wechat",
				name,
				enabled: !!enabled,
				config: channelConfig || {},
			});
			audit(db, {
				actorType: "ADMIN",
				actorId: req.adminSession?.adminId,
				action: "IM_CHANNEL_CREATED",
				resourceType: "IM_CHANNEL",
				resourceId: channel.id,
				detail: { name: channel.name },
			});
			syncChannels(db, config);
			res.status(201).json({ channel });
		} catch (e) {
			res.status(400).json({
				error: { message: e instanceof Error ? e.message : String(e) },
			});
		}
	});

	router.put("/channels/:id", requireAdmin(db, true), (req, res) => {
		const { name, enabled, config: channelConfig } = req.body || {};
		try {
			const channel = updateChannel(db, String(req.params.id), {
				name,
				enabled,
				config: channelConfig,
			});
			if (!channel) {
				res.status(404).json({ error: { message: "not found" } });
				return;
			}
			audit(db, {
				actorType: "ADMIN",
				actorId: req.adminSession?.adminId,
				action: "IM_CHANNEL_UPDATED",
				resourceType: "IM_CHANNEL",
				resourceId: channel.id,
			});
			syncChannels(db, config);
			res.json({ channel });
		} catch (e) {
			res.status(400).json({
				error: { message: e instanceof Error ? e.message : String(e) },
			});
		}
	});

	router.delete("/channels/:id", requireAdmin(db, true), (req, res) => {
		const id = String(req.params.id);
		const ch = getChannel(db, id);
		if (ch) {
			audit(db, {
				actorType: "ADMIN",
				actorId: req.adminSession?.adminId,
				action: "IM_CHANNEL_DELETED",
				resourceType: "IM_CHANNEL",
				resourceId: ch.id,
			});
		}
		deleteChannel(db, id);
		stopWechatLogin(id);
		syncChannels(db, config);
		res.json({ ok: true });
	});

	router.post("/channels/:id/test", requireAdmin(db), async (req, res) => {
		const ch = getChannel(db, String(req.params.id));
		if (!ch) {
			res.status(404).json({ error: { message: "not found" } });
			return;
		}
		try {
			const { createWechatPersonalAdapter } = await import("../im/wechat.js");
			if (!ch.config.token) {
				res.status(400).json({ error: { message: "请先扫码登录" } });
				return;
			}
			const adapter = createWechatPersonalAdapter(
				{
					token: ch.config.token,
					baseUrl: ch.config.baseUrl,
					cursor: ch.cursor,
				},
				{ log: () => undefined },
			);
			const result = await adapter.test();
			res.json(result);
		} catch (e) {
			res.status(400).json({
				error: { message: e instanceof Error ? e.message : String(e) },
			});
		}
	});

	/* ------------------------- 微信扫码登录 ------------------------- */

	function wechatChannelOr404(req: Request, res: Response) {
		const ch = getChannel(db, String(req.params.id));
		if (ch?.type !== "wechat") {
			res.status(404).json({ error: { message: "wechat channel not found" } });
			return null;
		}
		return ch;
	}

	router.post(
		"/channels/:id/wechat/login",
		requireAdmin(db, true),
		loginLimiter,
		async (req, res) => {
			const ch = wechatChannelOr404(req, res);
			if (!ch) return;
			const localTokenList = listChannels(db)
				.filter((c) => c.type === "wechat" && c.id !== ch.id && c.config.token)
				.map((c) => c.config.token as string);
			try {
				const state = await startWechatLogin({
					channelId: ch.id,
					localTokenList,
					onSave: (creds) => {
						// 扫码确认后：落库凭据并自动启用，立即开始收发
						updateChannel(db, ch.id, {
							enabled: true,
							config: {
								token: creds.token,
								baseUrl: creds.baseUrl,
								userId: creds.userId,
								botId: creds.botId,
							},
						});
						syncChannels(db, config);
						audit(db, {
							actorType: "ADMIN",
							actorId: req.adminSession?.adminId,
							action: "WECHAT_LOGIN_CONFIRMED",
							resourceType: "IM_CHANNEL",
							resourceId: ch.id,
							detail: { userId: creds.userId, botId: creds.botId },
						});
					},
				});
				// qrcodeUrl 是链接，需编码为二维码图片供手机扫描
				let qrDataUrl: string | null = null;
				if (state.qrcodeUrl) {
					qrDataUrl = await QRCode.toDataURL(state.qrcodeUrl, {
						margin: 1,
						width: 220,
					});
				}
				res.json({ ...state, qrDataUrl });
			} catch (e) {
				res.status(502).json({
					error: {
						message: e instanceof Error ? e.message : "扫码登录启动失败",
					},
				});
			}
		},
	);

	router.get("/channels/:id/wechat/login", requireAdmin(db), (req, res) => {
		const ch = wechatChannelOr404(req, res);
		if (!ch) return;
		const state = getWechatLoginState(ch.id);
		if (!state) {
			res.status(404).json({ error: { message: "no active login" } });
			return;
		}
		res.json(state);
	});

	router.post(
		"/channels/:id/wechat/login/verify",
		requireAdmin(db, true),
		(req, res) => {
			const ch = wechatChannelOr404(req, res);
			if (!ch) return;
			const code = String(req.body?.code || "").trim();
			if (!code) {
				res.status(400).json({ error: { message: "code required" } });
				return;
			}
			const ok = submitWechatVerifyCode(ch.id, code);
			if (!ok) {
				res.status(404).json({ error: { message: "no active login" } });
				return;
			}
			res.json({ ok: true });
		},
	);

	router.delete(
		"/channels/:id/wechat/login",
		requireAdmin(db, true),
		(req, res) => {
			const ch = wechatChannelOr404(req, res);
			if (!ch) return;
			stopWechatLogin(ch.id);
			res.json({ ok: true });
		},
	);

	return router;
}
