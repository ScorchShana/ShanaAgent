import process from "node:process";
import { parseCLI, startVitest } from "vitest/node";
import config from "./vitest.config.ts";

const { filter, options } = parseCLI(["vitest", "run", ...process.argv.slice(2)]);
const context = await startVitest("test", filter, { ...options, config: false, run: true }, config);
await context?.close();
