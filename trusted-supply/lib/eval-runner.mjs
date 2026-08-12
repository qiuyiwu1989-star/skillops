import { createEvalResult, DEFAULT_EVAL_RESULT_LIMITS } from './eval-result.mjs';
import { evaluateAssertions, normalizeEvalSuite } from './eval-suite.mjs';

const PACKAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 120_000;

export class EvalRunnerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EvalRunnerError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new EvalRunnerError(code, message);
}

function timeout(value) {
  const resolved = value === undefined ? DEFAULT_TIMEOUT_MS : value;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > MAX_TIMEOUT_MS) {
    fail('invalid_timeout', `timeoutMs must be between 1 and ${MAX_TIMEOUT_MS}`);
  }
  return resolved;
}

function clockNow(clock) {
  const value = clock ? clock() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) fail('invalid_clock', 'clock must return a valid date');
  return date;
}

function publicEnvironment(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_environment', 'environment must be an object');
  try { return structuredClone(value); } catch { fail('invalid_environment', 'environment must be structured-cloneable'); }
}

function outputSummary(output, maximum = DEFAULT_EVAL_RESULT_LIMITS.maxOutputSummaryChars) {
  let rendered;
  if (typeof output === 'string') rendered = output;
  else {
    try { rendered = JSON.stringify(output); } catch { rendered = String(output); }
  }
  const chars = [...rendered];
  if (chars.length <= maximum) return rendered;
  return `${chars.slice(0, maximum - 1).join('')}…`;
}

function errorSummary(error, maximum = DEFAULT_EVAL_RESULT_LIMITS.maxErrorChars) {
  const message = error instanceof Error ? error.message : String(error || 'adapter error');
  return [...message].slice(0, maximum).join('') || 'adapter error';
}

function timeoutPromise(timeoutMs) {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new EvalRunnerError('case_timeout', `case exceeded ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
  });
}

async function runCase(evalCase, { executor, packageDigest, timeoutMs, clock }) {
  const started = clockNow(clock);
  try {
    const output = await Promise.race([
      Promise.resolve().then(() => executor({
        case: structuredClone(evalCase),
        package: Object.freeze({ packageDigest }),
        timeoutMs,
      })),
      timeoutPromise(timeoutMs),
    ]);
    const evaluated = evaluateAssertions(evalCase.assertions, output);
    const durationMs = Math.max(0, Math.round(clockNow(clock).getTime() - started.getTime()));
    return {
      id: evalCase.id,
      status: evaluated.passed ? 'passed' : 'failed',
      durationMs,
      assertions: evaluated.assertions,
      outputSummary: outputSummary(output),
      error: null,
    };
  } catch (error) {
    const durationMs = Math.max(0, Math.round(clockNow(clock).getTime() - started.getTime()));
    const status = error instanceof EvalRunnerError && error.code === 'case_timeout' ? 'timeout' : 'error';
    return {
      id: evalCase.id,
      status,
      durationMs,
      assertions: [],
      outputSummary: null,
      error: errorSummary(error),
    };
  }
}

export async function runEvalSuite({
  suite,
  packageDigest,
  packageAudit,
  executor,
  timeoutMs,
  runner,
  environment,
  clock,
} = {}) {
  const canonicalSuite = normalizeEvalSuite(suite);
  if (typeof packageDigest !== 'string' || !PACKAGE_DIGEST.test(packageDigest)) fail('invalid_package_digest', 'packageDigest must be sha256:<64 hex>');
  if (!packageAudit || packageAudit.status !== 'pass' || packageAudit.basedOnPackageDigest !== packageDigest) {
    fail('package_audit_required', 'runner requires a current passing full-package audit');
  }
  if (typeof executor !== 'function') fail('invalid_executor', 'executor must be an injected function');
  const resolvedTimeout = timeout(timeoutMs);
  const runnerIdentity = String(runner || executor.runner || '').trim();
  if (!runnerIdentity) fail('missing_runner', 'runner identity is required');
  const publicEnv = publicEnvironment(environment || executor.environment);
  const startedAt = clockNow(clock).toISOString();
  const cases = [];
  for (const evalCase of canonicalSuite.cases) {
    cases.push(await runCase(evalCase, {
      executor, packageDigest, timeoutMs: resolvedTimeout, clock,
    }));
  }
  const completedAt = clockNow(clock).toISOString();
  return createEvalResult({
    suiteId: canonicalSuite.suiteId,
    suiteVersion: canonicalSuite.suiteVersion,
    suiteDigest: canonicalSuite.suiteDigest,
    basedOnPackageDigest: packageDigest,
    runner: runnerIdentity,
    environment: publicEnv,
    cases,
    startedAt,
    completedAt,
  }, { suite: canonicalSuite, packageDigest });
}

export const EVAL_RUNNER_DEFAULT_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;
