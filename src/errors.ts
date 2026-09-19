/**
 * Shared error classes.
 *
 * UsageError marks argument-level and precondition-level failures (wrong
 * flags, missing lockfile for --frozen, ...): the CLI prints them concisely
 * and exits with code 2 instead of the generic runtime-failure code 1.
 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}
