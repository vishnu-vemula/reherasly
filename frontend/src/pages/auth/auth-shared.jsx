import { Link } from 'react-router-dom';
import { auth } from '@/lib/firebase';

/** Only allow same-app relative redirects (prevents open redirects via ?next=). */
export function safeNext(search, fallback = '/dashboard') {
  const next = new URLSearchParams(search).get('next');
  return next && next.startsWith('/') && !next.startsWith('//') ? next : fallback;
}

export const OAUTH_ERRORS = {
  not_configured: 'That sign-in option isn’t configured on this server yet. Use email instead.',
  cancelled: 'Sign-in was cancelled.',
  invalid_state: 'That sign-in link expired. Please try again.',
  email_unverified: 'Your provider account needs a verified email address.',
  account_unavailable: 'This account is deactivated or banned. Contact support.',
  provider_error: 'The sign-in provider returned an error. Please try again.',
};

export function AuthHeading({ title, subtitle }) {
  return (
    <div>
      <h1 className="text-[40px] font-medium leading-none tracking-tight2 sm:text-[44px]">{title}</h1>
      {subtitle && <p className="mt-3 text-[16px] leading-normal text-muted-strong">{subtitle}</p>}
      {!auth && <p role="alert" className="mt-4 rounded-r14 bg-coral-bg px-4 py-3 text-sm text-coral">Sign-in is temporarily unavailable. Please try again later.</p>}
    </div>
  );
}

export function AuthFinePrint() {
  return (
    <p className="mt-[22px] text-[12.5px] leading-[1.55] text-muted-2">
      By continuing you agree to our Terms and{' '}
      <Link to="/#privacy" className="underline hover:text-ink">
        Privacy Policy
      </Link>
      . Your resume stays private and you can delete your data at any time.
    </p>
  );
}
