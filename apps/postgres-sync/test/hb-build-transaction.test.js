import test from "node:test";
import assert from "node:assert/strict";
import { withHbBuildTransaction } from "../src/hb-build-transaction.js";

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test("a queued rebuild waits before reading sources and still builds with newer changes", async () => {
  const lockRequested = deferred();
  const lockGranted = deferred();
  const queries = [];
  let sourceVersion = 1;
  let buildCalls = 0;
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes("pg_advisory_xact_lock")) {
        lockRequested.resolve();
        await lockGranted.promise;
      }
      return { rows: [] };
    }
  };

  const pendingBuild = withHbBuildTransaction(client, async activeClient => {
    assert.equal(activeClient, client);
    buildCalls += 1;
    const observedVersion = sourceVersion;
    await activeClient.query("update test_read_model");
    return { observedVersion };
  });
  await lockRequested.promise;
  assert.equal(buildCalls, 0);
  assert.deepEqual(queries.map(query => query.sql), [
    "begin",
    "select pg_advisory_xact_lock($1::integer, $2::integer)"
  ]);
  assert.equal(queries[1].params.length, 2);
  assert.ok(queries[1].params.every(Number.isInteger));

  sourceVersion = 2;
  lockGranted.resolve();
  assert.deepEqual(await pendingBuild, { observedVersion: 2 });
  assert.equal(buildCalls, 1);
  assert.deepEqual(queries.slice(2).map(query => query.sql), ["update test_read_model", "commit"]);
});

test("a failed rebuild rolls back the transaction and releases its transaction lock", async () => {
  const queries = [];
  const failure = new Error("rebuild failed");
  const client = {
    async query(sql) {
      queries.push(sql);
      return { rows: [] };
    }
  };

  await assert.rejects(withHbBuildTransaction(client, async () => { throw failure; }), error => error === failure);
  assert.equal(queries.at(-1), "rollback");
  assert.ok(!queries.includes("commit"));
});

test("failure to acquire the lock aborts without starting a partial rebuild", async () => {
  const queries = [];
  const failure = new Error("lock acquisition cancelled");
  let buildCalls = 0;
  const client = {
    async query(sql) {
      queries.push(sql);
      if (sql.includes("pg_advisory_xact_lock")) throw failure;
      return { rows: [] };
    }
  };

  await assert.rejects(withHbBuildTransaction(client, async () => { buildCalls += 1; }), error => error === failure);
  assert.equal(buildCalls, 0);
  assert.equal(queries.at(-1), "rollback");
  assert.ok(!queries.includes("commit"));
});

test("a rollback failure preserves the error that caused the rebuild to fail", async () => {
  const failure = new Error("rebuild failed");
  const client = {
    async query(sql) {
      if (sql === "rollback") throw new Error("connection lost");
      return { rows: [] };
    }
  };

  await assert.rejects(withHbBuildTransaction(client, async () => { throw failure; }), error => error === failure);
});
