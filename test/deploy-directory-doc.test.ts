import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("the onboarding guide uses the portal's implemented OIDC callback", () => {
  const guide = readFileSync(new URL("../docs/getting-started.md", import.meta.url), "utf8");
  assert.match(guide, /<publicUrl>\/auth\/callback/);
  assert.doesNotMatch(guide, /<publicUrl>\/oauth\/callback/);
});
