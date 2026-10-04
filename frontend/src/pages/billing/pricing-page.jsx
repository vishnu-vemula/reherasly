import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, Check, Lock, ReceiptText } from 'lucide-react';
import api from '@/lib/axios';
import { useAuthStore } from '@/store/auth-store';
import { useBillingMe, usePlans } from '@/hooks/use-billing';
import {
  Alert, Button, Card, EmptyState, ErrorState, Field, Input, Modal, PageHeader, Pill, ProgressBar, Skeleton, TableShell,
} from '@/components/ui';
import { cn, formatDate, formatINR, getErrorMessage } from '@/utils';

const ORDER_STATUS = {
  pending: { label: 'Pending', tone: 'blue' },
  success: { label: 'Paid', tone: 'ok' },
  failed: { label: 'Failed', tone: 'coral' },
  refund_pending: { label: 'Refund pending', tone: 'blue' },
  refunded: { label: 'Refunded', tone: 'stone' },
};

const makeIdempotencyKey = () =>
  (window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`);

function CheckoutModal({ plan, onClose }) {
  const [phone, setPhone] = useState('');
  const [error, setError] = useState('');
  const [touched, setTouched] = useState(false);
  const [working, setWorking] = useState(false);
  const checkoutAttempt = useRef({ phone: '', key: makeIdempotencyKey() });
  const phoneValid = /^\d{10}$/.test(phone);

  const pay = async (e) => {
    e.preventDefault();
    setTouched(true);
    if (!phoneValid) return;
    setWorking(true);
    setError('');
    try {
      if (checkoutAttempt.current.phone !== phone) checkoutAttempt.current = { phone, key: makeIdempotencyKey() };
      const { data } = await api.post('/billing/checkout', { planId: plan._id, phone },
        { headers: { 'Idempotency-Key': checkoutAttempt.current.key } });
      // Hand off to PayU hosted checkout with the server-signed fields.
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = data.action;
      Object.entries(data.fields).forEach(([name, value]) => {
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = name;
        input.value = String(value);
        form.appendChild(input);
      });
      document.body.appendChild(form);
      form.submit();
    } catch (err) {
      setError(getErrorMessage(err, 'Checkout is unavailable right now.'));
      setWorking(false);
    }
  };

  return (
    <Modal
      open={!!plan}
      onClose={() => !working && onClose()}
      title={`Buy ${plan?.name}`}
      description="You’ll finish payment on PayU’s secure page. Access starts once PayU confirms the payment."
      size="sm"
    >
      <form onSubmit={pay} noValidate className="space-y-5">
        <div className="rounded-r18 bg-paper p-4">
          <div className="flex items-baseline justify-between">
            <span className="text-[15px] font-medium">{plan?.name}</span>
            <span className="text-[24px] font-medium tracking-tight3 tabular">{formatINR((plan?.amountMinor || 0) / 100)}</span>
          </div>
          <p className="mt-1 text-[13px] text-muted">{plan?.credits} interviews · valid {plan?.durationDays} days · one-time payment</p>
        </div>
        {error && <Alert tone="error" icon={AlertCircle}>{error}</Alert>}
        <Field label="Mobile number" hint="PayU needs a 10-digit Indian mobile number." error={touched && !phoneValid ? 'Enter a 10-digit mobile number' : undefined}>
          <Input
            type="tel"
            inputMode="numeric"
            autoComplete="tel-national"
            maxLength={10}
            placeholder="98XXXXXXXX"
            value={phone}
            onBlur={() => setTouched(true)}
            onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))}
          />
        </Field>
        <Button type="submit" variant="lime" cta loading={working} disabled={working} className="w-full py-[6px]">
          {working ? 'Opening PayU…' : `Pay ${formatINR((plan?.amountMinor || 0) / 100)} with PayU`}
        </Button>
        <p className="flex items-center justify-center gap-1.5 text-[12px] text-muted"><Lock size={12} aria-hidden="true" /> Card details are entered on PayU, never on Rehearsly.</p>
      </form>
    </Modal>
  );
}

export default function PricingPage() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const plansQuery = usePlans();
  const billing = useBillingMe();
  const [checkoutPlan, setCheckoutPlan] = useState(null);

  const plans = plansQuery.data || [];
  const allowance = billing.data?.allowance;
  const subscription = billing.data?.subscription;
  const orders = billing.data?.orders || [];

  return (
    <div className={cn('animate-fade-in', !isAuthenticated && 'container-page py-14 sm:py-20')}>
      <div className="space-y-8">
        <PageHeader
          eyebrow="Plans & billing"
          title="Start free. Upgrade when you’re interviewing."
          description="Every account gets 2 tailored interviews a month. Passes add more for an active job search — one-time payments in INR via PayU, no auto-renewal."
        />

        {isAuthenticated && (
          <Card className="grid gap-5 p-6 sm:grid-cols-[1fr_auto] sm:items-center">
            {billing.isLoading ? (
              <Skeleton className="h-14" />
            ) : billing.isError ? (
              <p className="text-[14px] text-coral">Couldn’t load your allowance. <button type="button" className="link" onClick={() => billing.refetch()}>Retry</button></p>
            ) : (
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-[18px] font-medium tracking-tight1">{subscription ? `${subscription.planId?.name || 'Pass'} active` : 'Free plan'}</p>
                  {subscription && <Pill tone="lime" mono>Until {formatDate(subscription.currentPeriodEnd)}</Pill>}
                </div>
                {allowance && (
                  <>
                    <p className="mt-1 text-[14px] text-muted"><span className="font-medium text-ink tabular">{allowance.remaining}</span> of {allowance.limit} interviews left {subscription ? 'on this pass' : 'this month'}</p>
                    <ProgressBar className="mt-3 max-w-md" value={allowance.used} max={allowance.limit || 1} tone={allowance.remaining ? 'blue' : 'coral'} label="Interviews used" />
                  </>
                )}
              </div>
            )}
            <Button to="/interviews/new" variant="ink">New interview</Button>
          </Card>
        )}

        {plansQuery.isError ? (
          <ErrorState title="Couldn’t load plans" description={getErrorMessage(plansQuery.error)} onRetry={plansQuery.refetch} />
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            <div className="flex flex-col rounded-r24 border border-line-2 bg-white p-7">
              <p className="text-[16px] font-medium">Free</p>
              <p className="mt-3.5 text-[48px] font-medium leading-none tracking-tight2">₹0</p>
              <ul className="mt-6 flex-1 space-y-2.5 text-[14.5px] text-ink-soft">
                {['2 tailored interviews / month', 'Per-answer feedback', 'Text and voice answers'].map((f) => (
                  <li key={f} className="flex gap-2"><Check size={16} className="mt-0.5 flex-shrink-0" aria-hidden="true" />{f}</li>
                ))}
              </ul>
              {isAuthenticated ? (
                <p className="mt-7 rounded-full bg-stone-2 py-3.5 text-center font-mono text-[11.5px] uppercase tracking-mono text-muted">{subscription ? 'Included' : 'Your current plan'}</p>
              ) : (
                <Button to="/register" variant="outline" className="mt-7 w-full py-[15px]">Create free account</Button>
              )}
            </div>

            {plansQuery.isLoading
              ? [0, 1].map((i) => <Skeleton key={i} className="min-h-[360px] rounded-r24" />)
              : plans.length === 0
                ? (
                  <EmptyState
                    className="md:col-span-1 xl:col-span-2"
                    icon={ReceiptText}
                    title="No passes on sale right now"
                    description="The free plan is fully featured. Paid passes will appear here once they’re published."
                  />
                )
                : plans.map((plan, i) => {
                  const featured = i === 0;
                  return (
                    <div key={plan._id} className={cn('flex flex-col rounded-r24 p-7', featured ? 'bg-ink text-white' : 'border border-line-2 bg-white')}>
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-[16px] font-medium">{plan.name}</p>
                        {featured && <span className="rounded-full bg-lime px-2.5 py-[5px] font-mono text-[10.5px] uppercase tracking-mono text-ink">For active job searches</span>}
                      </div>
                      <p className="mt-3.5 text-[48px] font-medium leading-none tracking-tight2 tabular">
                        {formatINR(plan.amountMinor / 100)}
                        <span className={cn('text-[15px] tracking-normal', featured ? 'text-on-dark' : 'text-muted')}> / {plan.durationDays} days</span>
                      </p>
                      {plan.description && <p className={cn('mt-3 text-[14px] leading-relaxed', featured ? 'text-on-dark' : 'text-muted')}>{plan.description}</p>}
                      <ul className={cn('mt-6 flex-1 space-y-2.5 text-[14.5px]', featured ? 'text-on-dark-bright' : 'text-ink-soft')}>
                        <li className="flex gap-2"><Check size={16} className="mt-0.5 flex-shrink-0" aria-hidden="true" />{plan.credits} tailored interviews</li>
                        {(plan.features || []).map((f) => (
                          <li key={f} className="flex gap-2"><Check size={16} className="mt-0.5 flex-shrink-0" aria-hidden="true" />{f}</li>
                        ))}
                      </ul>
                      {isAuthenticated ? (
                        <Button variant={featured ? 'lime' : 'ink'} className="mt-7 w-full py-[15px]" onClick={() => setCheckoutPlan(plan)}>
                          Continue to PayU
                        </Button>
                      ) : (
                        <Button to="/register?next=%2Fpricing" variant={featured ? 'lime' : 'ink'} className="mt-7 w-full py-[15px]">
                          Create account to buy
                        </Button>
                      )}
                    </div>
                  );
                })}
          </div>
        )}

        {isAuthenticated && orders.length > 0 && (
          <section>
            <h2 className="mb-3 text-[20px] font-medium tracking-tight1">Payments</h2>
            <TableShell minWidth={560}>
              <thead>
                <tr><th>Date</th><th>Order</th><th>Amount</th><th>Status</th><th /></tr>
              </thead>
              <tbody>
                {orders.map((o) => {
                  const st = ORDER_STATUS[o.status] || { label: o.status, tone: 'stone' };
                  return (
                    <tr key={o.transactionId}>
                      <td>{formatDate(o.createdAt)}</td>
                      <td className="font-mono text-[12px]">{o.transactionId}</td>
                      <td className="tabular">{formatINR(o.amountMinor / 100)}</td>
                      <td><Pill tone={st.tone}>{st.label}</Pill></td>
                      <td className="text-right">
                        <Link to={`/billing/result?txnid=${encodeURIComponent(o.transactionId)}`} className="mono-label text-brand-600 hover:text-ink">Status ↗</Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </TableShell>
          </section>
        )}

        <p className="text-[12.5px] leading-relaxed text-muted">
          Passes are one-time purchases and don’t renew automatically. Scores are practice feedback — never a hiring prediction.
        </p>
      </div>

      {checkoutPlan && <CheckoutModal plan={checkoutPlan} onClose={() => setCheckoutPlan(null)} />}
    </div>
  );
}
