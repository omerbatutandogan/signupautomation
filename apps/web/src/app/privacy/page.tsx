import Link from 'next/link';

export const metadata = { title: 'Privacy policy · Signup Automation Panel' };

/**
 * Gizlilik politikası — Google OAuth uygulamasının istediği sayfa.
 *
 * Metin BUGÜN yapılanı anlatmalı, planlananı değil. Gmail bağlantısı panele
 * taşındığında (Aşama 4: şifreli token, önce yalnızca başlık okuma) bu sayfa
 * o değişiklik yayına çıkmadan önce güncellenmeli.
 */
export default function PrivacyPage() {
  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-16">
      <Link href="/" className="text-sm text-muted-foreground hover:underline">
        ← Back
      </Link>
      <h1 className="mt-6 text-3xl font-semibold tracking-tight">Privacy policy</h1>
      <p className="mt-2 text-sm text-muted-foreground">Last updated: October 1, 2026</p>

      <div className="mt-8 space-y-6 text-base leading-relaxed">
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Who can use this panel</h2>
          <p>
            The Signup Automation Panel is an internal tool operated by the team that uses it. Only team
            members whose Google accounts have been explicitly invited can sign in. It is not offered to
            the public.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Signing in</h2>
          <p>
            Signing in with Google uses only your basic profile (name and email address) to identify you
            and check that you are invited. The panel does not request access to your mailbox or files.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-semibold">The automation worker</h2>
          <p>
            Registrations are carried out by an automation worker running on a computer operated by the
            team. To complete them it uses two Google permissions on dedicated signup accounts:
          </p>
          <ul className="list-disc space-y-1 pl-6">
            <li>
              <strong>Gmail, read-only</strong> — after starting a registration, the worker reads the
              messages that arrived in that mailbox during a short time window to find the verification
              email from the directory site, then opens its verification link. During a registration,
              messages that are not verification emails are skipped without being logged or kept; for
              verification emails, the worker records the message identifier (so the same email is not
              used twice) and logs its sender and subject. Separately, a developer may occasionally save
              recent messages from a signup mailbox on the worker as test samples to improve matching.
            </li>
            <li>
              <strong>Google Sheets</strong> — the worker reads the team&apos;s list of directory sites
              and writes registration status back to that tracking spreadsheet.
            </li>
          </ul>
          <p>
            These access tokens are stored only on the worker computer, not in the panel&apos;s database
            or hosting provider. The worker never sends email. Access can be revoked at any time from the
            Google account&apos;s security settings (myaccount.google.com → Security → Third-party
            access).
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-semibold">What we store</h2>
          <p>
            Your email address and name, and the status of registrations: the site, the account email
            and username used there, and the public profile link. Passwords of registered accounts are
            not stored anywhere; they are derived on demand by the worker.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Changes</h2>
          <p>
            If the way mailboxes are connected changes — for example, connecting a mailbox from inside the
            panel — this page will be updated before that change goes live.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Contact</h2>
          <p>Questions about this policy: ask the person who invited you to the panel.</p>
        </section>
      </div>
    </main>
  );
}
