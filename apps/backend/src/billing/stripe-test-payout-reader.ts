import { readBoundedStripeList } from './stripe-test-cursor-pagination';
import { StripeTestInvoiceReader } from './stripe-test-invoice-reader';

// Privileged offline helper only. Never expose payout IDs to an HTTP endpoint.
// It does not infer membership from a payout's amount or a Charge's availability.
const PAYOUT_ID = /^po_[A-Za-z0-9_]{1,250}$/;
export class StripeTestPayoutReader extends StripeTestInvoiceReader {
  async retrievePayout(id: string): Promise<unknown> {
    if (!PAYOUT_ID.test(id)) throw new Error('Invalid Stripe TEST payout ID');
    return this.readTestResource('/v1/payouts/' + id);
  }

  async listAutomaticPayoutTransactions(id: string): Promise<unknown> {
    if (!PAYOUT_ID.test(id)) throw new Error('Invalid Stripe TEST payout ID');
    return readBoundedStripeList((cursor) =>
      this.readTestResource(
        '/v1/balance_transactions?payout=' +
          id +
          '&limit=100' +
          (cursor ? '&starting_after=' + cursor : ''),
      ),
    );
  }
}
