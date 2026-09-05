export function batchDeadline(createdAt: Date, now: Date, debounceMs: number): Date {
  return new Date(Math.min(now.getTime() + debounceMs, createdAt.getTime() + 5000));
}
