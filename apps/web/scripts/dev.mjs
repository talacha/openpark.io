import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const webRoot = fileURLToPath(new URL('../', import.meta.url));
const apiRoot = fileURLToPath(new URL('../../api/', import.meta.url));
const children = new Set();
let stopping = false;
let shutdownPromise;

function stop(exitCode) {
  if (shutdownPromise) return shutdownPromise;
  stopping = true;
  shutdownPromise = (async () => {
    const exits = [...children].map((child) => new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.once('exit', resolve);
      child.kill('SIGTERM');
    }));
    const force = setTimeout(() => {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    }, 5000);
    await Promise.all(exits);
    clearTimeout(force);
    process.exit(exitCode);
  })();
  return shutdownPromise;
}

function start(label, args, cwd) {
  const child = spawn(process.execPath, args, { cwd, env: process.env, stdio: 'inherit' });
  children.add(child);
  child.once('error', (error) => {
    children.delete(child);
    console.error(`[${label}] failed to start: ${error.message}`);
    void stop(1);
  });
  child.once('exit', (code, signal) => {
    children.delete(child);
    if (!stopping) {
      if (code || signal) console.error(`[${label}] exited (${signal ?? code}); stopping the preview`);
      void stop(code ?? 1);
    }
  });
}

process.on('SIGINT', () => { void stop(0); });
process.on('SIGTERM', () => { void stop(0); });

start('api', ['--import', 'tsx', 'src/main.ts'], apiRoot);
start('web', ['node_modules/vite/bin/vite.js', ...process.argv.slice(2)], webRoot);
