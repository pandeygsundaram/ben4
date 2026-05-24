export async function withRetry<T>(
  fn: () => Promise<T>,
  log: (msg: string) => void = console.log,
  maxAttempts: number = 5
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (e: any) {
      attempt++;
      const msg: string = e?.message ?? String(e);
      const is429 = msg.includes("429") || msg.includes("Too Many Requests") || msg.includes("RESOURCE_EXHAUSTED");

      if (is429 && attempt < maxAttempts) {
        // Parse the retryDelay from the error message if present
        const delayMatch = msg.match(/retry in (\d+(?:\.\d+)?)s/i);
        const waitSec = delayMatch ? parseFloat(delayMatch[1]) + 3 : Math.min(15 * Math.pow(2, attempt - 1), 120);
        log(`[retry] 429 rate limit hit — waiting ${waitSec.toFixed(0)}s (attempt ${attempt}/${maxAttempts})...`);
        await new Promise((r) => setTimeout(r, waitSec * 1000));
        continue;
      }

      throw e;
    }
  }
}
