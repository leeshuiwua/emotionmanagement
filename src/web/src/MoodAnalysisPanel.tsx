import { useQuery } from "@tanstack/react-query";
import { type ContactProfile, imApi } from "./api";
import "./mood.css";

export function MoodAnalysisPanel({
	profile,
	from,
	to,
}: {
	profile: ContactProfile;
	from: string;
	to: string;
}) {
	const params = new URLSearchParams({
		channelId: profile.channelId,
		contactId: profile.contactId,
		from,
		to,
	});
	const query = useQuery({
		queryKey: [
			"mood-analysis",
			profile.channelId,
			profile.contactId,
			from,
			to,
			profile.lastSeenAt,
			profile.messageCount,
		],
		queryFn: () => imApi.analyseMood(params),
		retry: false,
		refetchOnWindowFocus: false,
		staleTime: 60000,
	});
	const result = query.data;
	return (
		<aside className="profile-panel mood-review" aria-label="个人心境回顾">
			<div className="profile-account">
				<div>
					<span className="eyebrow">PERSONAL REFLECTION</span>
					<h2>{profile.contactLabel}</h2>
					<p>
						{profile.channelName} · {profile.messageCount} 条心情记录
					</p>
				</div>
			</div>
			<p className="analysis-disclaimer">
				依据所选时间内的本人表达，不是心理测评或医学诊断。最近记录不等于此刻状态。
			</p>
			{profile.highRiskCount > 0 && (
				<p className="analysis-disclaimer">
					所选记录中有 {profile.highRiskCount}{" "}
					条被本地规则标记需关注安全，请结合原文判断；该标记不是诊断。
				</p>
			)}
			{query.isPending && <p role="status">正在结合你的记录整理心境与建议…</p>}
			{query.isError && (
				<div role="alert">
					<p>{query.error.message}</p>
					<button
						type="button"
						className="primary-button compact"
						onClick={() => void query.refetch()}
						disabled={query.isFetching}
					>
						重新分析
					</button>
				</div>
			)}
			{result && (
				<>
					<p className="analysis-basis">
						本次依据最近 {result.sampleCount} / {result.totalCount} 条记录
						<br />
						{new Date(result.firstAt).toLocaleDateString("zh-CN", {
							timeZone: "Asia/Shanghai",
						})}{" "}
						—{" "}
						{new Date(result.lastAt).toLocaleDateString("zh-CN", {
							timeZone: "Asia/Shanghai",
						})}
						{result.truncated && (
							<>
								<br />
								记录已采样或截短，并非全部历史。
							</>
						)}
					</p>
					{(
						[
							["current", "最近心境"],
							["changes", "变化线索"],
							["traits", "表达与性格倾向"],
							["advice", "此刻可以尝试"],
						] as const
					).map(([key, title]) => (
						<section className="profile-section" key={key}>
							<h3>{title}</h3>
							<p>{result.analysis[key]}</p>
						</section>
					))}
					<p className="analysis-disclaimer">{result.analysis.limitations}</p>
					<details>
						<summary>查看分析依据（{result.evidence.length} 条）</summary>
						{result.evidence.map((item) => (
							<blockquote key={item.id}>
								<time>
									{new Date(item.at).toLocaleString("zh-CN", {
										timeZone: "Asia/Shanghai",
									})}
								</time>
								<p>{item.text}</p>
							</blockquote>
						))}
					</details>
					<p className="analysis-disclaimer">
						{result.model} · 生成于{" "}
						{new Date(result.generatedAt).toLocaleString("zh-CN", {
							timeZone: "Asia/Shanghai",
						})}
					</p>
				</>
			)}
		</aside>
	);
}
