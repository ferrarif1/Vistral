import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strict as assert } from 'node:assert';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const readText = (...parts: string[]): string => readFileSync(join(rootDir, ...parts), 'utf8');

const assertIncludes = (text: string, expected: string, label: string) => {
  assert.ok(text.includes(expected), `expected ${label}: ${expected}`);
};

const assertMatches = (text: string, pattern: RegExp, label: string) => {
  assert.match(text, pattern, `expected ${label}`);
};

const packageJson = JSON.parse(readText('package.json')) as {
  scripts?: Record<string, string>;
};
const scripts = packageJson.scripts ?? {};

assert.equal(
  scripts['smoke:plan-llm-complete'],
  'bash scripts/smoke-plan-llm-complete.sh',
  'smoke:plan-llm-complete command should stay wired to the report-writing shell smoke'
);
assert.equal(
  scripts['smoke:plan-llm-complete:self-test'],
  'PLAN_LLM_REPORT_SELF_TEST=true bash scripts/smoke-plan-llm-complete.sh',
  'smoke:plan-llm-complete:self-test command should keep exercising report plumbing'
);
assert.equal(
  scripts['smoke:plan-llm-ci-workflow'],
  'tsx scripts/smoke-plan-llm-ci-workflow.ts',
  'smoke:plan-llm-ci-workflow command should point at this guard'
);

const workflowPath = join(rootDir, '.github/workflows/plan-llm-complete.yml');
assert.ok(existsSync(workflowPath), 'expected plan-llm-complete workflow file');
const workflow = readText('.github/workflows/plan-llm-complete.yml');

assertIncludes(workflow, 'workflow_dispatch:', 'manual workflow trigger');
assertMatches(workflow, /schedule:\s*\n\s*-\s*cron:\s*['"][^'"]+['"]/, 'nightly schedule trigger');
assertIncludes(workflow, 'runs-on: ubuntu-latest', 'GitHub hosted runner');
assertIncludes(workflow, 'PLAN_LLM_REPORT_RETAIN:', 'report retention env');
assertIncludes(workflow, 'PLAN_LLM_REPORT_DIR: .data/verify-reports', 'report directory env');
assertIncludes(workflow, "PLAN_LLM_RUNTIME_CACHE_VERSION: 'v1'", 'runtime cache version env');
assertIncludes(workflow, 'VISTRAL_PYTHON_BIN: .data/runtime-python/.venv/bin/python', 'runtime python env');
assertIncludes(workflow, 'YOLO_LOCAL_MODEL_PATH: .data/runtime-models/yolo11n.pt', 'runtime yolo env');
assertIncludes(workflow, 'uses: actions/checkout@v4', 'checkout step');
assertIncludes(workflow, 'uses: actions/setup-node@v4', 'setup-node step');
assertIncludes(workflow, "node-version: '22'", 'Node 22 setup');
assertIncludes(workflow, 'cache: npm', 'npm cache setup');
assertIncludes(workflow, 'run: npm ci', 'dependency install');
assertIncludes(workflow, 'uses: actions/cache@v4', 'runtime cache action');
assertIncludes(workflow, '.data/runtime-python/.venv', 'runtime venv cache path');
assertIncludes(workflow, '.data/runtime-models', 'runtime models cache path');
assertIncludes(workflow, 'npm run doctor:real-training-readiness', 'runtime readiness doctor');
assertIncludes(workflow, 'npm run setup:real-training-env', 'runtime readiness setup');
assertIncludes(workflow, '## Runtime readiness', 'runtime readiness step summary');
assertIncludes(workflow, 'run: npm run smoke:plan-llm-complete', 'long smoke command');
assertIncludes(workflow, 'if: always()', 'always upload reports');
assertIncludes(workflow, 'uses: actions/upload-artifact@v4', 'artifact upload action');
assertIncludes(workflow, 'name: plan-llm-complete-reports', 'artifact name');
assertIncludes(workflow, '.data/verify-reports/plan-llm-complete-*.json', 'JSON artifact path');
assertIncludes(workflow, '.data/verify-reports/plan-llm-complete-*.md', 'Markdown artifact path');
assertIncludes(workflow, '.data/verify-reports/plan-llm-complete-*.log', 'log artifact path');
assertIncludes(workflow, 'if-no-files-found: warn', 'artifact fallback policy');

const timeoutMatch = workflow.match(/timeout-minutes:\s*(\d+)/);
assert.ok(timeoutMatch, 'expected workflow timeout-minutes');
assert.ok(Number(timeoutMatch[1]) >= 120, 'expected timeout-minutes to allow the full smoke to finish');

const retentionMatch = workflow.match(/retention-days:\s*(\d+)/);
assert.ok(retentionMatch, 'expected artifact retention-days');
assert.ok(Number(retentionMatch[1]) >= 7, 'expected artifact retention of at least seven days');

const smokeShell = readText('scripts/smoke-plan-llm-complete.sh');
assertIncludes(smokeShell, 'PLAN_LLM_REPORT_DIR', 'report dir override');
assertIncludes(smokeShell, 'PLAN_LLM_REPORT_RETAIN', 'report retention override');
assertIncludes(smokeShell, 'PLAN_LLM_REPORT_SELF_TEST', 'self-test mode');
assertIncludes(smokeShell, 'REPORT_JSON_PATH', 'JSON report path');
assertIncludes(smokeShell, 'REPORT_MD_PATH', 'Markdown report path');
assertIncludes(smokeShell, 'REPORT_LOG_PATH', 'log report path');
assertIncludes(smokeShell, 'trap cleanup EXIT', 'failure report trap');
assertMatches(smokeShell, /plan-llm-complete-\\d\{14\}/, 'fixed report basename matcher');
assertIncludes(smokeShell, 'finalize_report "failed"', 'failed report finalization');
assertIncludes(smokeShell, 'finalize_report "passed"', 'passed report finalization');
assertIncludes(smokeShell, 'run_step "smoke:vision-task-closure"', 'vision-task closure included in plan-llm smoke');

const reportDir = mkdtempSync(join(tmpdir(), 'vistral-plan-llm-ci-'));
try {
  const oldGroups = ['20260422000000', '20260422010000', '20260422020000'];
  oldGroups.forEach((timestamp, index) => {
    for (const ext of ['json', 'md', 'log']) {
      const file = join(reportDir, `plan-llm-complete-${timestamp}.${ext}`);
      writeFileSync(file, `old ${timestamp}.${ext}\n`);
      const mtime = new Date(Date.UTC(2026, 3, 22, index, 0, 0));
      utimesSync(file, mtime, mtime);
    }
  });

  const result = spawnSync('bash', ['scripts/smoke-plan-llm-complete.sh'], {
    cwd: rootDir,
    env: {
      ...process.env,
      PLAN_LLM_REPORT_SELF_TEST: 'true',
      PLAN_LLM_REPORT_DIR: reportDir,
      PLAN_LLM_REPORT_RETAIN: '2',
      PLAN_LLM_REPORT_TIMESTAMP: '20260423000000'
    },
    encoding: 'utf8'
  });

  assert.equal(
    result.status,
    0,
    `self-test should pass\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );

  const currentBase = 'plan-llm-complete-20260423000000';
  const currentJson = join(reportDir, `${currentBase}.json`);
  const currentMd = join(reportDir, `${currentBase}.md`);
  const currentLog = join(reportDir, `${currentBase}.log`);
  assert.ok(existsSync(currentJson), 'expected self-test JSON report');
  assert.ok(existsSync(currentMd), 'expected self-test Markdown report');
  assert.ok(existsSync(currentLog), 'expected self-test log report');

  const report = JSON.parse(readFileSync(currentJson, 'utf8')) as {
    id?: string;
    status?: string;
    checks_total?: number;
    checks_failed?: number;
    log_path?: string;
  };
  assert.equal(report.id, currentBase);
  assert.equal(report.status, 'passed');
  assert.equal(report.checks_total, 1);
  assert.equal(report.checks_failed, 0);
  assert.equal(report.log_path, join(reportDir, `${currentBase}.log`));

  const retainedGroups = new Set(
    readdirSync(reportDir)
      .map((filename) => filename.match(/^(plan-llm-complete-\d{14})\.(json|md|log)$/)?.[1])
      .filter((basename): basename is string => Boolean(basename))
  );
  assert.ok(retainedGroups.has(currentBase), 'expected current self-test report group to be retained');
  assert.ok(retainedGroups.size <= 2, 'expected report retention to prune stale groups');
} finally {
  rmSync(reportDir, { recursive: true, force: true });
}

console.log('[smoke-plan-llm-ci-workflow] PASS');
