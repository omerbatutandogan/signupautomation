import { SectionPlaceholder } from '@/components/section-placeholder';
import { requireMember } from '@/lib/auth';

export const metadata = { title: 'Products · Signup Automation Panel' };

export default async function ProductsPage() {
  // Layout istemci tarafı gezinmede yeniden render edilmez; her sayfa
  // üyeliği kendisi kontrol eder (izin kaldırılan kişi gezinmeye devam edemesin).
  await requireMember();
  return (
    <SectionPlaceholder
      title="Products"
      phase="Phase 2"
      items={[
        'Create and edit product profiles (name, website, descriptions, category, logo)',
        'Assign each product its own Gmail mailbox (Phase 4)',
        'Product × site progress matrix',
      ]}
    />
  );
}
