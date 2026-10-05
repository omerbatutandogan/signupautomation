import { CircleCheck, CircleDashed, Clock, KeyRound, Minus, ShieldAlert, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { CellState } from '@/lib/panel/matrix';
import { cn } from '@/lib/utils';

/**
 * Durum = ikon + etiket. Renk yalnızca ikonda ve hiçbir zaman tek başına
 * anlam taşımaz; metin her zaman normal mürekkep rengindedir.
 */
type Tone = 'good' | 'warning' | 'serious' | 'neutral';

const TONE: Record<Tone, string> = {
  good: 'text-(--status-good)',
  warning: 'text-(--status-warning)',
  serious: 'text-(--status-serious)',
  neutral: 'text-muted-foreground',
};

interface Status {
  label: string;
  icon: LucideIcon;
  tone: Tone;
  title?: string;
}

function StatusLabel({ status, className }: { status: Status; className?: string }) {
  const Icon = status.icon;
  return (
    <span title={status.title} className={cn('inline-flex items-center gap-1.5 whitespace-nowrap', className)}>
      <Icon aria-hidden className={cn('size-3.5 shrink-0', TONE[status.tone])} />
      {status.label}
    </span>
  );
}

const ACCOUNT_STATUS: Record<string, Status> = {
  opened: { label: 'Opened', icon: CircleCheck, tone: 'good', title: 'Opened by the automation.' },
  already_existed: {
    label: 'Already existed',
    icon: CircleDashed,
    tone: 'neutral',
    title: 'The account was there before the automation ran.',
  },
};

export function AccountStatus({ status }: { status: string }) {
  return <StatusLabel status={ACCOUNT_STATUS[status] ?? { label: status, icon: Minus, tone: 'neutral' }} />;
}

const VERIFICATION: Record<string, Status> = {
  link: { label: 'Email link', icon: CircleCheck, tone: 'good' },
  code: { label: 'Email code', icon: CircleCheck, tone: 'good' },
  none: { label: 'Not required', icon: Minus, tone: 'neutral' },
  unverified: {
    label: 'Unverified',
    icon: TriangleAlert,
    tone: 'serious',
    title: 'The verification email never arrived; the account may be inactive.',
  },
};

export function VerificationStatus({ verification }: { verification: string | null }) {
  return (
    <StatusLabel
      status={
        VERIFICATION[verification ?? ''] ?? {
          label: 'Unknown',
          icon: Minus,
          tone: 'neutral',
          title: 'Not recorded (the account existed before the automation).',
        }
      }
    />
  );
}

const PASSWORD: Record<string, Status> = {
  derived: { label: 'Derived', icon: KeyRound, tone: 'neutral', title: 'Derived from the master secret on the worker; not stored anywhere.' },
  user_held: {
    label: 'Held by user',
    icon: TriangleAlert,
    tone: 'serious',
    title: 'The account existed before the automation; the derived password does NOT work for it.',
  },
};

export function PasswordSource({ source }: { source: string }) {
  return <StatusLabel status={PASSWORD[source] ?? { label: 'Unknown', icon: Minus, tone: 'neutral' }} />;
}


const CELL: Record<CellState, Status> = {
  opened: ACCOUNT_STATUS.opened,
  already_existed: ACCOUNT_STATUS.already_existed,
  ready: { label: 'Ready', icon: Clock, tone: 'neutral', title: 'Verified config, no account yet: waiting in the signup queue.' },
  blocked: {
    label: 'Needs attention',
    icon: TriangleAlert,
    tone: 'serious',
    title: 'The last real signup ended in a final failure. The worker will not retry it on its own.',
  },
  high_risk: { label: 'High risk', icon: ShieldAlert, tone: 'serious', title: 'Excluded from automation by policy.' },
  none: { label: 'Not available', icon: Minus, tone: 'neutral', title: 'No verified config for this site, or the product is not ready.' },
};

/** Ürün × site hücresi. */
export function MatrixCell({ state }: { state: CellState }) {
  return <StatusLabel status={CELL[state]} />;
}

const ATTEMPT: Record<string, Status> = {
  completed: { label: 'Completed', icon: CircleCheck, tone: 'good' },
  failed: { label: 'Failed', icon: TriangleAlert, tone: 'serious' },
  error: { label: 'Error', icon: TriangleAlert, tone: 'serious' },
  manual: { label: 'Needs a human', icon: Clock, tone: 'warning' },
  running: { label: 'Running', icon: Clock, tone: 'neutral' },
};

export function AttemptStatus({ status }: { status: string }) {
  const known = ATTEMPT[status];
  if (known) return <StatusLabel status={known} />;
  // skipped_limit, skipped_done, … — ham durumu okunur yaz.
  return <StatusLabel status={{ label: status.replaceAll('_', ' '), icon: Minus, tone: 'neutral' }} />;
}
