import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function toolNames(source) {
  const register = [...source.matchAll(/registerTool\(\s*(?:\n\s*)?"([^"]+)"/g)].map((m) => m[1]);
  const v4 = [...source.matchAll(/v4Tool\(\s*"([^"]+)"/g)].map((m) => m[1]);
  return [...register, ...v4];
}

function countIn(text) {
  const match = text.match(/(\d+)\s+tools/);
  assert.ok(match, "expected a '<n> tools' count");
  return Number(match[1]);
}

test("package, server, skill, and readme share the registered tool count", () => {
  const names = toolNames(readFileSync(new URL("../../src/index.ts", import.meta.url), "utf8"));
  assert.equal(new Set(names).size, names.length);
  const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  const serverJson = JSON.parse(readFileSync(new URL("../../server.json", import.meta.url), "utf8"));
  const skill = readFileSync(new URL("../../SKILL.md", import.meta.url), "utf8");
  const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
  const expected = countIn(packageJson.description);
  assert.equal(names.length, expected);
  assert.equal(countIn(serverJson.description), expected);
  assert.equal(countIn(skill), expected);
  assert.equal(countIn(readme), expected);
});
