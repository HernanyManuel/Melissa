export const QUARANTINE_CAPACITY = 1000;
export const QUARANTINE_WARNING_THRESHOLD = 800;

export type QuarantineNotice =
  | 'capacity_full'
  | 'capacity_warning'
  | 'expiring_soon'
  | 'cleanup_pending';

// Observational signals, not persisted incidents or evidence of worker failure.
export function quarantineNotices(total: number, expired: number, expiringSoon: number) {
  const notices: QuarantineNotice[] = [];
  if (total >= QUARANTINE_CAPACITY) notices.push('capacity_full');
  else if (total >= QUARANTINE_WARNING_THRESHOLD) notices.push('capacity_warning');
  if (expired > 0) notices.push('cleanup_pending');
  if (expiringSoon > 0) notices.push('expiring_soon');
  return notices;
}
