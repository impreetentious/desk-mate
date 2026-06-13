import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import type { ScopeId } from "../src/types.ts";

const scope = "personal:test@example.com" as ScopeId;

async function sessionWithLease() {
  const store = createMemorySessionStore();
  const session = await store.getOrCreateByThread("dm:tape-test", "dm", scope);
  const { lease } = await store.acquireLease(session.id);
  assert.ok(lease);
  return { store, session, lease: lease! };
}

test("tape appends preserve order and round-trip payloads verbatim", async () => {
  const { store, session, lease } = await sessionWithLease();
  const user = { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 };
  const assistant = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "…", thinkingSignature: "sig" },
      { type: "text", text: "hello" },
    ],
    timestamp: 2,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-opus-4-8",
  };
  await store.appendTape(lease, {
    kind: "message",
    harness: "claude",
    payload: user,
    scopeLabel: scope,
    entrySeq: 0,
    meta: { bareText: "hi", ts: "1720000000.000100" },
  });
  await store.appendTape(lease, { kind: "message", harness: "claude", payload: assistant, scopeLabel: scope });
  await store.appendTape(lease, { kind: "annotation", payload: { turnEnd: true }, scopeLabel: scope, entrySeq: 1 });

  const rows = await store.getTape(session.id);
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => r.seq),
    [0, 1, 2],
  );
  assert.deepEqual(rows[0]!.payload, user);
  assert.deepEqual(rows[1]!.payload, assistant);
  assert.equal(rows[0]!.meta?.bareText, "hi");
  assert.equal(rows[0]!.meta?.ts, "1720000000.000100");
  assert.equal(rows[1]!.harness, "claude");
});

test("tape append without a valid lease throws", async () => {
  const { store, session } = await sessionWithLease();
  await assert.rejects(
    store.appendTape({ sessionId: session.id, token: "stale" }, { kind: "message", payload: {}, scopeLabel: scope }),
    /tape append without a valid session lease/,
  );
});

test("getTape limit returns the newest N oldest-first, matching getEntries semantics", async () => {
  const { store, session, lease } = await sessionWithLease();
  for (let i = 0; i < 4; i++) await store.appendTape(lease, { kind: "message", payload: { i }, scopeLabel: scope });
  const rows = await store.getTape(session.id, { limit: 2 });
  assert.deepEqual(
    rows.map((r) => r.seq),
    [2, 3],
  );
});

test("tapeCoverage counts only watermarks and import covers — message mirrors can't launder a gap", async () => {
  const { store, session, lease } = await sessionWithLease();
  assert.equal(await store.tapeCoverage(session.id), -1);
  await store.appendTape(lease, {
    kind: "context_event",
    payload: { event: "legacy_import", messages: [] },
    scopeLabel: scope,
    coversEntrySeq: 41,
  });
  assert.equal(await store.tapeCoverage(session.id), 41);
  await store.appendTape(lease, {
    kind: "message",
    payload: { role: "user", content: [] },
    scopeLabel: scope,
    entrySeq: 42,
  });
  assert.equal(await store.tapeCoverage(session.id), 41);
  await store.appendTape(lease, { kind: "annotation", payload: { subturnEnd: true }, scopeLabel: scope, entrySeq: 99 });
  assert.equal(await store.tapeCoverage(session.id), 41);
  await store.appendTape(lease, { kind: "annotation", payload: { turnEnd: "true" }, scopeLabel: scope, entrySeq: 98 });
  assert.equal(await store.tapeCoverage(session.id), 41);
  await store.appendTape(lease, {
    kind: "context_event",
    payload: { event: "compaction", text: "summary" },
    scopeLabel: scope,
    coversEntrySeq: 100,
  });
  assert.equal(await store.tapeCoverage(session.id), 41);
  await store.appendTape(lease, { kind: "annotation", payload: { turnEnd: true }, scopeLabel: scope, entrySeq: 42 });
  assert.equal(await store.tapeCoverage(session.id), 42);
});

test("deleteSession removes tape rows", async () => {
  const { store, session, lease } = await sessionWithLease();
  await store.appendTape(lease, { kind: "message", payload: {}, scopeLabel: scope });
  await store.deleteSession(session.id);
  assert.deepEqual(await store.getTape(session.id), []);
});
