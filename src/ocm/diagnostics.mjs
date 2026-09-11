import { createHash, randomUUID } from "node:crypto";
import { join, posix } from "node:path";
import { runCommand } from "../commands.mjs";
import { collisionSafeArtifactName } from "../collectors/artifacts.mjs";
import { ocmEnvExec } from "./commands.mjs";
import { artifactExportArgs, exportOcmArtifact } from "./transport.mjs";

export const MAX_OCM_PROFILE_BYTES = 64 * 1024 * 1024;
export const MAX_OCM_REPORT_BYTES = 16 * 1024 * 1024;

export async function prepareOcmDiagnostics(envName, runId, options) {
  const relativeDir = `.kova-diagnostics/${createHash("sha256").update(`${runId}:${envName}`).digest("hex").slice(0, 24)}`;
  const result = await runCommand(ocmEnvExec(envName, [
    "node", "-e",
    'const fs=require("node:fs"),p=require("node:path");const root=process.env.OPENCLAW_HOME;if(!root||!p.isAbsolute(root))throw Error("missing environment home");fs.mkdirSync(p.join(root,process.argv[1],"node-profiles"),{recursive:true,mode:448});process.stdout.write(JSON.stringify({root}));',
    relativeDir
  ]), { timeoutMs: options.timeoutMs, env: options.env, maxOutputChars: 10000 });
  if (result.status !== 0 || result.outputBudget.truncated) {
    throw new Error(`OCM diagnostic staging failed: ${result.stderr || result.status}`);
  }
  const { root } = JSON.parse(result.stdout);
  if (typeof root !== "string" || !posix.isAbsolute(root) || root.includes("\0")) {
    throw new Error("OCM diagnostic staging returned an invalid environment home");
  }
  return {
    envName, root, relativeDir,
    timeline: posix.join(root, relativeDir, "timeline.jsonl"),
    nodeProfiles: posix.join(root, relativeDir, "node-profiles")
  };
}

export function relativeOcmArtifactPath(path, root) {
  if (typeof path !== "string") throw new Error("invalid OCM artifact path");
  const relative = path.startsWith("./") ? path.slice(2) :
    root && path.startsWith(`${root.replace(/\/+$/, "")}/`) ? path.slice(root.replace(/\/+$/, "").length + 1) : path;
  artifactExportArgs("validation", relative, 0);
  return relative;
}

export async function retainOcmArtifacts(envName, files, destinationDir, options) {
  const requests = [...new Set(files)].slice(0, options.limit ?? 25).map((file) => {
    const path = relativeOcmArtifactPath(file, options.root);
    return {
      path,
      target: join(destinationDir, collisionSafeArtifactName(path)),
      maxBytes: /\.heapsnapshot$|\.heapprofile$|\.cpuprofile$/i.test(path) ? MAX_OCM_PROFILE_BYTES : MAX_OCM_REPORT_BYTES
    };
  });
  return exportActiveOcmArtifacts(envName, requests, options);
}

export async function collectStagedOcmDiagnostics(envName, location, artifactDir, options) {
  if (!location) return { artifacts: [], artifactBytes: 0 };
  if (location.envName !== envName) throw new Error("OCM diagnostic staging belongs to another environment");
  const deadlineEpochMs = options.deadlineEpochMs ?? Date.now() + options.timeoutMs;
  const result = await runCommand(ocmEnvExec(envName, [
    "node", "-e",
    [
      'const fs=require("node:fs"),p=require("node:path");',
      'const root=process.env.OPENCLAW_HOME,dir=process.argv[1],files=[];',
      'const timeline=p.join(dir,"timeline.jsonl");',
      'if(fs.existsSync(p.join(root,timeline)))files.push(timeline);',
      'const profile=p.join(dir,"node-profiles");',
      'const names=fs.readdirSync(p.join(root,profile),{withFileTypes:true});',
      'for(const item of names){if(item.isFile()&&/\\.(cpuprofile|heapprofile|heapsnapshot|json)$/i.test(item.name))files.push(p.join(profile,item.name));if(files.length>101)throw Error("too many diagnostic artifacts");}',
      'process.stdout.write(JSON.stringify(files.sort()));'
    ].join(""),
    location.relativeDir
  ]), {
    env: options.env,
    timeoutMs: Math.max(1, deadlineEpochMs - Date.now()),
    maxOutputChars: 100000
  });
  if (result.status !== 0 || result.outputBudget.truncated) {
    throw new Error(`OCM diagnostic discovery failed: ${result.stderr || result.status}`);
  }
  const files = JSON.parse(result.stdout);
  if (!Array.isArray(files) || files.length > 101) throw new Error("invalid OCM diagnostic inventory");
  const requests = [];
  for (const file of [...new Set(files)]) {
    const path = relativeOcmArtifactPath(file);
    const timeline = path === `${location.relativeDir}/timeline.jsonl`;
    const profileName = posix.basename(path);
    if (!timeline && (posix.dirname(path) !== `${location.relativeDir}/node-profiles` ||
        !/\.(cpuprofile|heapprofile|heapsnapshot|json)$/i.test(profileName))) {
      throw new Error("OCM diagnostic inventory escaped the selected staging directory");
    }
    const target = timeline ? join(artifactDir, "openclaw", "timeline.jsonl") :
      join(artifactDir, "node-profiles", collisionSafeArtifactName(path));
    requests.push({
      path, target,
      maxBytes: !timeline && /report\..*\.json$|diagnostic.*\.json$/i.test(path) ? MAX_OCM_REPORT_BYTES : MAX_OCM_PROFILE_BYTES
    });
  }
  return (options.stopped ? exportRequests : exportActiveOcmArtifacts)(envName, requests, { ...options, deadlineEpochMs });
}

async function exportRequests(envName, requests, options) {
  const artifacts = [];
  let artifactBytes = 0;
  for (const request of requests) {
    const retained = await exportOcmArtifact(envName, request.path, request.target, {
      env: options.env, maxBytes: request.maxBytes, deadlineEpochMs: options.deadlineEpochMs
    });
    artifacts.push(retained.path);
    artifactBytes += retained.bytes;
  }
  return { artifacts, artifactBytes };
}

async function exportActiveOcmArtifacts(envName, requests, options) {
  if (requests.length === 0) return { artifacts: [], artifactBytes: 0 };
  const snapshotDir = `.kova-artifact-snapshots/${randomUUID()}`;
  const copies = requests.map((request, index) => {
    artifactExportArgs(envName, request.path, request.maxBytes);
    return {
      source: request.path,
      path: `${snapshotDir}/${index}/${posix.basename(request.path)}`,
      target: request.target,
      maxBytes: request.maxBytes
    };
  });
  // Capture only the bounded extent observed at open, so an append-only
  // producer need not stop. The closed copy is not an attestation of B's data.
  const snapshotScript = [
    'const fs=require("node:fs"),p=require("node:path");',
    'const root=process.env.OPENCLAW_HOME;if(fs.realpathSync(root)!==root)throw Error("snapshot home must not use symlinks");',
    'for(const item of JSON.parse(process.argv[1])){',
    'const source=p.join(root,item.source),target=p.join(root,item.path),max=item.maxBytes;',
    'if(fs.realpathSync(source)!==source)throw Error("snapshot source must not use symlinks");',
    'const input=fs.openSync(source,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);',
    'let output;',
    'try{const info=fs.fstatSync(input);if(!info.isFile()||info.nlink!==1||info.size>max)throw Error("snapshot source is not a bounded regular file");',
    'fs.mkdirSync(p.dirname(target),{recursive:true,mode:448});',
    'output=fs.openSync(target,"wx",384);',
    'const buffer=Buffer.alloc(65536);let remaining=info.size;',
    'while(remaining>0){const count=fs.readSync(input,buffer,0,Math.min(buffer.length,remaining),null);if(!count)throw Error("snapshot source truncated");',
    'let offset=0;while(offset<count)offset+=fs.writeSync(output,buffer,offset,count-offset);remaining-=count;}',
    '}finally{fs.closeSync(input);if(output!==undefined)fs.closeSync(output);}}'
  ].join("");
  let failure;
  try {
    const remainingMs = options.deadlineEpochMs - Date.now();
    if (remainingMs <= 0) throw new Error("OCM snapshot deadline expired");
    const captured = await runCommand(ocmEnvExec(envName, [
      "node", "-e", snapshotScript,
      JSON.stringify(copies.map(({ source, path, maxBytes }) => ({ source, path, maxBytes })))
    ]), { env: options.env, timeoutMs: remainingMs });
    if (captured.status !== 0) throw new Error(`OCM snapshot failed: ${captured.stderr || captured.status}`);
    return await exportRequests(envName, copies, options);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const remainingMs = options.deadlineEpochMs - Date.now();
    if (remainingMs <= 0) {
      throw new Error("OCM snapshot cleanup deadline expired; environment teardown required", { cause: failure });
    }
    const cleanup = await runCommand(ocmEnvExec(envName, [
      "node", "-e",
      'require("node:fs").rmSync(require("node:path").join(process.env.OPENCLAW_HOME,process.argv[1]),{recursive:true,force:true});',
      snapshotDir
    ]), { env: options.env, timeoutMs: remainingMs });
    if (cleanup.status !== 0) {
      throw new Error("OCM snapshot cleanup failed; environment teardown required", { cause: failure });
    }
  }
}
