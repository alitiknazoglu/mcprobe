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
    argv: string[];
    execPath: string;
    exit(code?: number): never;
    cwd(): string;
    stdout: { write(s: string): boolean };
    stderr: { write(s: string): boolean };
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
  protocol: string;
  hostname: string;
  host: string;
  username: string;
  password: string;
}
declare var URL: { new (url: string): URL };

interface ImportMeta {
  url: string;
}

// Minimal global fetch (Node >=18) — used only by the CLI's `push` upload.
interface Response {
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
  text(): Promise<string>;
}
declare function fetch(
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }
): Promise<Response>;

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

declare module "node:net" {
  export function isIP(input: string): 0 | 4 | 6;
}

declare module "node:dns/promises" {
  export function lookup(
    hostname: string,
    options: { all: true }
  ): Promise<Array<{ address: string; family: number }>>;
}
