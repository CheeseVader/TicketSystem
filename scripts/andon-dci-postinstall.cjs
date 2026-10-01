'use strict';
const { spawnSync } = require('child_process');

if (process.platform !== 'linux') {
  console.log('[ANDON network] postinstall Linux-only: skipped on ' + process.platform);
  process.exit(0);
}
if (typeof process.getuid === 'function' && process.getuid() !== 0) {
  console.log('[ANDON network] non-root Linux install: system network migration skipped.');
  process.exit(0);
}

const r = spawnSync('bash', ['scripts/andon-dci-network-core.sh'], {
  stdio: 'inherit'
});
if (r.error) {
  console.error(r.error.message);
  process.exit(20);
}
process.exit(Number.isInteger(r.status) ? r.status : 21);
