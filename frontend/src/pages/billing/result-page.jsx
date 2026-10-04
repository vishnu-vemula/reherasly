import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Clock, XCircle, AlertCircle } from 'lucide-react';
import api from '@/lib/axios';
import { BILLING_ME_KEY } from '@/hooks/use-billing';
import { Button, Card, Spinner } from '@/components/ui';
import { formatINR, getErrorMessage } from '@/utils';

const FINAL = ['success', 'failed', 'refunded'];

const VIEW = {
  success: { icon: CheckCircle2, tone: 'bg-lime text-ink', title: 'Payment confirmed', body: 'PayU confirmed your payment. Your new interviews are ready to use.' },
  failed: { icon: XCircle, tone: 'bg-coral-bg text-coral', title: 'Payment failed', body: 'PayU didn’t capture this payment, so you weren’t charged for a pass. You can try again.' },
  pending: { icon: Clock, tone: 'bg-brand-50 text-brand-600', title: 'Waiting for PayU', body: 'Your payment is still being confirmed. Access starts only after PayU confirms it — this page checks every few seconds.' },
  refund_pending: { icon: Clock, tone: 'bg-brand-50 text-brand-600', title: 'Refund in progress', body: 'A refund has been requested and is waiting for PayU to confirm.' },
  refunded: { icon: CheckCircle2, tone: 'bg-stone text-ink', title: 'Refunded', body: 'This payment was refunded.' },
};

export default function BillingResultPage() {
  const [params] = useSearchParams();
  const txnid = params.get('txnid');
  const [order, setOrder] = useState(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const queryClient = useQueryClient();
  const statusRef = useRef(null);

  useEffect(() => {
    if (!txnid) return undefined;
    let active = true;
    let timer;
    const check = async () => {
      try {
        const { data } = await api.get(`/billing/orders/${encodeURIComponent(txnid)}`);
        if (!active) return;
        setOrder(data.order);
        setError('');
        if (data.order.status !== statusRef.current) queryClient.invalidateQueries({ queryKey: BILLING_ME_KEY });
        statusRef.current = data.order.status;
        if (!FINAL.includes(data.order.status)) timer = setTimeout(check, 5000);
      } catch (err) {
        if (!active) return;
        setError(getErrorMessage(err, 'We couldn’t verify this order. Please try again.'));
        if (err.response?.status !== 404) timer = setTimeout(check, 10000);
      }
    };
    check();
    return () => { active = false; clearTimeout(timer); };
  }, [txnid, queryClient, retry]);

  const view = order ? VIEW[order.status] || VIEW.pending : null;
  const Icon = view?.icon;

  return (
    <div className="mx-auto max-w-xl py-6 animate-fade-in">
      <Card className="p-8 text-center sm:p-10">
        {!txnid ? (
          <>
            <span className="mx-auto grid h-14 w-14 place-items-center rounded-r18 bg-coral-bg text-coral"><AlertCircle size={24} aria-hidden="true" /></span>
            <h1 className="mt-6 text-[30px] font-medium tracking-tight2">No transaction found</h1>
            <p className="mt-2 text-[15px] text-muted-strong">PayU didn’t return a transaction reference to this page.</p>
          </>
        ) : error && !order ? (
          <>
            <span className="mx-auto grid h-14 w-14 place-items-center rounded-r18 bg-coral-bg text-coral"><AlertCircle size={24} aria-hidden="true" /></span>
            <h1 className="mt-6 text-[30px] font-medium tracking-tight2">Couldn’t check this payment</h1>
            <p className="mt-2 text-[15px] text-muted-strong">{error}</p>
            <Button className="mt-5" variant="soft" onClick={() => setRetry((value) => value + 1)}>Try again</Button>
          </>
        ) : !order ? (
          <div role="status" className="py-6">
            <div className="flex justify-center"><Spinner size={26} className="text-brand" /></div>
            <p className="mono-label mt-5 text-muted">Checking with PayU…</p>
          </div>
        ) : (
          <>
            {error && <div role="alert" className="mb-5 rounded-r14 bg-coral-bg px-4 py-3 text-[13px] text-coral">
              {error} <button type="button" className="underline" onClick={() => setRetry((value) => value + 1)}>Try again</button>
            </div>}
            <span className={`mx-auto grid h-14 w-14 place-items-center rounded-r18 ${view.tone}`}><Icon size={24} aria-hidden="true" /></span>
            <h1 className="mt-6 text-[30px] font-medium tracking-tight2">{view.title}</h1>
            <p className="mt-2 text-[15px] leading-relaxed text-muted-strong">{view.body}</p>
            <dl className="mt-6 divide-y divide-line-2 rounded-r18 border border-line-2 text-left text-[14px]">
              <div className="flex justify-between gap-4 px-4 py-3"><dt className="text-muted">Order</dt><dd className="break-all font-mono text-[12px]">{order.transactionId}</dd></div>
              <div className="flex justify-between gap-4 px-4 py-3"><dt className="text-muted">Amount</dt><dd className="tabular">{formatINR(order.amountMinor / 100)}</dd></div>
            </dl>
          </>
        )}
        <div className="mt-8 flex flex-wrap justify-center gap-2">
          {order?.status === 'success' && <Button to="/interviews/new" variant="lime">Start an interview</Button>}
          <Button to="/pricing" variant={order?.status === 'success' ? 'soft' : 'ink'}>Plans & billing</Button>
        </div>
      </Card>
    </div>
  );
}
