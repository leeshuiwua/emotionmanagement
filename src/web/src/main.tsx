import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import ReactDOM from "react-dom/client";
import "./i18n";
import { App } from "./App";
import "./styles.css";

const client = new QueryClient({
	defaultOptions: { queries: { retry: 1, staleTime: 10_000 } },
});
const root = document.getElementById("root");
if (!root) throw new Error("Application root element is missing");
ReactDOM.createRoot(root).render(
	<React.StrictMode>
		<QueryClientProvider client={client}>
			<App />
		</QueryClientProvider>
	</React.StrictMode>,
);
