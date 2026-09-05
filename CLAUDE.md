# Culvert — working rules

Monorepo of zero-dependency streaming packages (`packages/*`), built on
async iterators: `pipe(source, transform, sink)`. Node >= 20.12, ESM.

## Commands

- Build: `npx tsc --build` (from root; `--force` for a clean rebuild)
- Test: `npx vitest run` (root config discovers `packages/**/src/**/*.spec.ts`)
- Both must be green before any commit.

## Testing discipline (non-negotiable)

These rules exist because a 2026-09 deep review found 37 long-lived
bugs — including a test whose title asserted the opposite of its body.

1. **Fail first.** Every bug fix and every new feature lands its tests
   BEFORE the change, and you must watch them fail for the right
   reason. A test that has never failed proves nothing.
2. **Test titles are claims.** The assertion must match the title
   exactly. "accepts X" asserting a rejection is how a bug gets
   locked in as intended behavior.
3. **Teardown paths get watchdogs.** Any test that exercises early
   termination (`break` out of a for-await, abort, downstream error)
   carries an explicit `{ timeout: ... }` so a regression fails in
   seconds instead of hanging the suite.
4. **Readers face hostile input.** Any field a stream declares
   (sizes, lengths, counts) is attacker-controlled: validate type
   (integers!), bound what gets buffered, and add a crafted-input test
   for each bound. The writer being strict does not excuse the reader.
5. **Empty is a case.** Zero-chunk sources are different from one
   empty chunk. Test both.
6. **Chunk boundaries are a case.** Anything stateful across bytes
   (tokenizers, headers, CRLF pairs, multi-byte UTF-8) gets a
   split-across-chunks test, ideally byte-at-a-time.

## API discipline

- Export counts are tracked in each package's `index.ts` header
  comment and README "API surface" section — update both when the
  surface changes, and treat growth as a decision, not a side effect.
- Error taxonomy: `XCorruptionError` / `XAbortError` / `XEntryError`
  per package. Wrap platform/codec errors into the taxonomy at the
  package boundary.
- Policy options follow: strict default + named modes + function
  escape hatch.

## Docs discipline

- Every README code example must compile against real exports —
  verify import names and signatures when touching examples.
- No claims the code doesn't honor ("constant memory", platform
  support, feature bullets). If it's aspirational, label it a vN
  candidate.

## Releasing

- Versions are per-package; update `CHANGELOG.md` (root) under
  "Unreleased" as changes land. Inter-package deps are caret ranges,
  never `*`. Tags are repo-level (`v0.2.0` style). Publishing is
  `npm publish --workspaces` and requires Khalid's npm login.
