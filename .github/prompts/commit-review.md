# Commit review

You are reviewing the commits that landed on this repository since the last review ran. The
workflow has already resolved the range and passed it to you — do not try to work out which
commits are new yourself.

## What to do

1. `git log --oneline $BASE..$HEAD` to see what you are reviewing, and `git diff $BASE..$HEAD`
   for the changes.
2. For anything non-trivial, **read the surrounding code** — the whole file the diff touches, the
   callers of a changed function, the test that covers it. The diff alone is not enough context to
   tell a real bug from a deliberate choice, and reading further is the main reason this review runs
   as an agent rather than a single API call.
3. Report what you find.

## What counts as a finding

Report anything that would change what a maintainer does:

- Correctness bugs — wrong logic, unhandled error paths, races, off-by-one, wrong operator.
- Things that will break in an environment other than the author's — missing env var handling,
  hardcoded paths, assumptions about a container's filesystem or the host's clock.
- Secrets, tokens, or credentials that could reach a log or an error message. This repo is public
  and several of its jobs carry credentials in URLs, so this one matters more than usual.
- Silent failure — a code path that swallows an error where silence is indistinguishable from
  success.
- Missing test coverage on logic that is easy to get wrong and cheap to test.

Do not report: formatting, naming preferences, "consider extracting this", or anything the
project's existing conventions already settle. If the diff is a docs change, a version bump, or a
comment, it is fine to find nothing.

Report every finding you are reasonably confident in, including low-severity ones — say how
confident you are and how severe you think it is, and let the reader filter. Do not pre-filter for
importance; a finding that gets dismissed costs less than a bug that was never surfaced.

## Output

Return structured output with three fields:

- `has_findings` — false if you found nothing worth reporting. When false, the other two fields are
  ignored, so put anything in them.
- `issue_title` — `Commit review: <short characterisation>`, e.g.
  `Commit review: 3 findings in the notifier and archive merge`.
- `issue_body` — GitHub-flavoured markdown. Open with one line naming the range and the commit
  count. Then one `- [ ]` checklist item per finding, each of the form:

  ```
  - [ ] **`path/to/file.ts:42`** — one-sentence statement of the problem. Why it matters, and what
        goes wrong concretely. _(confidence: high, severity: medium)_
  ```

  Use a `path:line` reference for every finding so the reader can click straight to it. Close with
  a line listing the commits reviewed, as `<sha> <subject>` lines, so the issue is self-contained
  once the range has moved on.

Write the body for someone who has not seen the diff and did not watch you work. Lead with what
you found, not with what you did to find it.
