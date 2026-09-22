/**
 * Config-evals runner — regression tests for the agent CONFIG
 * (CLAUDE.md / AGENTS.md / .claude/**), not for the model.
 *
 *   npm run ai:eval:config            # all cases
 *   npm run ai:eval:config -- --id=skill-write-needs-approval
 *
 * Spawns `claude -p` per case with the repo root as cwd so the CLI loads the
 * instruction files and skills under test, read-only tools only, and applies
 * the case's regex assertions to the final response. Prints a pass/fail
 * matrix; exits non-zero if any must-pass case fails. 'warn' cases report
 * but never gate.
 *
 * Local: uses the logged-in claude CLI. CI: set ANTHROPIC_API_KEY.
 * Model defaults to haiku (config comprehension is retrieval, not reasoning);
 * override with --model=… .
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_EVAL_CASES, type ConfigEvalCase } from './cases';

// ESM ("type":"module"): no __dirname — derive the repo root from this file's URL.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_MODEL = 'claude-haiku-4-5';
const DEFAULT_MAX_TURNS = 6;
const CASE_TIMEOUT_MS = 180_000;

interface StreamLine {
  type: string;
  message?: { content?: Array<{ type: string; text?: string }> };
}

interface CaseOutcome {
  evalCase: ConfigEvalCase;
  passed: boolean;
  failures: string[];
  response: string;
}

function argValue(flag: string): string | undefined {
  const arg = process.argv.find((a) => a.startsWith(`--${flag}=`));
  return arg?.split('=')[1];
}

function runCase(evalCase: ConfigEvalCase, model: string): CaseOutcome {
  let response = '';
  try {
    const stdout = execFileSync(
      'claude',
      [
        '-p',
        evalCase.prompt,
        '--output-format',
        'stream-json',
        '--verbose',
        '--model',
        model,
        '--max-turns',
        String(evalCase.maxTurns ?? DEFAULT_MAX_TURNS),
        '--allowedTools',
        // Skill is on the list so the model loads a skill the way a session
        // does. Without it, newer Claude Code versions leave the model to
        // guess that it should Read the SKILL.md file, and in the workflow it
        // sometimes did not (sandbox runs of 21 and 22 September 2026).
        'Read,Grep,Glob,Skill',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', timeout: CASE_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    // Assert over ALL assistant text, not the final `result`: this template's
    // Stop hook (skill-gap-reminder) makes the session answer, then emit a
    // hook-reflection message — with --output-format json the `result` field
    // is that last message, not the answer. Stray non-JSON warning lines are
    // skipped (seen when nested inside another Claude Code session).
    const texts: string[] = [];
    for (const line of stdout.split('\n')) {
      if (!line.startsWith('{')) continue;
      let parsed: StreamLine;
      try {
        parsed = JSON.parse(line) as StreamLine;
      } catch {
        continue;
      }
      if (parsed.type === 'assistant') {
        for (const block of parsed.message?.content ?? []) {
          if (block.type === 'text' && block.text) {
            texts.push(block.text);
          }
        }
      }
    }
    if (texts.length === 0) {
      return { evalCase, passed: false, failures: ['no assistant text in CLI output'], response: stdout.slice(0, 300) };
    }
    response = texts.join('\n');
  } catch (error) {
    return {
      evalCase,
      passed: false,
      failures: [`claude CLI failed: ${(error as Error).message.split('\n')[0]}`],
      response,
    };
  }

  const failures: string[] = [];
  for (const pattern of evalCase.mustMatch) {
    if (!new RegExp(pattern, 'i').test(response)) {
      failures.push(`missing /${pattern}/i`);
    }
  }
  // `forbidCodeOnly` narrows the forbidden patterns to fenced code — the code
  // the agent is proposing — so that citing an anti-pattern in prose to warn
  // against it does not fail an otherwise correct answer. See cases.ts.
  const forbidTarget = evalCase.forbidCodeOnly ? fencedCode(response) : response;
  for (const pattern of evalCase.mustNotMatch) {
    if (new RegExp(pattern, 'i').test(forbidTarget)) {
      failures.push(`forbidden /${pattern}/i matched`);
    }
  }
  return { evalCase, passed: failures.length === 0, failures, response };
}

/**
 * The fenced code blocks of a markdown response, joined. Empty string when the
 * response contains none — which is safe here because every `forbidCodeOnly`
 * case also carries a `mustMatch` the prose-only answer would have to satisfy.
 */
function fencedCode(markdown: string): string {
  const blocks = markdown.match(/```[\s\S]*?```/g);
  return blocks ? blocks.join('\n') : '';
}

/**
 * True when this checkout IS the template, not a project made from it: the
 * origin remote is named frontend-domain-sdlc-template, or the run sets
 * CONFIG_EVALS_TEMPLATE=1. Cases marked `templateOnly` run only then; every
 * project made from the template skips them (see the header of cases.ts).
 */
function isTemplateRepository(): boolean {
  if (process.env.CONFIG_EVALS_TEMPLATE === '1') return true;
  try {
    const remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const name = remote.replace(/\/+$/, '').split(/[/:]/).pop() ?? '';
    return name.replace(/\.git$/, '') === 'frontend-domain-sdlc-template';
  } catch {
    return false;
  }
}

function main(): void {
  const idFilter = argValue('id');
  const model = argValue('model') ?? DEFAULT_MODEL;
  const inTemplate = isTemplateRepository();
  const selected = CONFIG_EVAL_CASES.filter((c) => !idFilter || c.id === idFilter);
  const cases = selected.filter((c) => !c.templateOnly || inTemplate);
  const skipped = selected.length - cases.length;
  if (selected.length === 0) {
    console.error(`No cases match --id=${idFilter}`);
    process.exitCode = 2;
    return;
  }
  if (cases.length === 0) {
    console.log(`Skipped ${skipped} template-only case(s): this repository is not the template.`);
    return;
  }

  console.log(`Running ${cases.length} config eval case(s) with ${model}…`);
  if (skipped > 0) console.log(`Skipped ${skipped} template-only case(s): this repository is not the template.`);
  console.log('');
  const outcomes: CaseOutcome[] = [];
  for (const evalCase of cases) {
    const outcome = runCase(evalCase, model);
    outcomes.push(outcome);
    const mark = outcome.passed ? '✅' : outcome.evalCase.severity === 'must-pass' ? '❌' : '⚠️';
    console.log(`${mark} ${evalCase.id} [${evalCase.severity}]`);
    if (!outcome.passed) {
      for (const failure of outcome.failures) {
        console.log(`     ${failure}`);
      }
      console.log(`     guardedBy: ${evalCase.guardedBy}`);
      console.log(`     response: ${outcome.response.replace(/\s+/g, ' ').slice(0, 300)}`);
    }
  }

  const mustPassFailures = outcomes.filter((o) => !o.passed && o.evalCase.severity === 'must-pass');
  const warnFailures = outcomes.filter((o) => !o.passed && o.evalCase.severity === 'warn');
  console.log(
    `\n${outcomes.length - mustPassFailures.length - warnFailures.length}/${outcomes.length} passed` +
      ` (${mustPassFailures.length} must-pass failed, ${warnFailures.length} warnings)`,
  );
  if (mustPassFailures.length > 0) {
    process.exitCode = 1;
  }
}

main();
