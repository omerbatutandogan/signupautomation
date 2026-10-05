import { SectionPlaceholder } from '@/components/section-placeholder';
import { requireMember } from '@/lib/auth';

export const metadata = { title: 'Overview · Signup Automation Panel' };

export default async function OverviewPage() {
  // Layout istemci tarafı gezinmede yeniden render edilmez; her sayfa
  // üyeliği kendisi kontrol eder (izin kaldırılan kişi gezinmeye devam edemesin).
  await requireMember();
  return (
    <SectionPlaceholder
      title="Overview"
      phase="Phase 1"
      items={[
        'Opened accounts so far and how they were verified',
        'Scan progress across all 22 sheet tabs',
        'Signups used today against the daily limit',
        'Worker status (online / offline since)',
      ]}
    />
  );
}
