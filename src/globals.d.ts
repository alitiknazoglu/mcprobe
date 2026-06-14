// Minimal Node.js type declarations (replaces @types/node per the
// AC-12 frozen-deps gate). Only the subset of Node APIs the probe
// and its tests use is declared — extend this file rather than
// reintroducing @types/node.
//
// Intentionally a SCRIPT file (no `export` / `import`) so every
// `declare` merges into the global ambient type space, including
// the `declare module "node:..."` blocks (which only work as
// global module augmentations from a script file).

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

interface URL {
  toString(): string;
  href: string;
}
declare var URL: { new (url: string): URL };

interface ImportMeta {
  url: string;
}

declare module "node:fs" {
  export function existsSync(path: string): boolean;
}

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
}

declare module "node:path" {
  export function dirname(path: string): string;
  export function resolve(...paths: string[]): string;
}
