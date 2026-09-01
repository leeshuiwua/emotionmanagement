import "dotenv/config";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const { app, close } = await createApp(config);

const server = app.listen(config.port, config.host, () => {
	console.log(
		`[guanxinjing] listening on http://${config.host}:${config.port}`,
	);
});

const shutdown = () => {
	server.close(() => {
		close();
		process.exit(0);
	});
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
