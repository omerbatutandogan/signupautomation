import { SectionPlaceholder } from '@/components/section-placeholder';
import { requireMember } from '@/lib/auth';

export const metadata = { title: 'Accounts · Signup Automation Panel' };

export default async function AccountsPage() {
  // Layout istemci tarafı gezinmede yeniden render edilmez; her sayfa
  // üyeliği kendisi kontrol eder (izin kaldırılan kişi gezinmeye devam edemesin).
  await requireMember();
  return (
    <SectionPlaceholder
      title="Accounts"
      phase="Phase 1"
      items={[
        'Every opened account: site, product, email, username, profile link',
        'How it was verified (email link, no verification, already existed)',
        'Secure password reveal (Phase 3) — passwords are never stored',
      ]}
    />
  );
}
