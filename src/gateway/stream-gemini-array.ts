import type { StreamProcessor } from "./processor";
import type { SseEvent } from "./sse";
import type { Usage } from "./types";

/**
 * Gemini `:streamGenerateContent` WITHOUT `?alt=sse` answers with a JSON array that grows chunk by chunk
 * (`[{...}\r\n,{...}\r\n]`). We always ask the upstream for SSE and re-shape its events for such clients.
 */
export class GeminiJsonArrayStream implements StreamProcessor {
  private count = 0;
  constructor(private readonly inner: StreamProcessor) {}

  private wrap(blocks: string[]): string[] {
    const out: string[] = [];
    for (const b of blocks) {
      const payload = b
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!payload) continue;
      out.push(`${this.count++ === 0 ? "[" : ","}${payload}\r\n`);
    }
    return out;
  }

  onEvent(ev: SseEvent): string[] {
    return this.wrap(this.inner.onEvent(ev));
  }
  onEnd(): string[] {
    const tail = this.wrap(this.inner.onEnd());
    tail.push(this.count === 0 ? "[]" : "]");
    return tail;
  }
  usage(): Usage | null {
    return this.inner.usage();
  }
  outputText(): string {
    return this.inner.outputText();
  }
  outputChars(): number {
    return this.inner.outputChars?.() ?? 0;
  }
  /** Funds exhausted: the error object becomes the last array element and the array is closed. */
  abortEvents(errorEvent: string): string[] {
    const tail = this.wrap(this.inner.abortEvents ? this.inner.abortEvents(errorEvent) : [errorEvent]);
    tail.push(this.count === 0 ? "[]" : "]");
    return tail;
  }
  completed(): boolean {
    return this.inner.completed();
  }
  error() {
    return this.inner.error();
  }
}
