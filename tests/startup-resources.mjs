import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:http';
import { collectReadinessMetrics } from '../src/collectors/readiness.mjs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadScenarios } from '../src/registries/scenarios.mjs';
import { metricOptions } from '../src/run/metric-options.mjs';
import { executeScenarioPhase } from '../src/run/scenario-phase.mjs';
import { runWithCommandEnv } from '../src/commands.mjs';
import { startStartupResourceSampler } from '../src/collectors/startup-resources.mjs';
import { evaluateRecord } from '../src/evaluator.mjs';
import { renderMarkdownReport } from '../src/reporting/render-markdown-report.mjs';
import { collectResourceSummary } from '../src/evaluation/resources.mjs';

await mkdir(join(process.cwd(), '.openclaw/tmp'), { recursive: true });

const policy = { readiness: 'wait', healthSamples: false, collectors: Object.fromEntries(
  ['service','readiness','process','health','logs','openclaw-diagnostics','timeline','diagnostics','node-profiles','heap-snapshot','diagnostic-report'].map(id => [id, ['service','readiness'].includes(id)])) };

for (const mode of ['complete', 'readiness-timeout', 'readiness-identity-missing', 'gateway-identity-mismatch', 'collector-error', 'command-failed', 'throw', 'sampling-disabled', 'readiness-skipped']) test('phase startup boundary: ' + mode, { skip: process.platform !== 'linux' }, async () => {
  const root = await mkdtemp(join(process.cwd(), '.openclaw/tmp/startup-test-'));
  const envName = 'kova-startup-' + root.split('/').at(-1);
  const bin = join(root, 'bin');
  await mkdir(bin);
  const state = join(root, 'state.json');
  const admit = join(root, 'admit');
  const mark = join(root, 'ready.json');
  const gateway = join(root, 'gateway.mjs');
  await writeFile(gateway, [
    "import { createServer } from 'node:http';",
    "import { existsSync,writeFileSync } from 'node:fs';",
    'let readyAt;',
    'createServer((req,res)=>{const ready=existsSync('+JSON.stringify(admit)+'); if(ready&&!readyAt){readyAt=Date.now();writeFileSync('+JSON.stringify(mark)+',JSON.stringify({readyAt}));}res.writeHead(ready?200:503);res.end(JSON.stringify({ready}));}).listen(0,"127.0.0.1",function(){writeFileSync('+JSON.stringify(state)+',JSON.stringify({childPid:process.pid,gatewayPort:this.address().port,running:true}));});'
  ].join('\n'));
  await writeFile(join(bin, 'ocm'), [
    '#!'+process.execPath,
    "import {spawn} from 'node:child_process';import{existsSync,readFileSync}from'node:fs';",
    'const args=process.argv.slice(2);if(args[1]==="start"){const child=spawn(process.execPath,['+JSON.stringify(gateway)+'],{detached:true,stdio:"ignore"});child.unref();while(!existsSync('+JSON.stringify(state)+'))await new Promise(r=>setTimeout(r,10));console.log("{}");}else if(args[1]==="status")console.log(existsSync('+JSON.stringify(state)+')?readFileSync('+JSON.stringify(state)+',"utf8"):"{}");else if(args[1]==="install")console.log("{}");else process.exit(2);'
  ].join('\n').replace('else if(args[1]==="install")console.log("{}")', mode === 'command-failed' ? 'else if(args[1]==="install")process.exit(7)' : 'else if(args[1]==="install")console.log("{}")'), { mode: 0o755 });
  const env = { PATH: bin+':'+process.env.PATH, KOVA_HOME: join(root,'home') };
  let pid;
  try {
    const context = { timeoutMs: 5000, resourceSampleIntervalMs: 250, openclawDiagnostics: false, commandEnv: env, resourceSampling: mode !== "sampling-disabled" };
    const phase = { id:'provision', healthScope:'readiness', measurementScope:'product', commands:["ocm service start '" + envName + "' --json", "ocm service install '" + envName + "' --json"] };
    let gapStart, gapEnd;
    const execution = runWithCommandEnv(env, () => executeScenarioPhase(phase, context, envName, root, null, {
      timeoutMs:5000, readinessTimeoutMs:200, readinessIntervalMs:50, commandEnv:env, collectionPolicy:mode === "readiness-skipped" ? {...policy, readiness:"none"} : policy
    }, async (commandResult, index) => {
      assert.equal(commandResult.status,mode === "command-failed" && index === 1 ? 7 : 0,commandResult.stderr);
      if(index===0){({childPid:pid}=JSON.parse(await readFile(state,'utf8')));gapStart=Date.now();await new Promise(r=>setTimeout(r,600));gapEnd=Date.now();}
      else {
        if (mode === 'throw') throw new Error('phase interrupted');
        if (mode !== 'readiness-timeout') await writeFile(admit,'ready');
        if (mode === 'collector-error') await writeFile(state,'invalid JSON');
        if (mode === 'readiness-identity-missing' || mode === 'gateway-identity-mismatch') {
          const service=JSON.parse(await readFile(state,'utf8'));
          service.childPid=mode === 'readiness-identity-missing' ? null : process.pid;
          await writeFile(state,JSON.stringify(service));
        }
      }
    }));
    if (mode === 'throw') {
      await assert.rejects(execution,error => {
        assert.equal(error.message,'phase interrupted');
        assert.equal(error.startupResources.coverage.reason,'collector-error');
        return true;
      });
      const path=join(root,'resource-samples/provision-startup.jsonl');
      const saved=await readFile(path,'utf8');
      await new Promise(r=>setTimeout(r,300));
      assert.equal(await readFile(path,'utf8'),saved);
      return;
    }
    const result=await execution;
    if (mode === "sampling-disabled" || mode === "readiness-skipped") {
      assert.equal(result.startupResources,undefined);
      assert.equal(result.startupResourceExpected,undefined);
      return;
    }
    assert.equal(result.startupResourceExpected,true);
    if (mode !== 'complete') {
      assert.equal(result.startupResources.coverage.status,'incomplete');
      assert.equal(result.startupResources.coverage.reason,mode);
      const record={status:'PASS',scenario:'synthetic',phases:[result]};
      evaluateRecord(record,{id:'synthetic',thresholds:{}});
      assert.ok(record.violations.some(v=>v.metric==='startupResourceCoverage' && v.failureDomain==='kova-harness'));
      assert.equal(record.measurements.resourceSampleCount,result.results.reduce((n,r)=>n+r.resourceSamples.sampleCount,0));
      return;
    }
    const {readyAt}=JSON.parse(await readFile(mark,'utf8'));
    const startup=result.startupResources;
    assert.equal(startup.coverage.status,'complete',JSON.stringify(startup));
    assert.equal(startup.coverage.readyIdentity.pid,pid);
    assert.ok(Number.isSafeInteger(startup.coverage.readyIdentity.startTicks));
    const samples=(await readFile(startup.resources.artifactPath,'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(Date.parse(samples[0].timestamp)<=result.results[0].startedAtEpochMs);
    assert.ok(samples.some(s=>Date.parse(s.timestamp)>=gapStart&&Date.parse(s.timestamp)<=gapEnd&&s.processes.some(p=>p.pid===pid)),'inter-command gap must be sampled');
    assert.ok(Date.parse(samples.find(s=>s.cpuTerminal).timestamp)>=readyAt);
    assert.ok(samples.every(s=>s.rootPid===null && !s.processes.some(p=>p.roles.includes('command-tree'))));
    assert.ok(result.results[0].finishedAtEpochMs < readyAt);
    assert.equal(result.results[0].resourceSamples.cpuCoverageComplete,true);
    const commandOnly=collectResourceSummary(result.results);
    assert.equal(commandOnly.sampleCount,result.results.reduce((n,r)=>n+r.resourceSamples.sampleCount,0));
    assert.ok(!commandOnly.artifacts.includes(startup.resources.artifactPath));
    const record={status:'PASS',scenario:'synthetic',phases:[result]};
    evaluateRecord(record,{id:'synthetic',thresholds:{}});
    assert.ok(!record.violations?.some(v=>v.metric==='startupResourceCoverage'));
    assert.equal(record.measurements.startupResources[0].coverage.status,'complete');
    const markdown=renderMarkdownReport({records:[record]});
    assert.match(markdown,/Continuous Startup Resources/);
    assert.match(markdown,/not added to command budget samples/);
    assert.equal(record.measurements.resourceSampleCount,commandOnly.sampleCount);
    const terminal=await readFile(startup.resources.artifactPath,'utf8');
    await new Promise(r=>setTimeout(r,300));
    assert.equal(await readFile(startup.resources.artifactPath,'utf8'),terminal,'phase sampler stopped');
  } finally {
    if(!pid){try{({childPid:pid}=JSON.parse(await readFile(state,'utf8')));}catch{}}
    if(pid){try{process.kill(pid,'SIGTERM');}catch{}}
    await rm(root,{recursive:true,force:true});
  }
});

for (const kind of ['resource-collection-error', 'unsupported-platform']) test('startup records '+kind, async () => {
  const descriptor=Object.getOwnPropertyDescriptor(process,'platform');
  if(kind==='unsupported-platform') Object.defineProperty(process,'platform',{...descriptor,value:'darwin'});
  try {
    const sampler=startStartupResourceSampler({ processLister: () => {
      if(kind==='resource-collection-error') throw new Error('census denied');
      return {ok:true,processes:[]};
    } });
    const outcome={readiness:{ready:true,processIdentity:{pid:1,startTicks:1},identityMatched:true}};
    const first=sampler.stop(outcome);
    assert.equal(sampler.stop({}),first,'stop is idempotent');
    const evidence=await first;
    assert.equal(evidence.coverage.status,kind === 'unsupported-platform' ? 'not-applicable' : 'incomplete');
    assert.equal(evidence.coverage.reason,kind);
    const record={status:'PASS',scenario:'synthetic',phases:[{id:'provision',startupResources:evidence}]};
    evaluateRecord(record,{id:'synthetic',thresholds:{}});
    assert.equal(record.status,kind === 'unsupported-platform' ? 'PASS' : 'BLOCKED');
    if(kind === 'unsupported-platform') assert.match(renderMarkdownReport({records:[record]}),/not-applicable: unsupported-platform/);
  } finally {
    Object.defineProperty(process,'platform',descriptor);
  }
});

test('expected but missing startup evidence blocks without changing command budgets', () => {
  const record={status:'PASS',scenario:'synthetic',phases:[{id:'provision',startupResourceExpected:true,results:[]}]};
  evaluateRecord(record,{id:'synthetic',thresholds:{}});
  assert.equal(record.status,'BLOCKED');
  assert.ok(record.violations.some(v=>v.metric==='startupResourceCoverage'));
  assert.equal(record.measurements.resourceSampleCount,0);
});

test('readiness binds both PID and start ticks across the successful HTTP probe', {skip:process.platform!=='linux'}, async (t) => {
  let replaced=false;
  const server=createServer((_req,res)=>{replaced=true;res.end(JSON.stringify({ready:true}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const original=fs.readFileSync;
  const mock=t.mock.method(fs,'readFileSync',(path,...args)=>{
    const result=original(path,...args);
    if(path !== '/proc/'+process.pid+'/stat' || !replaced) return result;
    const text=String(result);const end=text.lastIndexOf(')')+2;
    const fields=text.slice(end).trim().split(/\s+/);
    fields[19]=String(Number(fields[19])+1);
    return text.slice(0,end)+fields.join(' ');
  });
  syncBuiltinESMExports();
  try {
    const readiness=await collectReadinessMetrics(server.address().port,{
      gatewayPid:process.pid,timeoutMs:1000,probeTimeoutMs:1000,intervalMs:50
    });
    assert.equal(readiness.ready,true,'HTTP readiness is separate from startup identity proof');
    assert.equal(readiness.processIdentity.pid,process.pid);
    assert.equal(readiness.identityMatched,false,'a recycled PID is not the same Gateway');
    const sampler=startStartupResourceSampler({processLister:()=>({ok:true,processes:[]})});
    assert.equal((await sampler.stop({readiness})).coverage.reason,'readiness-identity-mismatch');
  } finally {
    mock.mock.restore();syncBuiltinESMExports();
    await new Promise(resolve=>server.close(resolve));
  }
});

test('startup peaks never dilute or double-count existing command budget gates', () => {
  const command={status:0,command:'synthetic',resourceSampleExpected:true,resourceSamples:{
    sampleCount:2,cpuMeasurementContract:process.platform==='linux'?'linux-process-interval-v1':'ps-process-cpu-v1',cpuCoverageComplete:true,
    maxTotalCpuPercent:150,maxTotalCpuPercentLower:150,peakTotalRssMb:20,
    byRole:{gateway:{maxCpuPercent:150,maxCpuPercentLower:150,peakRssMb:20}}
  }};
  const record={status:'PASS',scenario:'synthetic',phases:[{id:'provision',measurementScope:'product',results:[command]}]};
  const startupRecord=structuredClone(record);
  startupRecord.phases[0].startupResourceExpected=true;
  startupRecord.phases[0].startupResources={coverage:{status:'complete'},resources:{sampleCount:9000,maxTotalCpuPercent:9999,peakTotalRssMb:9999}};
  const scenario={id:'synthetic',thresholds:{cpuPercentMax:100}};
  evaluateRecord(record,scenario);
  evaluateRecord(startupRecord,scenario);
  assert.deepEqual(startupRecord.violations,record.violations);
  assert.ok(record.violations.some(v=>v.metric==='cpuPercentMax'));
  assert.equal(startupRecord.measurements.resourceSampleCount,2);
  assert.equal(startupRecord.measurements.cpuPercentMax,150);
  assert.deepEqual(startupRecord.thresholdPolicy,record.thresholdPolicy);
});

test('ending without readiness records incomplete coverage', async () => {
  const sampler=startStartupResourceSampler({processLister:()=>({ok:true,processes:[]})});
  assert.equal((await sampler.stop()).coverage.reason,'readiness-missing');
});


test('registry-declared readiness phases receive a startup observation deadline', async () => {
  const scenarios=await loadScenarios();
  const selected=[];
  for(const scenario of scenarios) for(const phase of scenario.phases) {
    if(phase.healthScope !== 'readiness' || !phase.commands.length || phase.commands.some(c=>/(?:^|\s)--no-service(?:\s|$)/.test(c))) continue;
    const options=metricOptions({timeoutMs:120000},scenario,phase,'.',{resultStatus:'success'});
    if(options.collectionPolicy.readiness === 'none' || options.collectionPolicy.collectors.service === false) continue;
    assert.ok(options.readinessTimeoutMs > 0,scenario.id+'/'+phase.id);
    selected.push(scenario.id+'/'+phase.id);
  }
  assert.ok(selected.includes('workspace-scan-pressure/restart-after-workspace'));
  assert.ok(selected.includes('cross-platform-smoke/platform'));
  const scenario={thresholds:{gatewayReadyMs:1234}};
  for(const phase of [{id:'traffic',healthScope:'post-ready',commands:['status']},
    {id:'custom',healthScope:'readiness',commands:['start --no-service']}]) {
    assert.equal(metricOptions({},scenario,phase,'.').readinessTimeoutMs,0);
  }
});


test('complete startup scenario runs with isolated path initialization', { skip: process.platform !== 'linux' }, () => {
  const env = { ...process.env };
  // Node otherwise treats this as recursive test discovery and runs no tests.
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', new URL('./startup-runner.mjs', import.meta.url).pathname], {
    encoding: 'utf8', timeout: 30000, env
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /# pass 1\b/);
});
