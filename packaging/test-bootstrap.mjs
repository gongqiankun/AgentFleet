import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
const release=resolve(process.argv[2] ?? 'output/baseline-01540');
const run=promisify(execFile),root=await mkdtemp(resolve('packaging/build')+'/fresh-01540-');
try {
 const cache=join(root,'managed'),stage=join(root,'tmp');await mkdir(cache);await mkdir(stage);
 const source=await readFile('packaging/install.sh','utf8');
 const prepare=source.slice(source.indexOf('prepare_managed_codex() {'),source.indexOf('\ntrap cleanup EXIT HUP INT TERM'));
 const helper=source.slice(source.indexOf('prepare_managed_sandbox_helper() {'),source.indexOf('prepare_managed_codex() {'));
 const selection=source.slice(source.indexOf('CODEX_BWRAP_VERSION=0.153.4\nif'),source.indexOf('\nSELECTED_CODEX_HOME='));
 const script=`set -eu\n${prepare}\n${helper}\ndownload() { cp "$RELEASE_DIR/\${1##*/}" "$2"; }\nprepare_managed_codex\n${selection}\ntest "$SELECTED_CODEX_VERSION" = 0.154.0\ntest "$CODEX_BWRAP_VERSION" = 0.154.0\nprintf 'fresh install: %s, helper: %s\\n' "$SELECTED_CODEX_VERSION" "$CODEX_BWRAP_VERSION"`;
 const result=await run('/bin/sh',['-c',script],{timeout:90000,env:{PATH:'/usr/bin:/bin',INSTALL_UID:'0',CODEX_CACHE_DIR:cache,CODEX_CACHE_EXECUTABLE:join(cache,'codex'),TEMP_DIR:stage,CONTROL_URL:'https://fixture.invalid',RELEASE_DIR:release,CODEX_COMPAT_SCHEMA_HASH:'d3eace08be5dca386bfd1f1e8df650058b4113f1e10870a284d775d75517576a',CODEX_BWRAP_SHA256:'77360cb751ccedc5971391444ac86a8a33c15b04d6b4a6fe45f5d25496e62c4c'}});
 assert.match(result.stdout,/fresh install: 0.154.0, helper: 0.154.0/);console.log(result.stdout);
 const mac=await readFile('packaging/install-macos.sh','utf8');
 const assignment=mac.split('\n').find(line=>line.trim().startsWith('CODEX_BLOCK='));
 for(const platform of ['darwin-arm64','darwin-x64']) {
  const parsed=await run('/bin/sh',['-c',assignment+'\nprintf \'%s\' \"$CODEX_BLOCK\"'],{env:{PATH:'/usr/bin:/bin',PLATFORM:platform,CODEX_COMPACT:(await readFile(join(release,'codex-manifest.json'),'utf8')).trim()}});
  assert.equal(JSON.parse('{'+parsed.stdout+'}').file,`codex-${platform}-0.154.0.tar.gz`);
 }
 console.log('Both macOS selectors choose the main archive, not Code Mode companions.');
}finally{await rm(root,{recursive:true,force:true});}
