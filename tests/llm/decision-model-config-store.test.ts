import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { loadDecisionModelConfig } from "../../src/llm/decision-model-config-store.js";
const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function file(value?: unknown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "decision-config-"));
  dirs.push(dir);
  const target = path.join(dir, "decision-model.json");
  if (value !== undefined) fs.writeFileSync(target, JSON.stringify(value));
  return target;
}
it("missing config is not created", () => {
  const target = file();
  expect(loadDecisionModelConfig(target)).toEqual({ status: "missing" });
  expect(fs.existsSync(target)).toBe(false);
});
it("loads optional credentials and normalizes root", () => {
  expect(
    loadDecisionModelConfig(file({ base_url: "http://localhost:8081/", model: "m", apiKey: "secret" })),
  ).toEqual({
    status: "ok",
    config: { base_url: "http://localhost:8081", model: "m", apiKey: "secret" },
    secrets: ["secret"],
  });
});
it.each([
  null,
  [],
  {},
  { base_url: "relative" },
  { base_url: "ftp://host" },
  { base_url: "http://host/v1" },
  { base_url: "http://host?" },
  { base_url: "http://user:pass@host" },
  { base_url: "http://host", model: " " },
  { base_url: "http://host", apiKey: "" },
  { base_url: "http://host", version: 1 },
])("rejects invalid config %j without exposing input", (value) => {
  const target = file(value);
  const before = fs.readFileSync(target, "utf8");
  expect(loadDecisionModelConfig(target).status).toBe("invalid");
  expect(fs.readFileSync(target, "utf8")).toBe(before);
});
it("invalid JSON and read failures are controlled", () => {
  const target = file();
  fs.writeFileSync(target, "{secret");
  expect(loadDecisionModelConfig(target)).toEqual({
    status: "invalid",
    message: expect.not.stringContaining("{secret"),
  });
  vi.spyOn(fs, "readFileSync").mockImplementation(() => {
    throw Object.assign(new Error("secret"), { code: "EACCES" });
  });
  expect(loadDecisionModelConfig(target)).toEqual({
    status: "invalid",
    message: expect.not.stringContaining("secret"),
  });
});

it.each([" http://host ", "http://host ", "http:host", "http://ho\nst"])(
  "rejects roots normalized by URL parsing: %j",
  (base_url) => {
    expect(loadDecisionModelConfig(file({ base_url })).status).toBe("invalid");
  },
);
it("preserves literal apiKey without environment expansion", () => {
  expect(loadDecisionModelConfig(file({ base_url: "http://host", apiKey: "${DECISION_KEY}" }))).toMatchObject(
    { status: "ok", config: { apiKey: "${DECISION_KEY}" }, secrets: ["${DECISION_KEY}"] },
  );
});
