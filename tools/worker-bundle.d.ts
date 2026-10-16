/** A module no Worker code path runs, by its path inside its package, and why. */
export interface PiWorkerStub { path: string; why: string }

export const PI_RESOURCES: readonly string[];
export const PI_WORKER_STUBS: readonly PiWorkerStub[];
export const PI_WORKER_REMOVED: readonly string[];
export const PI_TEXT_RULE: { type: "Text"; globs: string[]; fallthrough: false };

export function stubFor(path: string): PiWorkerStub | undefined;
export function stubSource(label: string, names: string[]): string;
export function exportNames(url: string): Promise<string[]>;

export function stagePi(options: {
  root: string;
  transform: (source: string, options: { loader: "js"; sourcefile: string; define: Record<string, string> }) => Promise<{ code: string }>;
  entries: Record<string, string>;
}): Promise<{ moduleUrls: number; stubs: number; removed: number; resources: number }>;

export function workerAliases(staged: string): Record<string, string>;
