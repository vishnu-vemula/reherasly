import { Link } from 'react-router-dom';
import { cn } from '@/utils';

/** The primary Rehearsly mark supplied by the brand. */
export function LogoMark({ size = 30, className }) {
  return (
    <img
      src="/rehearsly-mark.png"
      alt=""
      width={size}
      height={size}
      className={cn('block flex-shrink-0', className)}
      aria-hidden="true"
    />
  );
}

export default function Logo({ to = '/', tone = 'dark', size = 30, className, onClick }) {
  const content = (
    <>
      <LogoMark size={size} />
      <span
        className={cn(
          'font-semibold tracking-tight1',
          tone === 'light' ? 'text-white' : 'text-ink',
        )}
        style={{ fontSize: size * 0.63 }}
      >
        Rehearsly
      </span>
    </>
  );

  if (!to) {
    return <span className={cn('inline-flex items-center gap-2.5', className)}>{content}</span>;
  }

  return (
    <Link
      to={to}
      onClick={onClick}
      aria-label="Rehearsly home"
      className={cn('inline-flex items-center gap-2.5 rounded-xl hover:text-inherit', className)}
    >
      {content}
    </Link>
  );
}
