import { SectionPlaceholder } from '@/components/section-placeholder';
import { requireMember } from '@/lib/auth';

export const metadata = { title: 'Queue · Signup Automation Panel' };

export default async function QueuePage() {
  // Layout istemci tarafı gezinmede yeniden render edilmez; her sayfa
  // üyeliği kendisi kontrol eder (izin kaldırılan kişi gezinmeye devam edemesin).
  await requireMember();
  return (
    <SectionPlaceholder
      title="Queue"
      phase="Phase 1 → 3"
      items={[
        'Verified sites waiting for a real signup, per product',
        'Daily limit usage and estimated finish date',
        'Start dry-runs and signups from here, with live progress (Phase 3)',
      ]}
    />
  );
}
