import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api } from "./api";
import "./ledger.css";

type Entry = {
	id: string;
	kind: "income" | "expense";
	cents: number;
	category: string;
	account: string;
	note: string;
	date: string;
	source: string;
};
type Records = {
	items: Entry[];
	total: number;
	summary: { income: number; expense: number; net: number };
	categories: { category: string; cents: number }[];
};
const money = (cents: number) =>
	new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY" }).format(
		cents / 100,
	);
const today = () =>
	new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(
		new Date(),
	);

export function LedgerPage() {
	const client = useQueryClient();
	const [book, setBook] = useState("");
	const [month, setMonth] = useState(today().slice(0, 7));
	const [page, setPage] = useState(1);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState("");
	const books = useQuery({
		queryKey: ["ledger", "books"],
		queryFn: () =>
			api<{ books: { id: string; name: string }[] }>("/ledger/books"),
		refetchInterval: 15000,
	});
	const selected = book || books.data?.books[0]?.id || "";
	const records = useQuery({
		queryKey: ["ledger", selected, month, page],
		queryFn: () =>
			api<Records>(
				`/ledger/books/${selected}/entries?month=${month}&page=${page}`,
			),
		enabled: Boolean(selected && month),
		refetchInterval: 15000,
	});
	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const form = event.currentTarget;
		const fields = new FormData(form);
		setBusy(true);
		setError("");
		setNotice("");
		try {
			await api(`/ledger/books/${selected}/entries`, {
				method: "POST",
				body: JSON.stringify(Object.fromEntries(fields.entries())),
			});
			setMonth(String(fields.get("date")).slice(0, 7));
			setPage(1);
			form.reset();
			setNotice("已保存账目");
			await client.invalidateQueries({ queryKey: ["ledger"] });
		} catch (e) {
			setError(e instanceof Error ? e.message : "保存失败");
		} finally {
			setBusy(false);
		}
	}
	async function remove(entry: Entry) {
		if (
			!window.confirm(
				`删除 ${entry.date} ${entry.category} ${money(entry.cents)}？`,
			)
		)
			return;
		setBusy(true);
		setError("");
		try {
			await api(`/ledger/books/${selected}/entries/${entry.id}`, {
				method: "DELETE",
			});
			setPage(1);
			setNotice("已删除账目");
			await client.invalidateQueries({ queryKey: ["ledger"] });
		} catch (e) {
			setError(e instanceof Error ? e.message : "删除失败");
		} finally {
			setBusy(false);
		}
	}
	return (
		<section className="ledger-page">
			<header>
				<span className="eyebrow">DAILY LEDGER</span>
				<h1>生活账本</h1>
				<p>记录每一笔收支，看见钱花在哪里。人民币 · 北京时间</p>
			</header>
			<div className="ledger-filters">
				<label>
					账本
					<select
						value={selected}
						disabled={busy}
						onChange={(e) => {
							setBook(e.target.value);
							setPage(1);
						}}
					>
						{books.data?.books.map((b) => (
							<option key={b.id} value={b.id}>
								{b.name}
							</option>
						))}
					</select>
				</label>
				<label>
					月份
					<input
						type="month"
						value={month}
						onChange={(e) => {
							if (e.target.value) {
								setMonth(e.target.value);
								setPage(1);
							}
						}}
					/>
				</label>
			</div>
			{(error || books.error || records.error) && (
				<p role="alert">
					{error || books.error?.message || records.error?.message}
				</p>
			)}
			{notice && <p role="status">{notice}</p>}
			<div className="ledger-totals">
				{(
					[
						["本月收入", records.data?.summary.income],
						["本月支出", records.data?.summary.expense],
						["本月结余", records.data?.summary.net],
					] as const
				).map(([label, value]) => (
					<article key={label}>
						<span>{label}</span>
						<strong>{value === undefined ? "—" : money(value)}</strong>
					</article>
				))}
			</div>
			<div className="ledger-grid">
				<form onSubmit={submit} className="ledger-card">
					<h2>记一笔</h2>
					<label>
						类型
						<select name="kind">
							<option value="expense">支出</option>
							<option value="income">收入</option>
						</select>
					</label>
					<label>
						金额（元）
						<input
							name="amount"
							type="number"
							min="0.01"
							max="99999999.99"
							step="0.01"
							required
							placeholder="0.00"
						/>
					</label>
					<label>
						分类
						<input
							name="category"
							required
							maxLength={40}
							placeholder="餐饮、交通、工资…"
						/>
					</label>
					<label>
						账户
						<input
							name="account"
							required
							maxLength={40}
							defaultValue="默认账户"
						/>
					</label>
					<label>
						日期
						<input name="date" type="date" required defaultValue={today()} />
					</label>
					<label>
						备注
						<input name="note" maxLength={200} placeholder="可选" />
					</label>
					<button type="submit" disabled={busy || !selected}>
						{busy ? "处理中…" : "保存账目"}
					</button>
				</form>
				<section className="ledger-card">
					<h2>支出分类</h2>
					{records.data?.categories.length ? (
						records.data.categories.map((c) => (
							<div className="ledger-category" key={c.category}>
								<span>{c.category}</span>
								<strong>{money(c.cents)}</strong>
							</div>
						))
					) : (
						<p>本月暂无支出</p>
					)}
					<hr />
					<h2>微信随手记</h2>
					<p>
						直接说“午饭花了三十五块”，AI
						会直接记账；表达自己的感受会保存为心情记录。两者都有会分别记录。自动识别需要启用有效的日常模型。
					</p>
					<p>
						发送「记账 午饭35元」或「记账 收入
						工资8000元」即可直接入账。回复「查账」查看本月收支；记错可在后台删除后重新录入。
					</p>
					<p>
						支持已有转写文字的语音。每位微信联系人有独立账本，管理员可在此查看。金额、日期或分类不确定时，请在后台手动录入。
					</p>
				</section>
			</div>
			<section className="ledger-card">
				<h2>
					收支明细 <small>共 {records.data?.total ?? 0} 笔</small>
				</h2>
				{records.isLoading ? (
					<p>加载中…</p>
				) : (
					<div className="ledger-table">
						<table>
							<thead>
								<tr>
									<th>日期</th>
									<th>分类 / 备注</th>
									<th>账户</th>
									<th>金额</th>
									<th>来源</th>
									<th>操作</th>
								</tr>
							</thead>
							<tbody>
								{records.data?.items.map((entry) => (
									<tr key={entry.id}>
										<td>{entry.date}</td>
										<td>
											{entry.category}
											<small>{entry.note}</small>
										</td>
										<td>{entry.account}</td>
										<td className={entry.kind}>
											{entry.kind === "income" ? "+" : "−"}
											{money(entry.cents)}
										</td>
										<td>{entry.source === "wechat" ? "微信" : "后台"}</td>
										<td>
											<button
												type="button"
												disabled={busy}
												onClick={() => void remove(entry)}
											>
												删除
											</button>
										</td>
									</tr>
								))}
							</tbody>
						</table>
						{!records.data?.items.length && (
							<p>本月暂无账目，记下第一笔收支吧。</p>
						)}
					</div>
				)}
				<div className="ledger-pagination">
					<button
						type="button"
						disabled={page === 1}
						onClick={() => setPage(page - 1)}
					>
						上一页
					</button>
					<span>第 {page} 页</span>
					<button
						type="button"
						disabled={page * 30 >= (records.data?.total ?? 0)}
						onClick={() => setPage(page + 1)}
					>
						下一页
					</button>
				</div>
			</section>
		</section>
	);
}
