import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useToast } from '../hooks/useToast';
import { PageHeader } from '../components/PageHeader';
import { changeOwnPassword, getSignedInUser } from '../services/users';
import './Account.css';

const PASSWORD_MIN = 10;

const ERROR_KEYS: Record<string, string> = {
  WRONG_PASSWORD: 'account.wrongPassword',
  SAME_PASSWORD: 'account.samePassword',
  TOO_MANY_ATTEMPTS: 'login.tooManyAttempts',
};

export function Account() {
  const { t } = useTranslation();
  const toast = useToast();
  useDocumentTitle(t('account.title'));
  const user = getSignedInUser();

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!current || !next) {
      setError(t('account.required'));
      return;
    }
    if (next.length < PASSWORD_MIN) {
      setError(t('users.form.passwordTooShort'));
      return;
    }
    if (next !== confirm) {
      setError(t('account.mismatch'));
      return;
    }
    setError('');
    setSaving(true);
    try {
      await changeOwnPassword(current, next);
      setCurrent('');
      setNext('');
      setConfirm('');
      toast.success(t('account.changed'), t('account.changedHint'));
    } catch (err) {
      const code = (err as { code?: string }).code;
      setError(
        code && ERROR_KEYS[code] ? t(ERROR_KEYS[code]) : err instanceof Error ? err.message : t('common.unknownError'),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="account-page">
      <PageHeader title={t('account.title')} subtitle={t('account.subtitle')} />

      <div className="account-grid">
        <section className="account-card">
          <h2>{t('account.profile')}</h2>
          {user ? (
            <dl className="account-profile">
              <dt>{t('users.columns.name')}</dt>
              <dd>{user.name}</dd>
              <dt>{t('users.columns.email')}</dt>
              <dd>{user.email}</dd>
              <dt>{t('users.columns.role')}</dt>
              <dd>
                {t(`apiKeys.roles.${user.role}`)}
                <span className="account-role-hint">{t(`apiKeys.roleDescriptions.${user.role}`)}</span>
              </dd>
            </dl>
          ) : (
            <p className="account-muted">{t('account.noProfile')}</p>
          )}
        </section>

        <section className="account-card">
          <h2>{t('account.changePassword')}</h2>
          <form className="account-form" onSubmit={e => void handleSubmit(e)}>
            <label htmlFor="account-current">{t('account.currentPassword')}</label>
            <input
              id="account-current"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={e => setCurrent(e.target.value)}
            />

            <label htmlFor="account-new">{t('account.newPassword')}</label>
            <input
              id="account-new"
              type="password"
              autoComplete="new-password"
              placeholder={t('users.form.passwordHint')}
              value={next}
              onChange={e => setNext(e.target.value)}
            />

            <label htmlFor="account-confirm">{t('account.confirmPassword')}</label>
            <input
              id="account-confirm"
              type="password"
              autoComplete="new-password"
              placeholder={t('account.confirmPlaceholder')}
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
            />

            {error && (
              <p className="account-error" role="alert">
                {error}
              </p>
            )}

            <button type="submit" className="btn-primary" disabled={saving}>
              {saving ? <Loader2 className="animate-spin" size={16} /> : t('account.save')}
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}
