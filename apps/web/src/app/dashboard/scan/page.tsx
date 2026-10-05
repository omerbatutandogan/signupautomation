import { SectionPlaceholder } from '@/components/section-placeholder';
import { requireMember } from '@/lib/auth';

export const metadata = { title: 'Scan map · Signup Automation Panel' };

export default async function ScanPage() {
  // Layout istemci tarafı gezinmede yeniden render edilmez; her sayfa
  // üyeliği kendisi kontrol eder (izin kaldırılan kişi gezinmeye devam edemesin).
  await requireMember();
  return (
    <SectionPlaceholder
      title="Scan map"
      phase="Phase 1"
      items={[
        'Every sheet tab × discovery outcome: automatable, bot-protected, submit form, email-first, dead, no form',
        'Live progress of the running scan',
        'Config state per site: unverified draft, awaiting move approval, verified',
      ]}
    />
  );
}
