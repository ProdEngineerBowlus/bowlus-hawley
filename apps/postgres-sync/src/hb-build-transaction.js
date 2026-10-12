// The two-key advisory-lock namespace is separate from the one-key worker-day
// timer locks. All build-hb callers use this database-wide gate, including
// independent web processes and the Asana, Airtable, manual, and nightly jobs.
const HB_BUILD_LOCK_NAMESPACE = 0x4841574c; // HAWL
const HB_BUILD_LOCK_KEY = 0x48424244; // HBBD

export async function withHbBuildTransaction(client, build) {
  await client.query("begin");
  try {
    // Wait before reading source rows or taking any row locks. Every caller
    // still rebuilds after acquiring the lock, so a refresh that arrived during
    // another build cannot silently lose its newer source changes. PostgreSQL
    // releases this lock on commit, rollback, or connection loss.
    await client.query(
      "select pg_advisory_xact_lock($1::integer, $2::integer)",
      [HB_BUILD_LOCK_NAMESPACE, HB_BUILD_LOCK_KEY]
    );
    const result = await build(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
}
