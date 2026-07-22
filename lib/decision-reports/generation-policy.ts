export class DecisionReportGenerationTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Decision Report generation timed out after ${timeoutMs}ms.`);
    this.name = "DecisionReportGenerationTimeoutError";
  }
}

export async function runWithSingleRetry<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<{ value: T; attempts: number }> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        reject(new DecisionReportGenerationTimeoutError(timeoutMs));
      }, timeoutMs);
    });

    try {
      const value = await Promise.race([operation(controller.signal), timeout]);
      return { value, attempts: attempt };
    } catch (error) {
      lastError = error;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  throw lastError;
}
