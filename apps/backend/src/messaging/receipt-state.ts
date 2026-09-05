import { ServiceUnavailableException } from '@nestjs/common';

// Never infer success from a missing dispatcher record or incomplete commit evidence.
export function checkedReceiptState(
  state: string | undefined,
  hasMessage: boolean,
  processedAt: Date | null,
): string {
  if (
    !state ||
    !['pending', 'processed', 'rejected', 'failed'].includes(state) ||
    (state === 'processed' && (!hasMessage || !processedAt)) ||
    (state !== 'processed' && hasMessage)
  )
    throw new ServiceUnavailableException();
  return state;
}
