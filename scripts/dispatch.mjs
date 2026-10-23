#!/usr/bin/env node
// OpenPark SDLC dispatcher / controller.
// Spawns sub-agents for SDLC task types and enforces the review gate before merge.
// Safety: merge and deploy require explicit human confirmation; never force-push; never deploy to prod autonomously.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const TASKS_DIR = join(ROOT, '.agents', 'tasks');

const TASK_TYPES = {
  plan: 'Break a goal into ordered, verifiable SDLC tasks.',
  implement: 'Write code + tests for an approved plan.',
  review: 'Read-only adversarial review of a diff + verification evidence.',
  verify: 'Run the local verification gate (build, typecheck, test, check:css).',
  merge: 'Fast-forward onto main and push (human-gated).',
  deploy: 'Trigger production deploy (human-gated; Vercel auto-deploys main).',
};

export function listTaskTypes() {
  return Object.entries(TASK_TYPES).map(([k, v]) => `  ${k}: ${v}`).join('\n');
}

export function taskDir(slug) {
  return join(TASKS_DIR, slug);
}

export function ensureTaskDir(slug) {
  const d = taskDir(slug);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}

export function writeTask(slug, spec) {
  const d = ensureTaskDir(slug);
  writeFileSync(join(d, 'spec.md'), spec.specMd || '');
  writeFileSync(join(d, 'status.json'), JSON.stringify({ ...spec.status, updatedAt: new Date().toISOString() }, null, 2));
  return d;
}

export function readStatus(slug) {
  const p = join(taskDir(slug), 'status.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

export function gateCommands() {
  return [
    'pnpm --filter @openpark/core build',
    'pnpm typecheck',
    'pnpm test',
    'pnpm --filter @openpark/web check:css',
  ];
}

export function mergeRequirements() {
  return [
    'review-verdict.json verdict == APPROVED',
    'gate: ' + gateCommands().join(' && '),
    'commit identity: git -c user.email=r@rob.cr commit (no AI attribution lines)',
    'fast-forward onto main; normal push; never force-push',
  ];
}

export function deployRequirements() {
  return [
    'merge already completed and pushed to origin/main',
    'EXPLICIT HUMAN CONFIRMATION required before deploy',
    'Vercel auto-deploys main to: marketing (www.openpark.io), app (app.openpark.io), API (api.openpark.io)',
    'repo secrets API_URL and CRON_SECRET must exist for the 5-minute pass-reminder cron',
  ];
}

export function dispatch(taskType, description, extra = {}) {
  if (!TASK_TYPES[taskType]) {
    console.error(`Unknown task type "${taskType}". Available:\n${listTaskTypes()}`);
    process.exit(1);
  }
  const slug = `${taskType}-${Date.now().toString(36)}`;
  const status = { taskType, description, status: 'queued', ...extra, slug, createdAt: new Date().toISOString() };
  writeTask(slug, { specMd: extra.specMd || '', status });
  console.log(`Dispatched ${taskType} task: ${slug}`);
  console.log(`  ${description}`);
  console.log(`  Task dir: ${taskDir(slug)}`);
  return slug;
}

const [, , taskType, description] = process.argv;
if (taskType) {
  dispatch(taskType, description);
} else {
  console.log('OpenPark SDLC dispatcher. Usage: node scripts/dispatch.mjs <task-type> <description>');
  console.log(listTaskTypes());
}
