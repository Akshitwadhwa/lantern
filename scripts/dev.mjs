import { spawn } from 'node:child_process';

const children = ['@together/server', '@together/client'].map((workspace) =>
  spawn('npm', ['run', 'dev', '--workspace', workspace], {
    stdio: 'inherit',
    env: process.env,
  }),
);

let stopping = false;

function stop() {
  if (stopping) {
    return;
  }
  stopping = true;
  for (const child of children) {
    child.kill('SIGTERM');
  }
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

for (const child of children) {
  child.on('exit', (code) => {
    stop();
    process.exit(code ?? 0);
  });
}
