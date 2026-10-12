// The official Meta API section of a session's detail (OpenMsg, docs/32 F3): the number as Graph
// reports it, the stored token as its last 4 characters, the webhook URL to register with Meta, and
// Change token. Never shows the webhook verify token, only the variable that holds it.
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Copy, Loader2 } from 'lucide-react';
import { metaAccountKey, useMetaAccount } from '../../hooks/useMetaCloud';
import { useToast } from '../../hooks/useToast';
import { metaCloudApi, metaErrorText } from '../../services/metaCloud';
import { copyToClipboard } from '../../utils/clipboard';

interface MetaCloudAccountPanelProps {
  sessionId: string;
  canWrite: boolean;
}

function MetaCloudAccountPanel({ sessionId, canWrite }: MetaCloudAccountPanelProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const account = useMetaAccount(sessionId, true);
  const [newToken, setNewToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const handleChangeToken = async () => {
    const token = newToken.trim();
    if (!token) return;
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await metaCloudApi.updateToken(sessionId, token);
      queryClient.setQueryData(metaAccountKey(sessionId), updated);
      setNewToken('');
      toast.success(t('metaCloud.account.tokenChanged'), t('metaCloud.account.tokenChangedDesc'));
    } catch (err) {
      setSaveError(metaErrorText(t, err) ?? t('common.unknownError'));
    } finally {
      setSaving(false);
    }
  };

  const handleCopy = async (url: string) => {
    if (await copyToClipboard(url)) toast.success(t('metaCloud.account.copied'));
  };

  const row = (label: string, value: string | null) => (
    <div className="detail-item">
      <span className="detail-label">{label}</span>
      <span className="detail-value">{value || '—'}</span>
    </div>
  );

  return (
    <section className="meta-cloud-account" aria-label={t('metaCloud.account.title')}>
      <h3 className="meta-cloud-account-title">{t('metaCloud.account.title')}</h3>
      {account.isLoading ? (
        <p className="meta-cloud-account-state">
          <Loader2 className="animate-spin" size={16} /> {t('metaCloud.account.loading')}
        </p>
      ) : account.isError ? (
        <p className="meta-cloud-account-error" role="alert">
          {metaErrorText(t, account.error) ?? t('common.unknownError')}
        </p>
      ) : account.data ? (
        <div className="detail-grid">
          {row(t('metaCloud.account.displayPhoneNumber'), account.data.displayPhoneNumber)}
          {row(t('metaCloud.account.verifiedName'), account.data.verifiedName)}
          {row(t('metaCloud.account.qualityRating'), account.data.qualityRating)}
          {row(t('metaCloud.account.messagingLimitTier'), account.data.messagingLimitTier)}
          {row(
            t('metaCloud.account.token'),
            account.data.accessTokenLast4 ? `•••• ${account.data.accessTokenLast4}` : t('metaCloud.account.tokenNone'),
          )}
          <div className="detail-item meta-cloud-webhook">
            <span className="detail-label">{t('metaCloud.account.webhookUrl')}</span>
            <div className="meta-cloud-webhook-row">
              <span className="detail-value mono">{account.data.webhookUrl}</span>
              <button
                type="button"
                className="btn-sm meta-cloud-copy"
                onClick={() => void handleCopy(account.data!.webhookUrl)}
              >
                <Copy size={14} />
                {t('metaCloud.account.copy')}
              </button>
            </div>
            <small className="detail-hint">{t('metaCloud.account.webhookHint')}</small>
          </div>
          {canWrite && (
            <div className="detail-item meta-cloud-token-form">
              <label className="detail-label" htmlFor={`meta-new-token-${sessionId}`}>
                {t('metaCloud.account.newToken')}
              </label>
              <div className="meta-cloud-webhook-row">
                <input
                  id={`meta-new-token-${sessionId}`}
                  type="password"
                  autoComplete="off"
                  value={newToken}
                  onChange={e => setNewToken(e.target.value)}
                />
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => void handleChangeToken()}
                  disabled={!newToken.trim() || saving}
                >
                  {saving ? <Loader2 className="animate-spin" size={16} /> : t('metaCloud.account.changeToken')}
                </button>
              </div>
              {saveError && (
                <p className="meta-cloud-account-error" role="alert">
                  {saveError}
                </p>
              )}
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}

export default MetaCloudAccountPanel;
