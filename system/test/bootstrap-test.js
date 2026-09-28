'use strict';
// Runs the install bootstrap from real.js as root (no pkexec) against tampered stagings.
// Usage (non-privileged container): node bootstrap-test.js <repo>
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { makeManifest, INSTALL_BOOTSTRAP } = require(path.join(process.argv[2], 'app/main/services/real.js'));

const repo = process.argv[2];
let fail = 0;
function stage() {
  const d = fs.mkdtempSync('/tmp/ytu-stage-');
  execFileSync('cp', ['-R', path.join(repo, 'system'), path.join(repo, 'strategies'), d]);
  execFileSync('rm', ['-rf', path.join(d, 'system', 'test')]);
  return d;
}
function run(name, tamper, expect) {
  const d = stage();
  tamper(d);
  const r = spawnSync('/bin/sh', ['-c', INSTALL_BOOTSTRAP, 'x', d, manifest, '--no-deps'], { encoding: 'utf8' });
  const out = (r.stdout + r.stderr).trim().split('\n').slice(0, 2).join(' | ');
  const ok = expect.test(out);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${out}`);
  if (!ok) fail = 1;
}
let manifest;
(async () => {
  manifest = await makeManifest(repo);
  run('clean staging reaches install.sh', () => {}, /"event":"step","step":"requirements"/);
  run('symlinked helper refused', (d) => {
    fs.rmSync(path.join(d, 'system/bin/ytu-helper'));
    fs.symlinkSync('/etc/shadow', path.join(d, 'system/bin/ytu-helper'));
  }, /links or special files/);
  run('symlinked dir refused', (d) => {
    fs.rmSync(path.join(d, 'system/libexec'), { recursive: true });
    fs.symlinkSync('/etc', path.join(d, 'system/libexec'));
  }, /links or special files/);
  run('extra file refused', (d) => {
    fs.writeFileSync(path.join(d, 'system/vendor/zapret2/blockcheck2.d/standard/99-evil.sh'), 'id\n');
  }, /does not match the manifest/);
  run('modified install.sh refused', (d) => {
    fs.appendFileSync(path.join(d, 'system/install.sh'), '\nid >/tmp/pwned\n');
  }, /checksum mismatch/);
  console.log(fail ? 'SOME FAILED (bootstrap)' : 'ALL PASS (bootstrap)');
  process.exit(fail);
})();
