/**
 * Stand-in for `browser-harness skill`.
 *
 * Prints the fixture document configured through `BH_SKILL_FIXTURE`, so the
 * bridge can be tested against a real child process without a real install.
 * Exits non-zero when `BH_SKILL_FAIL` is set, emulating a broken install.
 */
if (process.env.BH_SKILL_FAIL === '1') {
  process.stderr.write('browser-harness: not installed\n')
  process.exit(2)
}
const document = process.env.BH_SKILL_FIXTURE
if (document === undefined) {
  process.stderr.write('browser-harness: no skill available\n')
  process.exit(3)
}
process.stdout.write(document)
