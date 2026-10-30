// Asana side of a cycle plan publish: add missing year-qualified options to the workspace "Cycle" field and
// set that field on moved tasks. `request(path, method, body)` is adminAsanaRequest bound to a token; it
// wraps `body` in { data } itself, so callers pass the bare payload.

export const ASANA_CYCLE_FIELD_GID = "1203060130064229";

const CYCLE_LABEL = /^c(\d+)\.(\d{2})$/;
const cycleSortKey = name => {
  const match = CYCLE_LABEL.exec(name);
  return match ? Number(match[2]) * 1000 + Number(match[1]) : null;
};

// Adds missing options in plan order, each inserted after its chronological predecessor (C1.27 after
// C24.26), so the dropdown stays in order. `options` maps lower-case name -> option gid and is updated.
export async function addCycleOptions(request, labels, options, log = () => {}) {
  const added = [];
  const failed = [];
  if (!labels.length) return { options, added, failed };
  if (!request || !options) return { options, added, failed: [...labels] };
  for (const label of labels) {
    const key = label.toLowerCase();
    if (options.has(key)) continue;
    const order = cycleSortKey(key);
    const previous = order == null ? null : [...options.keys()]
      .filter(name => cycleSortKey(name) != null && cycleSortKey(name) < order)
      .sort((a, b) => cycleSortKey(a) - cycleSortKey(b))
      .at(-1);
    const payload = { name: label, enabled: true };
    if (previous) payload.insert_after = options.get(previous);
    try {
      const option = await request(`/custom_fields/${ASANA_CYCLE_FIELD_GID}/enum_options`, "POST", payload);
      if (!option?.gid) throw new Error("Asana returned no option id.");
      options.set(key, option.gid);
      added.push(label);
    } catch (error) {
      failed.push(label);
      log({ action: "asana_cycle_option_failed", label, error: error.message });
    }
  }
  return { options, added, failed };
}

// Sets the Cycle field on each pending (or previously failed) push, 10 per Asana batch. A push whose
// option does not exist fails instead of sending an empty update, which Asana would accept as a no-op.
export async function pushCycleField(request, pushes, options) {
  const results = pushes.map(push => ({ ...push }));
  const pending = results.filter(push => push.status === "pending" || push.status === "failed");
  if (!pending.length) return results;
  if (!request || !options) {
    pending.forEach(push => { push.status = "failed"; push.error = "Asana is not reachable."; });
    return results;
  }
  const sendable = [];
  for (const push of pending) {
    if (options.get(push.label.toLowerCase())) {
      sendable.push(push);
    } else {
      push.status = "failed";
      push.error = `Asana Cycle option ${push.label} is missing.`;
    }
  }
  for (let index = 0; index < sendable.length; index += 10) {
    const batch = sendable.slice(index, index + 10);
    const actions = batch.map(push => ({
      method: "put",
      relative_path: `/tasks/${push.asanaTaskGid}`,
      data: { custom_fields: { [ASANA_CYCLE_FIELD_GID]: options.get(push.label.toLowerCase()) } }
    }));
    try {
      const responses = await request("/batch", "POST", { actions });
      batch.forEach((push, i) => {
        const code = Number(responses?.[i]?.status_code || 500);
        push.status = code < 400 ? "pushed" : "failed";
        if (code >= 400) push.error = `Asana returned ${code}`;
        else delete push.error;
      });
    } catch (error) {
      batch.forEach(push => { push.status = "failed"; push.error = error.message; });
    }
  }
  return results;
}
