// Minimal Node.js type declarations for the demo target. Mirrors the
// shared subset of src/globals.d.ts in the probe package; @types/node
// is intentionally not in either package's devDependencies (per the
// AC-12 frozen-deps gate). Keep this file in lockstep with the
// probe's globals.d.ts if new Node APIs are added.
//
// SCRIPT file (no `export` / `import`) so the `declare` statements
// merge into the global ambient type space.

declare namespace NodeJS {
  interface ProcessEnv {
    [key: string]: string | undefined;
  }
  interface Process {
    env: ProcessEnv;
    exit(code?: number): never;
    cwd(): string;
    hrtime: {
      bigint(): bigint;
    };
  }
}

declare var process: NodeJS.Process;
declare var console: {
  error(...args: unknown[]): void;
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  info(...args: unknown[]): void;
};
