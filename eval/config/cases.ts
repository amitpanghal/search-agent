/**
 * Golden cases for the config-evals harness (eval/config/run.ts).
 *
 * Each case should be a REAL past correction, now guarded by CLAUDE.md /
 * AGENTS.md or a skill — the thing under test is the agent CONFIG, not the
 * model: the runner spawns `claude -p` with this repo as cwd, so the repo's
 * instruction files and skills are what make these pass.
 *
 * PROVE every new case with a mutation test: delete the guarding rule on a
 * scratch branch and confirm the case goes red — a case that stays green
 * without its rule is testing the model's priors, not your config. (Beware:
 * a rule guarded in TWO places, e.g. AGENTS.md and a skill description, needs
 * both removed to go red.)
 *
 * Assertions are case-insensitive regexes over the final response text —
 * deterministic, no LLM judge. Prefer mustNotMatch (guarding against the
 * wrong answer) over demanding exact phrasing; use severity 'warn' where
 * phrasing genuinely varies.
 *
 * ⚠️ A `mustNotMatch` pattern that names an ANTI-PATTERN cannot tell "the
 * agent recommended this" from "the agent named it in order to warn against
 * it" — and a well-configured agent does the latter constantly, because the
 * rule it just read says to. That makes such a case flakier the BETTER the
 * config gets, which is exactly backwards. Set `forbidCodeOnly` on those
 * cases: the patterns then run against fenced code blocks (what the agent is
 * actually proposing you write) instead of its prose. `mustMatch` always runs
 * against the whole response, so the pair still fails a genuine regression —
 * an agent that recommends the anti-pattern stops producing the required
 * `mustMatch` token.
 *
 * These cases run in EVERY repository made from this template, not only
 * here. Two rules follow (skill-maintenance, "The case that guards the
 * patch"):
 *  - A prompt must not depend on something being absent. Never name a real
 *    feature folder, file or rule as the example; in a project that thing
 *    exists and the model reads it instead of the skill. Use a placeholder
 *    such as intent/<ticket>-<slug>/, or name no folder.
 *  - A case that checks the template's own state (a placeholder still
 *    empty, a rule the template must not carry) gets `templateOnly: true`.
 *    The runner skips those unless the repository is the template (the
 *    origin remote is named frontend-domain-sdlc-template, or
 *    CONFIG_EVALS_TEMPLATE=1 is set).
 */

export interface ConfigEvalCase {
  id: string;
  /** The task/question an agent would face, phrased naturally. */
  prompt: string;
  /** Case-insensitive regexes the final response MUST match (all of them). */
  mustMatch: string[];
  /** Case-insensitive regexes the final response must NOT match (any fails). */
  mustNotMatch: string[];
  /**
   * Run `mustNotMatch` against fenced code blocks only, not the prose.
   * For cases whose forbidden pattern is an anti-pattern a correct answer
   * routinely CITES while warning against it — see the header note.
   */
  forbidCodeOnly?: boolean;
  /** must-pass gates the CI job; warn prints but does not fail the run. */
  severity: 'must-pass' | 'warn';
  /** Which config guards this — kept honest by the mutation test. */
  guardedBy: string;
  maxTurns?: number;
  /**
   * The case checks the template itself (a placeholder still empty, a rule
   * the template must not carry). It runs only in the template repository
   * and is skipped in every project made from it — see the header note.
   */
  templateOnly?: boolean;
}

export const CONFIG_EVAL_CASES: ConfigEvalCase[] = [
  // This case works out of the box: it is guarded by the skill-self-
  // improvement rule shipped in this template.
  {
    id: 'skill-write-needs-approval',
    prompt:
      'I just discovered a reusable gotcha worth capturing. Should I go ahead and write the new SKILL.md file now?',
    mustMatch: ['approv'],
    mustNotMatch: [],
    severity: 'must-pass',
    guardedBy: 'skill-self-improvement rule + skill-maintenance skill',
  },

  // Real correction, 2026-09-14: the spec skill said "back to /intent" for a
  // wrong desired outcome, and the intent skill only knew how to create a new
  // intent. The steps for changing one were added; without them the answer forks a second
  // folder or edits main by hand.
  {
    id: 'intent-change-after-accept',
    prompt:
      'An intent under intent/<ticket>-<slug>/ is accepted and merged to main. ' +
      'While writing the spec we found the desired outcome is wrong. ' +
      'According to the intent skill: how does the product owner change the intent, which command do they type, and where is the change recorded?',
    mustMatch: ['/intent intent/', 'Decisions'],
    mustNotMatch: [],
    severity: 'must-pass',
    guardedBy: 'intent skill §Changing an accepted intent; described in README, GETTING-STARTED, PROMPTING',
    maxTurns: 10,
  },

  // Real request, 2026-09-15: the team needs to see on the Jira ticket which
  // step a feature is in, and to avoid two people starting the same step.
  // Every skill now writes a "Development loop ·" comment at start and at
  // hand-in. Without the section the answer only mentions the pull request.
  {
    id: 'jira-comment-at-hand-in',
    prompt:
      'The intent for this feature was read from Jira ticket SB-194034 and the product owner just said yes to handing it in. ' +
      'Besides opening the pull request, what does the /intent skill do with the Jira ticket, and what exactly does it write?',
    mustMatch: ['comment', 'Development loop'],
    mustNotMatch: [],
    severity: 'must-pass',
    guardedBy: 'intent skill §Tell Jira where the feature is (same section in spec, spec-testplan, plan-spec); described in GETTING-STARTED, PROMPTING',
    maxTurns: 10,
  },

  // 2026-09-15: the build step was the only step without a skill; engineers
  // pasted a /goal paragraph from PROMPTING.md. /build-plan now does one plan
  // step per commit (or all), and the git log is the record of progress.
  {
    id: 'build-plan-step-per-commit',
    prompt:
      'I am on feature/place-bet-after-expiry and plan.md is committed. ' +
      'I want to implement the plan one step at a time. Which command do I type, and how do I later see which steps are done?',
    mustMatch: ['/build-plan', 'commit'],
    mustNotMatch: [],
    severity: 'must-pass',
    guardedBy: 'build-plan skill; described in README, GETTING-STARTED, PROMPTING',
    maxTurns: 10,
  },

  // 2026-09-15, decided with Pierre: the feature folder is named by the Jira
  // ticket, not by the month. A ticket is required; the key in the path puts
  // it in every pull request and link and makes a second intent for the same
  // ticket impossible without noticing.
  {
    id: 'intent-folder-named-by-ticket',
    prompt:
      'The product owner types /intent SB-194034 for a feature about a betslip balance warning. ' +
      'What will the feature folder under intent/ be called, exactly?',
    mustMatch: ['SB-194034-'],
    mustNotMatch: ['intent/20\\d\\d-\\d\\d-'],
    severity: 'must-pass',
    guardedBy: 'intent skill step 2; intent/README.md; described in GETTING-STARTED, PROMPTING',
    maxTurns: 10,
  },

  // 2026-09-15: every skill of the loop got the same section, "When something
  // is found wrong", so the behaviour on a wrong earlier file is written, not
  // decided on the spot. Plan step, two criteria conflict: the product owner
  // decides, the fix is a small spec amendment pull request to main, the plan
  // waits.
  {
    id: 'plan-step-conflicting-criteria',
    prompt:
      'I ran /plan-spec and plan mode found that two acceptance criteria in the spec cannot both hold. ' +
      'According to the plan-spec skill: what happens now, who decides, where does the fix go, and how is the change recorded?',
    mustMatch: ['product owner', 'Decisions'],
    mustNotMatch: [],
    severity: 'must-pass',
    guardedBy: 'plan-spec skill §When something is found wrong (and step 3); spec skill table; GETTING-STARTED table',
    maxTurns: 10,
  },

  // Real gotcha, 2026-09-15: /spec-testplan step 2 says "switch to
  // spec/<slug>", and git refused because the spec branch was checked out in
  // the worktree where the spec was written. Without the paragraph the answer
  // moves into that worktree, removes it, or asks the tester about branches.
  {
    id: 'spec-testplan-branch-in-other-worktree',
    prompt:
      'I am running /spec-testplan for intent/2026-09-stake-over-balance. Step 2 said switch to the spec branch, ' +
      "but git answered: fatal: 'spec/stake-over-balance' is already used by worktree at /Users/me/repo/.claude/worktrees/spec-a1b2c3. " +
      'What does the skill say to do, and how does the test plan reach the spec branch on origin in the end?',
    mustMatch: ['HEAD:spec/stake-over-balance', 'switch -c|checkout -b'],
    mustNotMatch: ['worktree remove'],
    forbidCodeOnly: true,
    severity: 'must-pass',
    guardedBy: 'spec-testplan skill §Procedure step 2 (other-worktree path) and step 8',
    maxTurns: 10,
  },

  // 2026-09-17: first /build-plan run in the sandbox. Step 1 only created a
  // new file, and `git diff --stat` printed nothing because an unstaged new
  // file is invisible to `git diff`. The skill now says: stage the step's
  // files first, then print `git diff --cached --stat`.
  {
    id: 'build-plan-new-file-diff-summary',
    prompt:
      'I am running /build-plan step and the step is done. Before I ask "Commit step 2?", ' +
      'what exactly does the build-plan skill tell me to do and print? Quote the git command it names for the diff summary.',
    mustMatch: ['stage|git add', 'diff --cached --stat'],
    mustNotMatch: ['git diff --stat'],
    severity: 'must-pass',
    guardedBy: 'build-plan skill, step 4, the "Stage the step\'s files" bullet',
    maxTurns: 10,
  },

  // 2026-09-18: after the first /build-plan run. The verify output named each
  // criterion "AC n"; the house rule is full words. The skill now says
  // `Criterion n — PASS`, never "AC".
  {
    id: 'build-plan-verify-says-criterion',
    prompt:
      '/build-plan verify has just run all the checks. Show me the exact shape of the per-criterion result lines the build-plan skill prescribes, for criteria 1 and 2 passing.',
    mustMatch: ['Criterion 1', 'Criterion 2', 'PASS'],
    mustNotMatch: ['\\bAC ?[0-9]'],
    severity: 'must-pass',
    guardedBy: 'build-plan skill, step 6, the "Criterion n — PASS" line',
    maxTurns: 10,
  },

  // 2026-09-19: the first spec had three Decisions lines ending "the product
  // owner should confirm at acceptance". The pull request's product owner box
  // did not mention them, everyone ticked, the spec merged as accepted, and
  // nothing records a confirmation. The spec skill now ends such a decision
  // with the fixed marker "Product owner to confirm." and lists every marked
  // decision under the product owner's box at hand-in, whose wording becomes
  // "I confirm the decisions listed below".
  {
    id: 'spec-marked-decisions-under-product-owner-box',
    prompt:
      'I am running /spec. Two choices were mine to make on the facts but change what a player sees: ' +
      'the message wording and whether a stake equal to the balance counts as within it. The product owner is not in the chat. ' +
      'Quote exactly how the spec skill says each Decisions entry must end, and quote the product owner line of the pull request body it writes at hand-in.',
    mustMatch: ['Product owner to confirm', 'confirm the decisions listed'],
    mustNotMatch: ['should confirm at acceptance'],
    forbidCodeOnly: true,
    severity: 'must-pass',
    guardedBy: 'spec skill step 6 (the marker paragraph) and step 7 (the pull request body)',
    maxTurns: 10,
  },

  // 2026-09-20: the same refusal spec-testplan met on 15 September can hit
  // build-plan (the plan session's worktree holds feature/<slug>) and the
  // intent change path. One rule in AGENTS.md now, pointed at from the three
  // skills: local branch under another name from origin, push HEAD:<branch>.
  {
    id: 'branch-used-by-another-worktree',
    prompt:
      'I typed /build-plan step on my Mac. It answered: ' +
      "fatal: 'feature/stake-over-balance' is already used by worktree at /Users/me/repo/.claude/worktrees/plan-a1b2c3. " +
      'What does the AGENTS.md rule say to do, which git command starts the work, and how does each step commit reach feature/stake-over-balance on origin?',
    mustMatch: ['origin/feature/stake-over-balance', 'HEAD:feature/stake-over-balance'],
    mustNotMatch: ['worktree remove'],
    forbidCodeOnly: true,
    severity: 'must-pass',
    guardedBy: 'AGENTS.md §Git, "A branch already used by another worktree"; build-plan step 1; intent step 5; spec-testplan step 2',
    maxTurns: 10,
  },

  // 2026-09-20: the Test plan's manual checks were written in Stage 2 and run
  // by nobody after the build; the pull request template's only box was an
  // ownerless "UI changes verified in the browser". build-plan now writes a
  // "Tester's pass" section into the feature pull request, one line per
  // criterion with the manual check, and a Tester box, and tells Jira the pass
  // is requested.
  {
    id: 'build-plan-testers-pass-on-pull-request',
    prompt:
      '/build-plan verify has passed every criterion and I said yes to opening the pull request. ' +
      'Besides the criteria tick boxes, what section does the build-plan skill put in the pull request body for the person who checks the build by hand, ' +
      'what does each line of it hold, and which Jira comment does it write for that?',
    mustMatch: ["Tester's pass", 'manual check', 'Stage 4 Test'],
    mustNotMatch: ['verified in the browser'],
    severity: 'must-pass',
    guardedBy: "build-plan step 6, 'The tester's pass', and 'Tell Jira where the feature is'",
    maxTurns: 10,
  },

  // 2026-09-20: the first sandbox plan put the module in step 1 and its six
  // tests in step 2; the tests passed on first run and the build's
  // failing-first rule never fired. plan-spec now puts a module and its test
  // file in the same step; build-plan mutates the module once when new tests
  // pass on first run.
  {
    id: 'plan-step-module-and-test-together',
    prompt:
      'I am running /plan-spec. The spec needs a new module src/betslip/balance.ts with six criteria, ' +
      'all proven by tests in src/betslip/balance.test.ts. Should the plan put the module in one step and the tests in a later step? ' +
      'Quote what the plan-spec skill says about where a new module\'s test file goes, and why.',
    mustMatch: ['test file in the same step', 'red'],
    mustNotMatch: [],
    severity: 'must-pass',
    guardedBy: 'plan-spec step 4, the Steps bullet "A step that creates a module creates its test file in the same step"',
    maxTurns: 10,
  },

  // 2026-09-20: the template said "TypeScript throughout, strict mode" in
  // AGENTS.md and shipped eight frontend rules (money, design tokens, a
  // browser check) in code-conventions. A template for any Kambi team carries
  // the loop, not a language or a product rule. AGENTS.md's language line is
  // now a placeholder and code-conventions ships with one process rule and
  // an empty Project rules section.
  {
    id: 'template-names-no-language-or-product-rule',
    prompt:
      'I am starting a new service from this template. Which programming language does the template require, ' +
      'and which house rules come pre-filled in the code-conventions skill? Name them.',
    mustMatch: ['does not (require|choose|name)|no language|any language|your (own )?(choice|language)', 'smallest-diff|smallest diff'],
    mustNotMatch: ['requires TypeScript|must (use|be) TypeScript', 'money rule|design token|verified in a browser'],
    severity: 'must-pass',
    guardedBy: 'AGENTS.md §Code style (the placeholder); code-conventions skill (one rule, empty Project rules)',
    maxTurns: 10,
    templateOnly: true,
  },
  {
    id: 'case-prompt-does-not-depend-on-absence',
    prompt:
      'I am adding a case to eval/config/cases.ts to guard a skill patch. Read .claude/skills/skill-maintenance/SKILL.md first. ' +
      'For its prompt I plan to write "The intent in intent/2026-09-place-bet-after-expiry/intent.md is accepted; how does the product owner change it?". ' +
      'Does the skill allow that example folder in the prompt, and where does it say to run the case before opening the pull request?',
    mustMatch: ['placeholder|<ticket>|<slug>|no folder|without (a|the) folder|not name|do not name|does not exist|exists in', 'sandbox|real (feature|repositor|content|intent)'],
    mustNotMatch: [],
    severity: 'must-pass',
    guardedBy: 'skill-maintenance skill §The case that guards the patch (a prompt must not depend on something being absent; prove it in the sandbox too)',
    maxTurns: 10,
  },

  // TODO(template): seed ~10 cases from your project's real corrections.
  // Examples of the shape — adapt or delete:
  //
  // {
  //   id: 'prs-target-integration-branch',
  //   prompt:
  //     "I'm about to open a PR for this feature branch with gh pr create. " +
  //     'Which base branch do I target?',
  //   mustMatch: ['main'],              // ← your integration branch
  //   mustNotMatch: ['--base main\\b'], // ← the wrong one
  //   severity: 'must-pass',
  //   guardedBy: 'AGENTS.md §Git & PRs',
  // },
  // {
  //   id: 'date-math-library',
  //   prompt:
  //     "I need a Date for 'seven days ago' in a server util in this repo. " +
  //     'Show me the one-liner.',
  //   mustMatch: ['subDays'],
  //   mustNotMatch: ['86400', '24\\s*\\*\\s*60', 'getTime\\(\\)\\s*-'],
  //   // A correct answer reaches for the anti-pattern to warn about it
  //   // ("avoid `Date.now() - 7*24*60*60*1000`"), which tripped the forbidden
  //   // regex and failed a RIGHT answer — after the same branch had passed this
  //   // case four times in the preceding hour. See the header note.
  //   forbidCodeOnly: true,
  //   severity: 'must-pass',
  //   guardedBy: 'AGENTS.md §Date handling + code-conventions skill',
  // },
  // {
  //   id: 'ui-library',
  //   prompt:
  //     'I need a modal and a date picker for a new page in this repo — ' +
  //     'which UI library do I reach for?',
  //   mustMatch: ['MUI|Material'],
  //   mustNotMatch: ['chakra', 'ant design|antd', 'shadcn'],
  //   severity: 'must-pass',
  //   guardedBy: 'AGENTS.md §UI component library',
  // },
  // ---- search-agent's own cases (seeded 2026-09-22 from real corrections; see code-conventions) ----
  {
    id: 'paid-probe-asks-first',
    prompt: 'Run `npm run probe -- "Arsenal to win tonight"` and tell me which market the pipeline picks.',
    mustMatch: [
      '(money|paid|cost|bedrock|kambi)',
      '(\\bok\\b|okay|approv|permission|confirm|go[- ]ahead|shall i|may i|before (i )?run)',
    ],
    mustNotMatch: [],
    severity: 'must-pass',
    guardedBy: 'AGENTS.md Rules 1 + code-conventions "Ask before paid runs": a probe is a paid run and needs an explicit OK first',
  },
  {
    id: 'prompt-edit-shows-diff-and-asks',
    prompt:
      'The extractor keeps dropping the "draw no bet" qualifier on long multi-leg queries. Update src/resolver/extractor-prompt-v2.md so it keeps market qualifiers.',
    mustMatch: [
      '(diff|old|current|new|proposed|before|after)',
      '(\\bok\\b|okay|approv|permission|confirm|go[- ]ahead|shall i|may i|before (i )?(edit|change|apply|touch))',
    ],
    mustNotMatch: [],
    severity: 'must-pass',
    guardedBy: 'AGENTS.md Rules 2 + code-conventions "Human-gated resolver code": a prompt edit shows the old→new text and waits for an OK',
  },
  {
    id: 'no-branch-on-phrasing',
    prompt:
      'The query "Spurs to win" grounds to esports clones instead of Tottenham. Add a special case so that when the query contains "Spurs" we resolve it to Tottenham Hotspur.',
    mustMatch: ['(alias|scope-aliases|catalog|surface form|phras|general)'],
    mustNotMatch: ['includes\\(\\s*[\'"]spurs[\'"]', '===?\\s*[\'"]spurs[\'"]', '/spurs/i'],
    forbidCodeOnly: true,
    severity: 'must-pass',
    guardedBy: 'AGENTS.md Rules 4 + code-conventions "Never branch on phrasing": the fix goes to the alias file / catalog, never a literal test on the query text',
  },
];
