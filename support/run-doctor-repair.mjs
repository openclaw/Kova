#!/usr/bin/env node
import { spawn } from "node:child_process";

const options = parseArgs(process.argv.slice(2));
const startedAt = Date.now();
const doctor = await runProcess("ocm", [`@${options.env}`, "--", "doctor", "--fix"]);
const durationMs = Date.now() - startedAt;
const combined = `${doctor.stdout}\n${doctor.stderr}`;
const unrepairedFindingCount = countUnrepairedFindings(combined, doctor.status);
const doctorFixSucceeded = doctor.status === 0 && unrepairedFindingCount === 0;

console.log(JSON.stringify({
  schemaVersion: "kova.doctorRepair.v1",
  durationMs,
  command: `ocm @${options.env} -- doctor --fix`,
  status: doctor.status,
  doctorFixSucceeded,
  doctorUnrepairedFindingCount: unrepairedFindingCount,
  stdoutSnippet: firstLines(doctor.stdout, 40),
  stderrSnippet: firstLines(doctor.stderr, 40),
  errors: doctorFixSucceeded ? [] : [failureSummary(doctor, unrepairedFindingCount)]
}, null, 2));

process.exit(doctorFixSucceeded ? 0 : 1);

function parseArgs(args) {
  const options = { env: null };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--env") {
      options.env = args[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`unexpected argument: ${arg}`);
  }
  if (!/^kova-[a-z0-9][a-z0-9-]*$/i.test(String(options.env ?? ""))) {
    throw new Error(`--env must be a disposable Kova env, got ${JSON.stringify(options.env)}`);
  }
  return options;
}

function runProcess(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => resolve({ status: 127, stdout, stderr: error.message }));
    child.on("close", (status) => resolve({ status: status ?? 1, stdout, stderr }));
  });
}

function countUnrepairedFindings(output, status) {
  const parsed = parsePossibleJson(output);
  if (typeof parsed?.doctorUnrepairedFindingCount === "number") {
    return parsed.doctorUnrepairedFindingCount;
  }
  if (typeof parsed?.unrepairedFindingCount === "number") {
    return parsed.unrepairedFindingCount;
  }
  for (const key of ["unrepaired", "failures", "errors"]) {
    if (Array.isArray(parsed?.[key])) {
      return parsed[key].length;
    }
  }

  const lines = String(output ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const unrepairedLines = lines.filter((line) =>
    /(unrepaired|not repaired|failed to repair|could not repair|cannot repair|unable to repair|manual action|required manual|requires manual|still failing)/i.test(line)
  );
  if (unrepairedLines.length > 0) {
    return unrepairedLines.length;
  }
  return status === 0 ? 0 : 1;
}

function parsePossibleJson(output) {
  const text = String(output ?? "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function firstLines(value, limit) {
  return String(value ?? "").split(/\r?\n/).slice(0, limit).join("\n");
}

function failureSummary(result, unrepairedFindingCount) {
  const line = firstNonEmptyLine(`${result.stderr}\n${result.stdout}`);
  if (unrepairedFindingCount > 0) {
    return `doctor left ${unrepairedFindingCount} unrepaired finding(s)${line ? `: ${line}` : ""}`;
  }
  return `doctor exited ${result.status}${line ? `: ${line}` : ""}`;
}

function firstNonEmptyLine(value) {
  return String(value ?? "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}
