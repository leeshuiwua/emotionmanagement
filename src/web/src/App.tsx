import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	type FormEvent,
	type ReactNode,
	useEffect,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
	api,
	type ContactProfile,
	type ImChannel,
	imApi,
	setCsrfToken,
	type WechatLoginState,
} from "./api";

type Session = { user: { username: string }; csrfToken: string };
type Setting = {
	id: string;
	status: "DRAFT" | "TESTED" | "ACTIVE" | "RETIRED";
	config: Record<string, string>;
	secretMasked?: string | null;
	secretFields?: Record<string, string> | null;
	testMessage?: string;
};
type Status = {
	service: string;
	database: string;
	metrics: { users: number; conversations7d: number; activeChannels: number };
	settings: Array<{ kind: string; role: string; status: string }>;
};

const navigation = [
	["dashboard", "/admin/", "◫"],
	["wechat", "/admin/wechat", "◉"],
	["dialogueInsights", "/admin/conversations", "≈"],
	["models", "/admin/models", "✦"],
	["audit", "/admin/audit", "≡"],
] as const;

function usePath() {
	const [path, setPath] = useState(location.pathname);
	useEffect(() => {
		const update = () => setPath(location.pathname);
		addEventListener("popstate", update);
		return () => removeEventListener("popstate", update);
	}, []);
	const navigate = (next: string) => {
		history.pushState({}, "", next);
		setPath(next);
	};
	return [path, navigate] as const;
}

function Login({ onLogin }: { onLogin: (session: Session) => void }) {
	const { t, i18n } = useTranslation();
	const [username, setUsername] = useState("admin");
	const [password, setPassword] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError("");
		try {
			const session = await api<Session>("/auth/login", {
				method: "POST",
				body: JSON.stringify({ username, password }),
			});
			setCsrfToken(session.csrfToken);
			onLogin(session);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : t("error"));
		} finally {
			setBusy(false);
		}
	};
	return (
		<main className="login-shell">
			<div className="grid-glow" />
			<button
				type="button"
				className="language-switch login-language"
				onClick={() => {
					const next = i18n.language === "zh" ? "en" : "zh";
					void i18n.changeLanguage(next);
					localStorage.setItem("gxj-language", next);
				}}
			>
				{i18n.language === "zh" ? "EN" : "中文"}
			</button>
			<section className="login-copy">
				<Brand />
				<p className="eyebrow">· AWARENESS CONSOLE</p>
				<h1>{t("loginTitle")}</h1>
				<p>{t("subtitle")}</p>
				<blockquote>“知汝州之岑，不在汝州之外。”</blockquote>
			</section>
			<form className="login-card" onSubmit={submit}>
				<span className="card-number">01 / AUTH</span>
				<label>
					{t("username")}
					<input
						autoComplete="username"
						value={username}
						onChange={(event) => setUsername(event.target.value)}
					/>
				</label>
				<label>
					{t("password")}
					<input
						type="password"
						autoComplete="current-password"
						value={password}
						onChange={(event) => setPassword(event.target.value)}
					/>
				</label>
				{error && <p className="form-error">{error}</p>}
				<button type="submit" className="primary-button" disabled={busy}>
					{busy ? t("loading") : t("login")} →
				</button>
				<div className="privacy-note">
					<span className="pulse-dot" />
					本地 SQLite 安全存储
				</div>
			</form>
		</main>
	);
}

function Brand() {
	const { t } = useTranslation();
	return (
		<div className="brand">
			<span className="brand-mark">◌</span>
			<span>{t("brand")}</span>
			<small>{t("console")}</small>
		</div>
	);
}

function Shell({
	session,
	onLogout,
}: {
	session: Session;
	onLogout: () => void;
}) {
	const { t, i18n } = useTranslation();
	const [path, navigate] = usePath();
	const changeLanguage = () => {
		const next = i18n.language === "zh" ? "en" : "zh";
		void i18n.changeLanguage(next);
		localStorage.setItem("gxj-language", next);
	};
	const current = navigation.find(([, href]) =>
		href === "/admin/" ? path === href : path.startsWith(href),
	);
	return (
		<div className="app-shell">
			<aside className="sidebar">
				<div className="sidebar-brand">
					<Brand />
				</div>
				<nav className="side-navigation">
					{navigation.map(([key, href, glyph]) => (
						<button
							type="button"
							className={
								path === href || (href !== "/admin/" && path.startsWith(href))
									? "active"
									: ""
							}
							key={key}
							onClick={() => navigate(href)}
						>
							<span aria-hidden="true">{glyph}</span>
							{t(key)}
						</button>
					))}
				</nav>
				<div className="sidebar-foot">
					<button
						type="button"
						className="language-switch"
						onClick={changeLanguage}
					>
						{i18n.language === "zh" ? "EN" : "中文"}
					</button>
					<div className="sidebar-user">
						<span>{session.user.username.slice(0, 1).toUpperCase()}</span>
						<div>
							<strong>{session.user.username}</strong>
							<button type="button" onClick={onLogout}>
								{t("logout")}
							</button>
						</div>
					</div>
				</div>
			</aside>
			<main className="workspace">
				<header className="workspace-header">
					<div>
						<span className="workspace-kicker">GUAN XIN JING</span>
						<strong>{current ? t(current[0]) : t("dashboard")}</strong>
					</div>
					<span className="service-online">
						<i /> {t("healthy")}
					</span>
				</header>
				<div className="content">
					{path === "/admin/wechat" ? (
						<WechatPersonalPage />
					) : path === "/admin/conversations" ? (
						<ConversationInsightsPage />
					) : path === "/admin/models" ? (
						<ModelsPage />
					) : path === "/admin/audit" ? (
						<AuditPage />
					) : (
						<Dashboard />
					)}
				</div>
				<footer>
					{t("signature")} <span className="footer-rule" />{" "}
					{new Date().getFullYear()}
				</footer>
			</main>
			<img
				className="buddha-mark"
				src="/admin/brand/buddha-logo-gold.png"
				alt=""
			/>
		</div>
	);
}

function PageIntro({
	index,
	title,
	children,
}: {
	index: string;
	title: string;
	children: ReactNode;
}) {
	return (
		<div className="page-intro">
			<span className="eyebrow">{index} / GUAN XIN JING</span>
			<h1>{title}</h1>
			<p>{children}</p>
		</div>
	);
}

function Dashboard() {
	const { t } = useTranslation();
	const { data, isLoading, error } = useQuery({
		queryKey: ["status"],
		queryFn: () => api<Status>("/system/status"),
		refetchInterval: 30_000,
	});
	return (
		<>
			<PageIntro index="01" title={t("title")}>
				{t("subtitle")}
			</PageIntro>
			{error ? (
				<Notice tone="error">{error.message}</Notice>
			) : (
				<section className="dashboard-grid">
					<article className="hero-status">
						<span className="live-pill">
							<i /> LIVE
						</span>
						<div>
							<p>{t("healthy")}</p>
							<h2>{t("ready")}</h2>
						</div>
						<span className="status-time">
							{isLoading ? "…" : new Date().toLocaleTimeString()}
						</span>
					</article>
					<article className="metric">
						<span>02</span>
						<p>{t("users")}</p>
						<strong>{data?.metrics.users ?? "—"}</strong>
					</article>
					<article className="metric">
						<span>03</span>
						<p>{t("conversations")}</p>
						<strong>{data?.metrics.conversations7d ?? "—"}</strong>
					</article>
					<article className="metric">
						<span>04</span>
						<p>{t("activeChannels")}</p>
						<strong>{data?.metrics.activeChannels ?? "—"}</strong>
					</article>
					<article className="database-strip">
						<div>
							<span className="pulse-dot" />
							{t("database")}
						</div>
						<strong>{t("connected")}</strong>
						<code>SQLite · WAL</code>
					</article>
				</section>
			)}
		</>
	);
}

function StatusBadge({ status }: { status?: string }) {
	const { t } = useTranslation();
	return (
		<span className={`status-badge status-${status?.toLowerCase() ?? "none"}`}>
			{status ?? t("notConfigured")}
		</span>
	);
}
function Notice({
	children,
	tone = "success",
}: {
	children: ReactNode;
	tone?: "success" | "error";
}) {
	return <div className={`notice ${tone}`}>{children}</div>;
}

/* ------------------------- 微信渠道管理 ------------------------- */

function WechatPersonalPage() {
	const { t } = useTranslation();
	const client = useQueryClient();
	const channelsQuery = useQuery({
		queryKey: ["im", "channels"],
		queryFn: () => imApi.listChannels(),
		refetchInterval: 10_000,
	});
	const channels = channelsQuery.data?.channels ?? [];
	const [loginChannel, setLoginChannel] = useState<ImChannel | null>(null);
	const [addChannelOpen, setAddChannelOpen] = useState(false);
	const [message, setMessage] = useState("");
	const [error, setError] = useState("");

	const refresh = () =>
		client.invalidateQueries({ queryKey: ["im", "channels"] });

	const addChannel = async (name: string) => {
		setError("");
		await imApi.createChannel({ type: "wechat", name });
		setAddChannelOpen(false);
		setMessage(t("channelCreated"));
		await refresh();
	};

	const toggleEnabled = async (channel: ImChannel) => {
		setError("");
		try {
			await imApi.updateChannel(channel.id, { enabled: !channel.enabled });
			await refresh();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : t("error"));
		}
	};

	const logout = async (channel: ImChannel) => {
		if (!window.confirm(t("logoutWechatConfirm"))) return;
		setError("");
		try {
			// 清除凭据并停用渠道
			await imApi.updateChannel(channel.id, {
				enabled: false,
				config: { token: "", baseUrl: "", userId: "", botId: "" },
			});
			setMessage(t("wechatLoggedOut"));
			await refresh();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : t("error"));
		}
	};

	const removeChannel = async (channel: ImChannel) => {
		if (!window.confirm(t("deleteChannelConfirm"))) return;
		setError("");
		try {
			await imApi.deleteChannel(channel.id);
			setMessage(t("channelDeleted"));
			await refresh();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : t("error"));
		}
	};

	const testChannel = async (channel: ImChannel) => {
		setError("");
		try {
			await imApi.testChannel(channel.id);
			setMessage(t("testOk"));
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : t("error"));
		}
	};

	return (
		<>
			<PageIntro index="02" title={t("wechatChannels")}>
				{t("wechatChannelDescription")}
			</PageIntro>
			<section className="channel-panel">
				<div className="channel-panel-head">
					<div>
						<h2>{t("imChannels")}</h2>
						<p>{t("imChannelHelp")}</p>
					</div>
					<span>{channels.length} CHANNEL</span>
				</div>
				{channels.length === 0 ? (
					<div className="channel-empty">
						<span>微信</span>
						<p>{t("noWechatChannel")}</p>
					</div>
				) : (
					channels.map((channel) => {
						const connected = Boolean(channel.config.token);
						return (
							<div
								key={channel.id}
								className={`channel-row ${channel.enabled ? "enabled" : ""}`}
							>
								<div className="wechat-channel-icon" aria-hidden="true">
									◌
								</div>
								<div className="channel-identity">
									<strong>{channel.name}</strong>
									<span>
										{t("wechatPersonalShort")} ·{" "}
										{connected
											? channel.config.userId || t("loggedIn")
											: t("notLoggedIn")}
									</span>
								</div>
								<div
									className={`channel-state state-${connected ? "connected" : "offline"}`}
								>
									<i />{" "}
									{connected
										? channel.enabled
											? t("enabled")
											: t("disabled")
										: t("notLoggedIn")}
								</div>
								<button
									type="button"
									className="scan-button"
									onClick={() => setLoginChannel(channel)}
								>
									<span aria-hidden="true">▦</span>
									{connected ? t("scanToLogin") : t("scanToLogin")}
								</button>
								<button
									type="button"
									role="switch"
									aria-checked={channel.enabled}
									className={`toggle ${channel.enabled ? "on" : ""}`}
									disabled={!connected}
									onClick={() => void toggleEnabled(channel)}
									aria-label={t("toggleEnabled")}
								>
									<span />
								</button>
								<div className="channel-actions">
									<button
										type="button"
										className="row-action"
										onClick={() => void testChannel(channel)}
										disabled={!connected}
									>
										{t("testConnection")}
									</button>
									<button
										type="button"
										className="row-action danger"
										onClick={() => void logout(channel)}
										disabled={!connected}
									>
										{t("logoutWechat")}
									</button>
									<button
										type="button"
										className="row-action danger"
										onClick={() => void removeChannel(channel)}
									>
										{t("deleteChannel")}
									</button>
								</div>
							</div>
						);
					})
				)}
				<button
					type="button"
					className="add-channel-button"
					onClick={() => setAddChannelOpen(true)}
				>
					+ {t("addChannel")}
				</button>
			</section>

			<section className="personal-session-panel">
				<div className="session-orbit" aria-hidden="true">
					<span
						className={
							channels.some((c) => c.enabled && c.config.token)
								? "connected"
								: ""
						}
					>
						微信
					</span>
					<i />
					<strong>观心镜</strong>
				</div>
				<div className="session-copy">
					<span className="eyebrow">PERSONAL WECHAT · LOCAL SESSION</span>
					<h2>{t("personalSessionTitle")}</h2>
					<p>{t("personalSessionHelp")}</p>
					<dl>
						<div>
							<dt>{t("loginAccount")}</dt>
							<dd>
								{channels.find((c) => c.config.token)?.config.userId || "—"}
							</dd>
						</div>
						<div>
							<dt>{t("sessionStorage")}</dt>
							<dd>{t("localOnly")}</dd>
						</div>
						<div>
							<dt>{t("messageScope")}</dt>
							<dd>{t("privateTextOnly")}</dd>
						</div>
					</dl>
					<div className="risk-note">{t("personalWechatRisk")}</div>
					{message && <Notice>{message}</Notice>}
					{error && <Notice tone="error">{error}</Notice>}
				</div>
			</section>

			{loginChannel && (
				<WechatLoginModal
					channel={loginChannel}
					onClose={() => setLoginChannel(null)}
					onConfirmed={async () => {
						setLoginChannel(null);
						setMessage(t("wechatConnected"));
						await refresh();
					}}
				/>
			)}
			{addChannelOpen && (
				<AddChannelModal
					initialName="我的微信"
					onClose={() => setAddChannelOpen(false)}
					onSave={addChannel}
				/>
			)}
		</>
	);
}

function AddChannelModal({
	initialName,
	onClose,
	onSave,
}: {
	initialName: string;
	onClose: () => void;
	onSave: (name: string) => Promise<void>;
}) {
	const { t } = useTranslation();
	const [name, setName] = useState(initialName);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (!name.trim()) {
			setError(t("channelNameRequired"));
			return;
		}
		setBusy(true);
		setError("");
		try {
			await onSave(name.trim());
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : t("error"));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="modal-backdrop">
			<form
				className="add-channel-modal"
				role="dialog"
				aria-modal="true"
				aria-labelledby="add-channel-title"
				onSubmit={submit}
			>
				<div className="add-channel-titlebar">
					<h2 id="add-channel-title">{t("addChannel")}</h2>
					<button type="button" aria-label={t("close")} onClick={onClose}>
						×
					</button>
				</div>
				<div className="add-channel-fields">
					<label>
						{t("channelType")}
						<select defaultValue="wechat">
							<option value="wechat">{t("wechatPersonalChannel")}</option>
						</select>
					</label>
					<label>
						{t("name")}
						<input
							value={name}
							placeholder={t("channelNamePlaceholder")}
							onChange={(event) => setName(event.target.value)}
						/>
					</label>
					<div className="channel-guidance">{t("personalChannelGuidance")}</div>
					{error && <Notice tone="error">{error}</Notice>}
				</div>
				<div className="add-channel-actions">
					<button type="button" className="cancel-button" onClick={onClose}>
						{t("cancel")}
					</button>
					<button type="submit" className="primary-button" disabled={busy}>
						<span>✓</span>
						{busy ? t("loading") : t("save")}
					</button>
				</div>
			</form>
		</div>
	);
}

/* ------------------------- 微信扫码登录弹窗 ------------------------- */

function WechatLoginModal({
	channel,
	onClose,
	onConfirmed,
}: {
	channel: ImChannel;
	onClose: () => void;
	onConfirmed: () => void;
}) {
	const { t } = useTranslation();
	const [state, setState] = useState<WechatLoginState | null>(null);
	const [code, setCode] = useState("");
	const [cancelling, setCancelling] = useState(false);
	const [error, setError] = useState("");
	const doneRef = useRef(false);
	const channelId = channel.id;

	// biome-ignore lint/correctness/useExhaustiveDependencies: 仅在 channelId 变化时启动扫码，避免重复请求
	useEffect(() => {
		if (!channelId) return;
		let cancelled = false;
		setError("");
		imApi
			.startWechatLogin(channelId)
			.then((s) => {
				if (!cancelled) setState(s);
			})
			.catch((e) => {
				if (!cancelled) setError(e instanceof Error ? e.message : t("error"));
			});

		const timer = window.setInterval(async () => {
			if (doneRef.current || cancelled) return;
			try {
				const s = await imApi.wechatLoginState(channelId);
				if (cancelled) return;
				setState((prev) => ({
					...s,
					qrDataUrl: s.qrDataUrl ?? prev?.qrDataUrl ?? null,
				}));
				if (
					["confirmed", "failed", "timeout", "already_connected"].includes(
						s.status,
					)
				) {
					doneRef.current = true;
					window.clearInterval(timer);
					if (s.status === "confirmed") setTimeout(onConfirmed, 600);
				}
			} catch {
				// 登录会话不存在（超时/未开始）→ 停止轮询
				doneRef.current = true;
				window.clearInterval(timer);
			}
		}, 1500);

		return () => {
			cancelled = true;
			window.clearInterval(timer);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [channelId]);

	const statusText =
		state?.status === "need_verifycode"
			? t("loginStatusNeedVerifycode")
			: state
				? t(`loginStatus${capitalize(state.status)}` as never)
				: t("startingLogin");

	const cancel = async () => {
		setCancelling(true);
		try {
			doneRef.current = true;
			await imApi.cancelWechatLogin(channelId);
		} catch {
			// 忽略
		}
		onClose();
	};

	const submitCode = async () => {
		const c = code.trim();
		if (!c) return;
		try {
			await imApi.submitWechatVerifyCode(channelId, c);
			setCode("");
			setState((prev) => (prev ? { ...prev, status: "scanned" } : prev));
		} catch (e) {
			setError(e instanceof Error ? e.message : t("error"));
		}
	};

	return (
		<div className="modal-backdrop">
			<section
				className="qr-modal"
				role="dialog"
				aria-modal="true"
				aria-labelledby="qr-title"
			>
				<button
					type="button"
					className="modal-close"
					aria-label={t("close")}
					onClick={onClose}
				>
					×
				</button>
				<span className="eyebrow">PERSONAL WECHAT LOGIN</span>
				<h2 id="qr-title">{t("scanQrTitle")}</h2>
				{error && <Notice tone="error">{error}</Notice>}
				{state?.qrDataUrl ? (
					<div className="qr-frame">
						<img src={state.qrDataUrl} alt={t("scanQrTitle")} />
					</div>
				) : (
					<div className="qr-frame qr-loading">
						<span>◌</span>
					</div>
				)}
				<p>{statusText}</p>
				{state?.error && <p className="qr-error">{state.error}</p>}
				{state?.status === "need_verifycode" && (
					<div className="verify-row">
						<input
							aria-label={t("verifyPrompt")}
							className="verify-input"
							value={code}
							inputMode="numeric"
							placeholder={t("verifyCodePlaceholder")}
							onChange={(e) =>
								setCode(e.target.value.replace(/\D/g, "").slice(0, 8))
							}
							onKeyDown={(e) => e.key === "Enter" && void submitCode()}
						/>
						<button
							type="button"
							className="primary-button compact"
							onClick={() => void submitCode()}
							disabled={!code.trim()}
						>
							{t("verifySubmit")}
						</button>
					</div>
				)}
				<button
					type="button"
					className="qr-cancel"
					disabled={cancelling}
					onClick={() => void cancel()}
				>
					{t("loginCancel")}
				</button>
			</section>
		</div>
	);
}

function capitalize(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}

/* ------------------------- 对话记录与心理画像 ------------------------- */

function localDate(daysAgo = 0) {
	const date = new Date();
	date.setDate(date.getDate() - daysAgo);
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function localRangeIso(date: string, endOfDay = false) {
	return new Date(
		`${date}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}`,
	).toISOString();
}

function EmotionSparkline({ profile }: { profile: ContactProfile }) {
	const points = profile.emotion.trend.slice(-14);
	if (!points.length)
		return <div className="sparkline-empty">暂无足够数据</div>;
	const width = 320;
	const height = 94;
	const plotted = points.map((point, index) => ({
		x: points.length === 1 ? width / 2 : (index / (points.length - 1)) * width,
		y: height / 2 - (point.score / 100) * (height / 2 - 8),
		...point,
	}));
	const path = plotted
		.map((point, index) => `${index ? "L" : "M"}${point.x},${point.y}`)
		.join(" ");
	return (
		<div className="emotion-chart">
			<svg viewBox={`0 0 ${width} ${height}`} role="img">
				<title>近期情绪趋势，中线为中性</title>
				<line x1="0" y1={height / 2} x2={width} y2={height / 2} />
				<path d={path} />
				{plotted.map((point) => (
					<circle key={point.date} cx={point.x} cy={point.y} r="3">
						<title>
							{point.date} · {point.score}
						</title>
					</circle>
				))}
			</svg>
			<div>
				<span>{points[0]?.date.slice(5)}</span>
				<span>中性线</span>
				<span>{points[points.length - 1]?.date.slice(5)}</span>
			</div>
		</div>
	);
}

function ConversationInsightsPage() {
	const { t } = useTranslation();
	const [from, setFrom] = useState(localDate(29));
	const [to, setTo] = useState(localDate());
	const [channelId, setChannelId] = useState("");
	const [profileKey, setProfileKey] = useState("");
	const [page, setPage] = useState(1);
	const channelsQuery = useQuery({
		queryKey: ["im", "channels"],
		queryFn: () => imApi.listChannels(),
	});
	const profileParams = new URLSearchParams({
		from: localRangeIso(from),
		to: localRangeIso(to, true),
	});
	if (channelId) profileParams.set("channelId", channelId);
	const profilesQuery = useQuery({
		queryKey: ["im", "profiles", from, to, channelId],
		queryFn: () => imApi.listProfiles(profileParams),
	});
	const profiles = profilesQuery.data?.profiles ?? [];
	const selected =
		profiles.find(
			(profile) => `${profile.channelId}:${profile.contactId}` === profileKey,
		) ??
		profiles[0] ??
		null;
	const activeContactId = selected?.contactId ?? "";
	const recordsParams = new URLSearchParams({
		from: localRangeIso(from),
		to: localRangeIso(to, true),
		page: String(page),
		pageSize: "12",
	});
	if (selected?.channelId) recordsParams.set("channelId", selected.channelId);
	if (activeContactId) recordsParams.set("contactId", activeContactId);
	const recordsQuery = useQuery({
		queryKey: [
			"im",
			"conversations",
			from,
			to,
			channelId,
			activeContactId,
			selected?.channelId,
			page,
		],
		queryFn: () => imApi.listConversations(recordsParams),
		enabled: Boolean(activeContactId),
	});
	const records = recordsQuery.data?.items ?? [];
	const totalPages = Math.max(
		1,
		Math.ceil((recordsQuery.data?.total ?? 0) / 12),
	);
	return (
		<>
			<PageIntro index="03" title={t("conversationArchive")}>
				{t("conversationArchiveDescription")}
			</PageIntro>
			<section className="insight-filter" aria-label={t("timeFilter")}>
				<label>
					{t("fromDate")}
					<input
						type="date"
						value={from}
						max={to}
						onChange={(event) => {
							if (!event.target.value) return;
							setFrom(event.target.value);
							setPage(1);
						}}
					/>
				</label>
				<span aria-hidden="true">→</span>
				<label>
					{t("toDate")}
					<input
						type="date"
						value={to}
						min={from}
						onChange={(event) => {
							if (!event.target.value) return;
							setTo(event.target.value);
							setPage(1);
						}}
					/>
				</label>
				<label className="account-filter">
					{t("boundWechatAccount")}
					<select
						value={channelId}
						onChange={(event) => {
							setChannelId(event.target.value);
							setProfileKey("");
							setPage(1);
						}}
					>
						<option value="">{t("allAccounts")}</option>
						{channelsQuery.data?.channels.map((channel) => (
							<option key={channel.id} value={channel.id}>
								{channel.name} · {channel.config.userId || t("notLoggedIn")}
							</option>
						))}
					</select>
				</label>
				<div className="filter-result">
					<strong>{profiles.length}</strong>
					<span>{t("analysedContacts")}</span>
				</div>
			</section>
			{profilesQuery.isLoading ? (
				<div className="insight-empty">{t("loading")}</div>
			) : !profiles.length ? (
				<div className="insight-empty">
					<span>≈</span>
					<h2>{t("noConversationRecords")}</h2>
					<p>{t("noConversationHelp")}</p>
				</div>
			) : (
				<div className="insight-layout">
					<section className="conversation-column">
						<div className="contact-ribbon">
							{profiles.map((profile) => (
								<button
									type="button"
									key={`${profile.channelId}:${profile.contactId}`}
									className={
										`${profile.channelId}:${profile.contactId}` ===
										`${selected?.channelId}:${activeContactId}`
											? "active"
											: ""
									}
									onClick={() => {
										setProfileKey(`${profile.channelId}:${profile.contactId}`);
										setPage(1);
									}}
								>
									<span>{profile.contactLabel.slice(0, 1).toUpperCase()}</span>
									<div>
										<strong>{profile.contactLabel}</strong>
										<small>
											{profile.channelName} · {profile.messageCount}{" "}
											{t("messagesUnit")}
										</small>
									</div>
								</button>
							))}
						</div>
						<div className="record-heading">
							<div>
								<span className="eyebrow">DIALOGUE ARCHIVE</span>
								<h2>{t("conversationRecords")}</h2>
							</div>
							<span>
								{recordsQuery.data?.total ?? 0} {t("recordsUnit")}
							</span>
						</div>
						<div className="conversation-list">
							{records.map((record) => (
								<article key={record.id}>
									<header>
										<time>{new Date(record.createdAt).toLocaleString()}</time>
										<span
											className={`emotion-chip ${record.emotionScore < 0 ? "negative" : record.emotionScore > 0 ? "positive" : ""}`}
										>
											{record.emotionScore > 0 ? "+" : ""}
											{record.emotionScore}
										</span>
										{record.safetyLevel !== "LOW" && (
											<span className="safety-chip">{record.safetyLevel}</span>
										)}
									</header>
									<div className="message user-message">
										<span>{t("wechatContact")}</span>
										<p>{record.userText}</p>
									</div>
									{record.assistantText && (
										<details>
											<summary>{t("viewCoachReply")}</summary>
											<div className="message coach-message">
												<span>观心镜</span>
												<p>{record.assistantText}</p>
											</div>
										</details>
									)}
								</article>
							))}
						</div>
						{totalPages > 1 && (
							<div className="pagination">
								<button
									type="button"
									disabled={page <= 1}
									onClick={() => setPage((value) => value - 1)}
								>
									← {t("previousPage")}
								</button>
								<span>
									{page} / {totalPages}
								</span>
								<button
									type="button"
									disabled={page >= totalPages}
									onClick={() => setPage((value) => value + 1)}
								>
									{t("nextPage")} →
								</button>
							</div>
						)}
					</section>
					{selected && (
						<aside className="profile-panel">
							<div className="profile-account">
								<span className="profile-avatar">
									{selected.contactLabel.slice(0, 1).toUpperCase()}
								</span>
								<div>
									<span className="eyebrow">PSYCHOLOGICAL PORTRAIT</span>
									<h2>{selected.contactLabel}</h2>
									<p>
										{selected.channelName} ·{" "}
										{selected.wechatAccountId || t("unknownAccount")}
									</p>
								</div>
							</div>
							<div className="mbti-block">
								<div>
									<span>{t("mbtiTendency")}</span>
									<strong>{selected.mbti}</strong>
								</div>
								<em>
									{selected.confidence === "medium"
										? t("mediumConfidence")
										: t("lowConfidence")}
								</em>
							</div>
							<div className="dimension-list">
								{selected.dimensions.map((dimension) => (
									<div key={dimension.pair}>
										<span>{dimension.pair[0]}</span>
										<i>
											<b style={{ width: `${dimension.value}%` }} />
										</i>
										<span>{dimension.pair[1]}</span>
									</div>
								))}
							</div>
							<div className="profile-section">
								<div className="profile-section-title">
									<h3>{t("emotionFluctuation")}</h3>
									<span className={`volatility-${selected.emotion.level}`}>
										{t(`volatility_${selected.emotion.level}` as never)} ·{" "}
										{selected.emotion.volatility}
									</span>
								</div>
								<EmotionSparkline profile={selected} />
								<div className="emotion-tags">
									{selected.topEmotions.length ? (
										selected.topEmotions.map((emotion) => (
											<span key={emotion}>{emotion}</span>
										))
									) : (
										<span>{t("neutralExpression")}</span>
									)}
								</div>
							</div>
							<div className="profile-section">
								<h3>{t("personalityClues")}</h3>
								<ul>
									{selected.traits.map((trait) => (
										<li key={trait}>{trait}</li>
									))}
								</ul>
							</div>
							<div className="analysis-basis">
								<strong>{selected.messageCount}</strong>
								<span>
									{t("sampleMessages")}
									<br />
									{new Date(selected.firstSeenAt).toLocaleDateString()} —{" "}
									{new Date(selected.lastSeenAt).toLocaleDateString()}
								</span>
							</div>
							<p className="analysis-disclaimer">{t("analysisDisclaimer")}</p>
						</aside>
					)}
				</div>
			)}
		</>
	);
}

/* ------------------------- 模型配置 ------------------------- */

function ModelsPage() {
	const { t } = useTranslation();
	return (
		<>
			<PageIntro index="04" title={t("models")}>
				{t("subtitle")}
			</PageIntro>
			<div className="model-stack">
				<ModelForm modelRole="regular" title={t("modelRegular")} />
				<ModelForm modelRole="safety" title={t("modelSafety")} />
			</div>
		</>
	);
}
function ModelForm({ modelRole, title }: { modelRole: string; title: string }) {
	const role = modelRole;
	const { t } = useTranslation();
	const client = useQueryClient();
	const query = useQuery({
		queryKey: ["setting", "model", role],
		queryFn: () => api<Setting | null>(`/settings/models/${role}`),
	});
	const setting = query.data;
	const [form, setForm] = useState({
		baseUrl: "https://api.openai.com/v1",
		model: "",
		apiKey: "",
	});
	const [feedback, setFeedback] = useState<{
		text: string;
		error?: boolean;
	} | null>(null);
	useEffect(() => {
		if (setting)
			setForm((value) => ({
				...value,
				baseUrl: setting.config.baseUrl ?? value.baseUrl,
				model: setting.config.model ?? "",
			}));
	}, [setting]);
	const act = async (action: "save" | "test" | "activate") => {
		setFeedback(null);
		try {
			if (action === "save")
				await api(`/settings/models/${role}`, {
					method: "POST",
					body: JSON.stringify({
						config: { baseUrl: form.baseUrl, model: form.model },
						...(form.apiKey ? { secret: form.apiKey } : {}),
					}),
				});
			else await api(`/settings/models/${role}/${action}`, { method: "POST" });
			setFeedback({
				text: t(
					action === "save"
						? "saveSuccess"
						: action === "test"
							? "tested"
							: "activated",
				),
			});
			await client.invalidateQueries({ queryKey: ["setting", "model", role] });
		} catch (reason) {
			setFeedback({
				text: reason instanceof Error ? reason.message : t("error"),
				error: true,
			});
		}
	};
	return (
		<section className="form-panel model-panel">
			<div className="panel-heading">
				<div>
					<span className="eyebrow">{role.toUpperCase()} MODEL</span>
					<h2>{title}</h2>
				</div>
				<StatusBadge status={setting?.status} />
			</div>
			<div className="form-grid three">
				<Field
					label={t("baseUrl")}
					value={form.baseUrl}
					onChange={(baseUrl) => setForm({ ...form, baseUrl })}
				/>
				<Field
					label={t("modelName")}
					value={form.model}
					onChange={(model) => setForm({ ...form, model })}
				/>
				<Field
					secret
					label={t("apiKey")}
					placeholder={setting?.secretMasked || t("secretHint")}
					value={form.apiKey}
					onChange={(apiKey) => setForm({ ...form, apiKey })}
				/>
			</div>
			{feedback && (
				<Notice tone={feedback.error ? "error" : "success"}>
					{feedback.text}
				</Notice>
			)}
			<ActionBar status={setting?.status} onAction={act} />
		</section>
	);
}

function Field({
	label,
	value,
	onChange,
	placeholder,
	secret,
	wide,
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	secret?: boolean;
	wide?: boolean;
}) {
	return (
		<label className={wide ? "wide" : ""}>
			{label}
			<input
				type={secret ? "password" : "text"}
				value={value}
				placeholder={placeholder}
				onChange={(event) => onChange(event.target.value)}
			/>
		</label>
	);
}
function ActionBar({
	status,
	onAction,
}: {
	status?: string;
	onAction: (action: "save" | "test" | "activate") => void;
}) {
	const { t } = useTranslation();
	return (
		<div className="action-bar">
			<button
				type="button"
				className="secondary-button"
				onClick={() => void onAction("save")}
			>
				{t("saveDraft")}
			</button>
			<button
				type="button"
				className="secondary-button"
				disabled={status !== "DRAFT"}
				onClick={() => void onAction("test")}
			>
				{t("test")}
			</button>
			<button
				type="button"
				className="primary-button compact"
				disabled={status !== "TESTED"}
				onClick={() => void onAction("activate")}
			>
				{t("activate")} →
			</button>
		</div>
	);
}

function AuditPage() {
	const { t } = useTranslation();
	const query = useQuery({
		queryKey: ["audit"],
		queryFn: () =>
			api<
				Array<{
					id: string;
					action: string;
					actorType: string;
					resourceType: string;
					createdAt: string;
				}>
			>("/audit-events?limit=100"),
	});
	return (
		<>
			<PageIntro index="05" title={t("audit")}>
				{t("subtitle")}
			</PageIntro>
			<section className="audit-list">
				{!query.data?.length ? (
					<p>{t("auditEmpty")}</p>
				) : (
					query.data.map((event) => (
						<article key={event.id}>
							<time>{new Date(event.createdAt).toLocaleString()}</time>
							<strong>{event.action.replaceAll("_", " ")}</strong>
							<span>
								{event.actorType} → {event.resourceType}
							</span>
						</article>
					))
				)}
			</section>
		</>
	);
}

export function App() {
	const client = useQueryClient();
	const sessionQuery = useQuery({
		queryKey: ["session"],
		queryFn: () => api<Session>("/auth/session"),
		retry: false,
	});
	useEffect(() => {
		if (sessionQuery.data) setCsrfToken(sessionQuery.data.csrfToken);
	}, [sessionQuery.data]);
	const session = sessionQuery.data;
	if (sessionQuery.isLoading)
		return (
			<div className="loading-screen">
				<span className="brand-mark">◌</span>
			</div>
		);
	if (!session)
		return (
			<Login onLogin={(value) => client.setQueryData(["session"], value)} />
		);
	return (
		<Shell
			session={session}
			onLogout={async () => {
				await api("/auth/logout", { method: "POST" });
				setCsrfToken("");
				client.clear();
			}}
		/>
	);
}
