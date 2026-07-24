import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { getDatabaseConfig } from "./config.js";

const { Client } = pg;
const sourceDir = path.resolve(process.argv[2] || process.env.CNC_RUNTIME_SOURCE_DIR || "");
const gcodeDir = path.join(sourceDir, "C - Endless Highways");

function normalizeProgramKey(value) {
  return String(value || "").trim().toLowerCase().replace(/[\s_-]+/g, " ");
}

function splitCsv(line) {
  const values = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      values.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  values.push(current.trim());
  return values;
}

function durationMinutes(value) {
  const match = String(value || "").match(/^(\d+):(\d{2}):(\d{2})$/);
  return match ? Number(match[1]) * 60 + Number(match[2]) + Number(match[3]) / 60 : null;
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function round(value) {
  return Math.round(Number(value) * 100) / 100;
}

async function filesUnder(directory, predicate) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(fullPath, predicate));
    else if (predicate(entry.name)) files.push(fullPath);
  }
  return files;
}

async function buildProfiles() {
  const gcodeFiles = await filesUnder(gcodeDir, file => file.toLowerCase().endsWith(".nc"));
  const profiles = new Map(gcodeFiles.map(file => {
    const programName = path.basename(file, ".nc");
    return [normalizeProgramKey(programName), {
      programKey: normalizeProgramKey(programName),
      programName,
      relativePath: path.relative(gcodeDir, file),
      attempts: []
    }];
  }));

  const historyFiles = await filesUnder(sourceDir, file => /^JobHistory-.*\.csv$/i.test(file));
  for (const historyFile of historyFiles) {
    const lines = (await fs.readFile(historyFile, "utf8")).split(/\r?\n/).filter(Boolean);
    const header = lines.findIndex(line => /^Job Name,Date,Time,Duration,/i.test(line));
    for (const line of lines.slice(header + 1)) {
      const [jobName, runDate, runTime, duration, cutLength, , comments] = splitCsv(line);
      const program = profiles.get(normalizeProgramKey(path.basename(jobName, ".nc")));
      const minutes = durationMinutes(duration);
      if (!program || minutes === null) continue;
      const startedAt = new Date(`${runDate} ${runTime}`);
      program.attempts.push({
        minutes,
        cutLength: Number(cutLength) || 0,
        normal: /ended normally/i.test(comments || ""),
        startedAt: Number.isNaN(startedAt.getTime()) ? null : startedAt
      });
    }
  }

  return [...profiles.values()]
    .map(profile => {
      const normalRuns = profile.attempts.filter(attempt => attempt.normal);
      if (!normalRuns.length) return null;
      const minutes = normalRuns.map(attempt => attempt.minutes);
      const latest = [...normalRuns].sort((left, right) => right.startedAt - left.startedAt)[0];
      return {
        ...profile,
        completedRunCount: normalRuns.length,
        totalAttemptCount: profile.attempts.length,
        nonNormalAttemptCount: profile.attempts.length - normalRuns.length,
        estimatedRuntimeMinutes: round(median(minutes)),
        averageRuntimeMinutes: round(minutes.reduce((sum, value) => sum + value, 0) / minutes.length),
        medianRuntimeMinutes: round(median(minutes)),
        minimumRuntimeMinutes: round(Math.min(...minutes)),
        maximumRuntimeMinutes: round(Math.max(...minutes)),
        averageCutLengthMeters: round(normalRuns.reduce((sum, run) => sum + run.cutLength, 0) / normalRuns.length),
        lastNormalRunAt: latest?.startedAt || null,
        confidence: normalRuns.length >= 5 ? "high" : normalRuns.length >= 2 ? "medium" : "single"
      };
    })
    .filter(Boolean);
}

async function main() {
  if (!sourceDir || !await fs.stat(gcodeDir).then(stat => stat.isDirectory()).catch(() => false)) {
    throw new Error("Pass the CNC LOGS folder path (containing C - Endless Highways and JobHistory-*.csv files).");
  }
  const profiles = await buildProfiles();
  const client = new Client(getDatabaseConfig({ useSyncUrl: true }));
  await client.connect();
  try {
    await client.query("begin");
    for (const profile of profiles) {
      await client.query(`
        insert into hb.cnc_program_runtime_profiles (
          program_key, program_name, gcode_relative_path,
          completed_run_count, total_attempt_count, non_normal_attempt_count,
          estimated_runtime_minutes, average_runtime_minutes, median_runtime_minutes,
          minimum_runtime_minutes, maximum_runtime_minutes, average_cut_length_meters,
          last_normal_run_at, confidence, source_system, source_loaded_at, updated_at
        ) values (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
          'de_job_history', now(), now()
        )
        on conflict (program_key) do update set
          program_name = excluded.program_name,
          gcode_relative_path = excluded.gcode_relative_path,
          completed_run_count = excluded.completed_run_count,
          total_attempt_count = excluded.total_attempt_count,
          non_normal_attempt_count = excluded.non_normal_attempt_count,
          estimated_runtime_minutes = excluded.estimated_runtime_minutes,
          average_runtime_minutes = excluded.average_runtime_minutes,
          median_runtime_minutes = excluded.median_runtime_minutes,
          minimum_runtime_minutes = excluded.minimum_runtime_minutes,
          maximum_runtime_minutes = excluded.maximum_runtime_minutes,
          average_cut_length_meters = excluded.average_cut_length_meters,
          last_normal_run_at = excluded.last_normal_run_at,
          confidence = excluded.confidence,
          source_system = excluded.source_system,
          source_loaded_at = now(),
          updated_at = now()
      `, [
        profile.programKey, profile.programName, profile.relativePath,
        profile.completedRunCount, profile.totalAttemptCount, profile.nonNormalAttemptCount,
        profile.estimatedRuntimeMinutes, profile.averageRuntimeMinutes, profile.medianRuntimeMinutes,
        profile.minimumRuntimeMinutes, profile.maximumRuntimeMinutes, profile.averageCutLengthMeters,
        profile.lastNormalRunAt, profile.confidence
      ]);
    }
    await client.query("commit");
    console.log(JSON.stringify({ importedProfiles: profiles.length }, null, 2));
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
