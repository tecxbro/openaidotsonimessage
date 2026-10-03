/** A deadline bounds observation. It never claims to cancel the underlying work. */
export class OperationTimeout extends Error {
  constructor() { super('operation_timeout'); }
}
export async function withDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new OperationTimeout()), timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
export async function settleWithin(work: Iterable<Promise<unknown> | undefined>, timeoutMs: number): Promise<boolean> {
  try { await withDeadline(Promise.allSettled([...work]), Math.max(0, timeoutMs)); return true; }
  catch (error) { if (error instanceof OperationTimeout) return false; throw error; }
}
