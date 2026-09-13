import { copyFileSync, mkdirSync } from "node:fs";

const destination = new URL("../dist/server/config/", import.meta.url);
mkdirSync(destination, { recursive: true });
copyFileSync(
  new URL("../src/server/config/prompts.xml", import.meta.url),
  new URL("prompts.xml", destination),
);
