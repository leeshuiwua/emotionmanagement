import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MemoryView } from "../../server/memory/view";
import { api } from "./api";
import "./memory.css";

const time = (value: string) =>
	new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
export function MemoryPanel({ personId }: { personId: string }) {
	const client = useQueryClient();
	const [tab, setTab] = useState<"profile" | "daily" | "facts">("profile");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const requested = useRef<number | null>(null);
	const query = useQuery({
		queryKey: ["memory", "person", personId],
		queryFn: () => api<MemoryView>(`/memory/${personId}`),
		refetchInterval: (q) =>
			["pending", "running"].includes(q.state.data?.task?.status ?? "")
				? 3000
				: false,
	});
	const data = query.data;
	const refetch = query.refetch;
	const refresh = useCallback(async () => {
		setBusy(true);
		setError("");
		try {
			await api(`/memory/${personId}/refresh`, { method: "POST" });
			await refetch();
		} catch (e) {
			setError(e instanceof Error ? e.message : "暂时无法更新，请重试");
		} finally {
			setBusy(false);
		}
	}, [personId, refetch]);
	useEffect(() => {
		if (
			!data?.counts.messages ||
			!data.stale ||
			data.task?.status === "failed" ||
			requested.current === data.person.revision
		)
			return;
		requested.current = data.person.revision;
		void refresh();
	}, [data, refresh]);
	const clear = async () => {
		if (
			!window.confirm(
				"清除这位记录人的全部心情记录、当天上下文、长期记忆和画像？不受日期筛选限制，账本保留。此操作无法在页面恢复。",
			)
		)
			return;
		setBusy(true);
		setError("");
		try {
			await api(`/memory/${personId}`, {
				method: "DELETE",
				body: JSON.stringify({ confirmation: "CLEAR_PERSON_MEMORY" }),
			});
			await client.cancelQueries({ queryKey: ["memory"] });
			client.removeQueries({ queryKey: ["memory", "person", personId] });
			await client.cancelQueries({ queryKey: ["mood-analysis"] });
			client.removeQueries({ queryKey: ["mood-analysis"] });
			await client.invalidateQueries({ queryKey: ["im"] });
			await client.invalidateQueries({ queryKey: ["memory", "users"] });
		} catch (e) {
			setError(e instanceof Error ? e.message : "清除失败，请重试");
		} finally {
			setBusy(false);
		}
	};
	const correct = async (factId: string) => {
		const correction = window.prompt(
			"请填写错误原因或更正说明。原记忆将停止参与画像，说明作为管理员批注保留，不冒充用户自述。",
		);
		if (!correction?.trim()) return;
		setBusy(true);
		setError("");
		try {
			await api(`/memory/${personId}/facts/${factId}/correct`, {
				method: "POST",
				body: JSON.stringify({ correction }),
			});
			await query.refetch();
		} catch (e) {
			setError(e instanceof Error ? e.message : "更正失败");
		} finally {
			setBusy(false);
		}
	};
	const evidence = (ids: string[]) => (
		<details className="memory-evidence">
			<summary>查看原文依据 · {ids.length} 条</summary>
			{ids.map((id) => {
				const e = data?.evidence.find((e) => e.id === id);
				return e ? (
					<blockquote key={id}>
						<time>
							{time(e.at)}
							{e.legacy ? " · 历史记录" : ""}
						</time>
						<p>{e.text}</p>
					</blockquote>
				) : null;
			})}
		</details>
	);
	const updating =
		busy || ["pending", "running"].includes(data?.task?.status ?? "");
	return (
		<section className="memory-panel" aria-label="长期记忆与性格画像">
			<header className="memory-heading">
				<div>
					<span className="eyebrow">属于这位记录人的长期回顾</span>
					<h2>认识自己，多一点依据</h2>
					<p>独立保存每位发送者的记忆 · 长期画像不受日期筛选影响</p>
				</div>
				<button
					type="button"
					className="secondary-button"
					disabled={busy || updating || !data?.counts.messages}
					onClick={() => void refresh()}
				>
					{updating ? "更新中…" : "重新生成"}
				</button>
			</header>
			<nav className="memory-tabs" aria-label="记忆视图">
				{(
					[
						["profile", "长期性格画像"],
						["daily", "当天上下文"],
						["facts", "长期记忆"],
					] as const
				).map(([key, label]) => (
					<button
						key={key}
						type="button"
						aria-pressed={tab === key}
						className={tab === key ? "active" : ""}
						onClick={() => setTab(key)}
					>
						{label}
					</button>
				))}
			</nav>
			{(error || query.error || data?.task?.error) && (
				<p role="alert" className="memory-error">
					{error || query.error?.message || data?.task?.error}
				</p>
			)}
			{!data ? (
				<p>{query.isLoading ? "正在读取记忆…" : "记忆暂时不可用。"}</p>
			) : (
				<>
					<div className="memory-meta">
						<span>{data.counts.messages} 条记录</span>
						<span>{data.counts.days} 个记录日</span>
						<span>{data.totalFacts} 条有效记忆</span>
						<span>
							{data.counts.firstAt
								? `${time(data.counts.firstAt)} 起`
								: "尚无记录"}
						</span>
					</div>
					{tab === "profile" &&
						(data.profile ? (
							<div className="memory-profile">
								<p className="memory-lead">{data.profile.analysis.overview}</p>
								{data.stale && (
									<p className="memory-hint">
										展示上一版画像，新证据整理完成后更新。
									</p>
								)}
								<div className="memory-traits">
									{data.profile.analysis.traits.map((trait) => (
										<article
											key={`${trait.title}:${trait.evidenceIds.join(",")}`}
										>
											<h3>{trait.title}</h3>
											<p>{trait.observation}</p>
											<p className="memory-counter">
												反向证据与边界：{trait.counterEvidence}
											</p>
											{evidence(trait.evidenceIds)}
										</article>
									))}
								</div>
								<h3>随时间的变化</h3>
								<p>{data.profile.analysis.changes}</p>
								<p className="memory-hint">
									{data.profile.analysis.limitations}
								</p>
								<footer>
									更新于 {time(data.profile.createdAt)} · {data.profile.model} ·
									基于本人记录的观察，非心理测评或诊断
								</footer>
							</div>
						) : (
							<div className="memory-empty">
								<h3>
									{updating ? "正在整理这位用户的经历与表达" : "还没有长期画像"}
								</h3>
								<p>
									积累本人表达后生成有原文依据的观察。样本不足时会明确说明，不强行判断性格。
								</p>
							</div>
						))}
					{tab === "daily" && (
						<div>
							<p className="memory-hint">
								{data.shortTerm.day} ·
								北京时间，每天独立会话。展示最近消息及当天摘要。
							</p>
							<p>{data.shortTerm.summary || "当天摘要尚未生成。"}</p>
							{data.shortTerm.events.map((e) => (
								<article className="memory-event" key={e.id}>
									<time>{time(e.at)}</time>
									<p>{e.text}</p>
									<small>{e.reply}</small>
								</article>
							))}
							{!data.shortTerm.events.length && <p>今天还没有记录。</p>}
						</div>
					)}
					{tab === "facts" && (
						<div>
							<p className="memory-hint">
								记忆长期保留，可标记错误并更正。此处展示最近 100
								条，画像覆盖全部有效记忆。
							</p>
							{data.facts.map((f) => (
								<article className="memory-event" key={f.id}>
									<span className="memory-kind">
										{{
											fact: "自述经历",
											preference: "偏好",
											pattern: "反复表达",
											coping: "应对方式",
										}[f.kind] ?? f.kind}
									</span>
									<p>{f.text}</p>
									{f.invalidatedAt ? (
										<p className="memory-hint">已停用 · {f.correction}</p>
									) : (
										<button
											type="button"
											className="secondary-button"
											disabled={busy}
											onClick={() => void correct(f.id)}
										>
											标记错误并更正
										</button>
									)}
									{evidence(f.evidenceIds)}
								</article>
							))}
							{!data.facts.length && <p>尚无适合长期保留的记忆。</p>}
						</div>
					)}
					<div className="memory-danger">
						<span>清除仅影响这位记录人，账本保留。</span>
						<button
							type="button"
							className="row-action danger"
							disabled={busy}
							onClick={() => void clear()}
						>
							清除该用户记录
						</button>
					</div>
				</>
			)}
		</section>
	);
}
