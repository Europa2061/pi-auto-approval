import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { TraceEntry } from "./types.js";
import { logsDir } from "./extension-config.js";

const TRACE_FILE = "traces.jsonl";
const MAX_IN_MEMORY = 100;

export class TraceStore {
  private traces: TraceEntry[] = [];
  private traceLogPath: string;

  constructor(traceLogPath?: string) {
    this.traceLogPath = traceLogPath ?? join(logsDir(), TRACE_FILE);
  }

  add(entry: TraceEntry): void {
    this.traces.push(entry);
    if (this.traces.length > MAX_IN_MEMORY) {
      this.traces = this.traces.slice(-MAX_IN_MEMORY);
    }
    this.flush(entry);
  }

  getRecent(count = 10): TraceEntry[] {
    return this.traces.slice(-count).reverse();
  }

  getLatest(): TraceEntry | undefined {
    return this.traces[this.traces.length - 1];
  }

  clear(): void {
    this.traces = [];
  }

  private flush(entry: TraceEntry): void {
    try {
      mkdirSync(this.traceLogPath.split("/").slice(0, -1).join("/"), { recursive: true });
      appendFileSync(this.traceLogPath, JSON.stringify(entry) + "\n", "utf-8");
    } catch {
      // Silently ignore trace write failures — they don't affect approval flow.
    }
  }
}
