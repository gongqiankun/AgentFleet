import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {open} from 'node:fs/promises';
import {join} from 'node:path';
import {loadRuntimeProfile} from './runtime-profile.js';
import {readUpdateTransaction,workerHealthDiagnostics} from './supervisor.js';
import {getUserServiceStatus} from './service.js';

/** Bounded, read-only operational evidence; never includes command lines, tokens or account files. */
export async function collectServiceDiagnostics(dataDir: string): Promise<Record<string,unknown>> {
  const profile=await loadRuntimeProfile(dataDir);
  const transaction=await readUpdateTransaction(dataDir);
  const report:Record<string,unknown>={worker:await workerHealthDiagnostics(dataDir),
    savedRuntime:profile ? {source:profile.source,executable:profile.codexExecutable}:null,
    update:transaction ? {phase:transaction.phase,targetVersion:transaction.targetVersion,targetRuntimeVersion:transaction.targetRuntimeVersion,startedAt:transaction.startedAt,error:transaction.error}:null};
  if(profile) {
    try {const {stdout}=await promisify(execFile)(profile.codexExecutable,['--version'],{timeout:5000,maxBuffer:4096,windowsHide:true});report.savedRuntimeVersion=/^codex-cli (\d+\.\d+\.\d+)\s*$/.exec(stdout)?.[1]??'unrecognized';}
    catch {report.savedRuntimeVersion='unavailable';}
  }
  if(process.platform !== 'win32')return report;
  try {report.service=await getUserServiceStatus();} catch {report.service={available:false};}
  const script=`$ErrorActionPreference='Stop'
$tasks=@(Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskName -in @('AgentFleet','AgentFleet-Background') } | Select-Object TaskName,State)
$processes=@(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='cmd.exe' OR Name='powershell.exe' OR Name='codex.exe'" | Where-Object { $_.CommandLine -like '*agentfleet*' -or $_.Name -eq 'codex.exe' } | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath)
@{tasks=$tasks;processes=$processes} | ConvertTo-Json -Depth 4 -Compress`;
  try {const {stdout}=await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{timeout:10000,maxBuffer:32768,windowsHide:true});report.windows=JSON.parse(stdout);}
  catch {report.windows={available:false};}
  // Only retain known Agent operational failures, not arbitrary child/tool logs.
  const failures:string[]=[];
  for(const suffix of ['.log','.error.log']) {
    let file;
    try {file=await open(join(dataDir,'agentfleet-service.cmd'+suffix),'r');const size=(await file.stat()).size;const bytes=Buffer.alloc(Math.min(size,8192));await file.read(bytes,0,bytes.length,Math.max(0,size-bytes.length));
      failures.push(...bytes.toString('utf8').split(/\r?\n/).filter(line=>/^(RUNTIME_ALREADY_RUNNING|PROCESS_IDENTITY_UNAVAILABLE|UPDATE_STATE_INVALID|ROLLBACK_BACKUP_MISSING|SERVICE_EXECUTABLE_UNSAFE):/.test(line)).map(line=>line.slice(0,300)).slice(-8));}
    catch { /* Diagnostics must not prevent a connected worker from serving requests. */ }
    finally {await file?.close();}
  }
  report.recentOperationalFailures=failures.slice(-8);
  return report;
}
