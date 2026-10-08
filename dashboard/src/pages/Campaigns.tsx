import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { AlertCircle, AlertTriangle, Loader2, Megaphone, Plus, Upload, XCircle } from 'lucide-react';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRole } from '../hooks/useRole';
import { useToast } from '../hooks/useToast';
import { useSessionsQuery } from '../hooks/queries';
import { useCampaignsQuery, useCancelCampaignMutation, useCreateCampaignMutation } from '../hooks/useCampaigns';
import type { CampaignSummary } from '../services/campaigns';
import { CAMPAIGN_MAX_RECIPIENTS, parseCampaignRecipients } from '../utils/campaignRecipients';
import { BULK_RECIPIENTS_FILE_MAX_BYTES } from '../utils/bulkRecipients';
import { PageHeader } from '../components/PageHeader';
import { Modal } from '../components/Modal';
import './Campaigns.css';

const NAME_MAX = 100;
const TEXT_MAX = 4096;

interface FormState {
  name: string;
  recipients: string;
  text: string;
}

const emptyForm: FormState = { name: '', recipients: '', text: '' };

export function Campaigns() {
  const { t, i18n } = useTranslation();
  useDocumentTitle(t('campaigns.title'));
  const toast = useToast();
  const { canWrite } = useRole();
  const { data: sessions = [], isLoading: loadingSessions, error: sessionsError } = useSessionsQuery();
  const sessionsFailed = !!sessionsError && sessions.length === 0;
  const [sessionId, setSessionId] = useState('');

  // Select the first session, and again once the selected one is gone (as on Templates).
  useEffect(() => {
    if (sessions.some(session => session.id === sessionId)) return;
    const next = sessions[0]?.id ?? '';
    if (next !== sessionId) setSessionId(next);
  }, [sessionId, sessions]);

  const {
    data: campaigns = [],
    isLoading: loadingCampaigns,
    error: campaignsError,
    refetch,
  } = useCampaignsQuery(sessionId);
  const createMutation = useCreateCampaignMutation(sessionId);
  const cancelMutation = useCancelCampaignMutation(sessionId);

  const [creating, setCreating] = useState(false);
  const [confirmingStart, setConfirmingStart] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [formError, setFormError] = useState('');
  const [cancelling, setCancelling] = useState<CampaignSummary | null>(null);

  const accepted = useMemo(() => parseCampaignRecipients(form.recipients), [form.recipients]);
  const tooMany = accepted.length > CAMPAIGN_MAX_RECIPIENTS;
  const canStart =
    accepted.length > 0 &&
    !tooMany &&
    form.name.trim().length > 0 &&
    form.name.length <= NAME_MAX &&
    form.text.trim().length > 0 &&
    form.text.length <= TEXT_MAX;
  const sessionName = sessions.find(session => session.id === sessionId)?.name ?? sessionId;

  const errorText = (err: unknown, fallbackKey: string): string => {
    const code = (err as { code?: string }).code;
    if (code && i18n.exists(`campaigns.errors.${code}`)) return t(`campaigns.errors.${code}`);
    return err instanceof Error && err.message ? err.message : t(fallbackKey);
  };

  const openCreate = () => {
    setForm(emptyForm);
    setFormError('');
    setConfirmingStart(false);
    setCreating(true);
  };

  const closeCreate = () => {
    if (createMutation.isPending) return;
    setConfirmingStart(false);
    setCreating(false);
  };

  const handleFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    // Refused before reading, as on the Message Tester: FileReader would hold the whole file as a string.
    if (file.size > BULK_RECIPIENTS_FILE_MAX_BYTES) {
      setFormError(t('campaigns.form.fileTooLarge'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result;
      if (typeof text !== 'string' || !text.trim()) return;
      setForm(prev => ({
        ...prev,
        recipients: (prev.recipients.trim() ? `${prev.recipients.trimEnd()}\n` : '') + text.trim(),
      }));
    };
    reader.onerror = () => setFormError(t('campaigns.form.fileReadError'));
    reader.readAsText(file);
  };

  const handleStart = async () => {
    setFormError('');
    try {
      await createMutation.mutateAsync({ name: form.name.trim(), text: form.text, recipients: accepted });
      toast.success(t('campaigns.toast.created'));
      setConfirmingStart(false);
      setCreating(false);
    } catch (err) {
      setConfirmingStart(false);
      setFormError(errorText(err, 'campaigns.toast.createError'));
    }
  };

  const handleCancel = async () => {
    if (!cancelling) return;
    try {
      await cancelMutation.mutateAsync(cancelling.id);
      toast.success(t('campaigns.toast.cancelled'));
    } catch (err) {
      toast.error(t('campaigns.toast.cancelError'), errorText(err, 'common.unknownError'));
    }
    setCancelling(null);
  };

  const formatDate = (iso: string) => new Date(iso).toLocaleString(i18n.resolvedLanguage || i18n.language);

  if (loadingSessions) {
    return (
      <div className="campaigns-page campaigns-page--loading">
        <Loader2 className="animate-spin" size={32} />
      </div>
    );
  }

  return (
    <div className="campaigns-page">
      <PageHeader
        title={t('campaigns.title')}
        subtitle={t('campaigns.subtitle')}
        actions={
          <div className="campaigns-header-actions">
            <select
              className="campaigns-session-select"
              aria-label={t('campaigns.sessionSelect')}
              value={sessionId}
              onChange={event => setSessionId(event.target.value)}
            >
              {sessions.length === 0 && (
                <option value="">{t(sessionsFailed ? 'campaigns.loadError' : 'campaigns.noSessions')}</option>
              )}
              {sessions.map(session => (
                <option key={session.id} value={session.id}>
                  {session.name}
                </option>
              ))}
            </select>
            {canWrite && sessionId && (
              <button className="btn-primary" onClick={openCreate}>
                <Plus size={18} />
                {t('campaigns.newBtn')}
              </button>
            )}
          </div>
        }
      />

      <div className="campaigns-table-container">
        {sessionsFailed || campaignsError ? (
          <div className="campaigns-empty" role="alert">
            <AlertCircle size={48} strokeWidth={1} />
            <h3>{t('campaigns.loadError')}</h3>
            <p>{(sessionsError ?? campaignsError)?.message}</p>
            {campaignsError && (
              <button className="btn-secondary" onClick={() => void refetch()}>
                {t('common.retry')}
              </button>
            )}
          </div>
        ) : loadingCampaigns && sessionId ? (
          <div className="campaigns-empty">
            <Loader2 className="animate-spin" size={32} />
          </div>
        ) : campaigns.length === 0 ? (
          <div className="campaigns-empty">
            <Megaphone size={48} strokeWidth={1} />
            <h3>{t(sessions.length === 0 ? 'campaigns.noSessions' : 'campaigns.empty')}</h3>
          </div>
        ) : (
          <table className="campaigns-table">
            <thead>
              <tr>
                <th>{t('campaigns.columns.name')}</th>
                <th>{t('campaigns.columns.status')}</th>
                <th>{t('campaigns.columns.sent')}</th>
                <th>{t('campaigns.columns.failed')}</th>
                <th>{t('campaigns.columns.replied')}</th>
                <th>{t('campaigns.columns.createdAt')}</th>
                {canWrite && <th className="campaigns-actions-col">{t('campaigns.columns.actions')}</th>}
              </tr>
            </thead>
            <tbody>
              {campaigns.map(campaign => (
                <tr key={campaign.id}>
                  <td className="campaigns-name">{campaign.name}</td>
                  <td>
                    <span className={`campaigns-status campaigns-status--${campaign.status}`}>
                      {t(`campaigns.status.${campaign.status}`)}
                    </span>
                  </td>
                  <td>
                    {campaign.counts.sent + campaign.counts.replied}/{campaign.counts.total}
                  </td>
                  <td>{campaign.counts.failed}</td>
                  <td>{campaign.counts.replied}</td>
                  <td className="campaigns-muted">{formatDate(campaign.createdAt)}</td>
                  {canWrite && (
                    <td className="campaigns-actions-col">
                      {campaign.status === 'running' && (
                        <button
                          className="btn-icon"
                          onClick={() => setCancelling(campaign)}
                          aria-label={t('campaigns.cancelAria', { name: campaign.name })}
                          title={t('campaigns.cancelBtn')}
                        >
                          <XCircle size={16} />
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {creating && !confirmingStart && (
        <Modal
          open
          onClose={closeCreate}
          title={t('campaigns.form.title')}
          closeLabel={t('common.close')}
          footer={
            <>
              <button className="btn-secondary" onClick={closeCreate}>
                {t('common.cancel')}
              </button>
              <button className="btn-primary" onClick={() => setConfirmingStart(true)} disabled={!canStart}>
                {t('campaigns.form.start')}
              </button>
            </>
          }
        >
          <label htmlFor="campaign-name">{t('campaigns.form.name')}</label>
          <input
            id="campaign-name"
            type="text"
            maxLength={NAME_MAX}
            placeholder={t('campaigns.form.namePlaceholder')}
            value={form.name}
            onChange={e => setForm({ ...form, name: e.target.value })}
          />

          <label htmlFor="campaign-recipients">{t('campaigns.form.recipients')}</label>
          <textarea
            id="campaign-recipients"
            rows={6}
            placeholder={t('campaigns.form.recipientsPlaceholder')}
            value={form.recipients}
            onChange={e => setForm({ ...form, recipients: e.target.value })}
          />
          <div className="campaigns-recipients-row">
            <span className={tooMany ? 'campaigns-count campaigns-count--over' : 'campaigns-count'}>
              {tooMany
                ? t('campaigns.form.tooMany', { max: CAMPAIGN_MAX_RECIPIENTS, total: accepted.length })
                : t('campaigns.form.recipientsCount', { total: accepted.length })}
            </span>
            <label htmlFor="campaign-file" className="btn-secondary campaigns-file-btn">
              <Upload size={16} />
              {t('campaigns.form.loadFile')}
            </label>
            <input
              id="campaign-file"
              className="campaigns-file-input"
              type="file"
              accept=".csv,.txt,text/csv,text/plain"
              onChange={handleFile}
            />
          </div>
          <p className="campaigns-hint">{t('campaigns.form.recipientsHint')}</p>

          <label htmlFor="campaign-text">{t('campaigns.form.text')}</label>
          <textarea
            id="campaign-text"
            rows={5}
            maxLength={TEXT_MAX}
            value={form.text}
            onChange={e => setForm({ ...form, text: e.target.value })}
          />

          {formError && (
            <p className="campaigns-form-error" role="alert">
              {formError}
            </p>
          )}
        </Modal>
      )}

      {creating && confirmingStart && (
        <Modal
          open
          onClose={() => !createMutation.isPending && setConfirmingStart(false)}
          hideCloseButton={createMutation.isPending}
          title={t('campaigns.confirmStart.title')}
          className="confirm-modal"
          closeLabel={t('common.close')}
          footer={
            <>
              <button
                className="btn-secondary"
                onClick={() => setConfirmingStart(false)}
                disabled={createMutation.isPending}
              >
                {t('common.back')}
              </button>
              <button className="btn-primary" onClick={() => void handleStart()} disabled={createMutation.isPending}>
                {createMutation.isPending ? (
                  <Loader2 className="animate-spin" size={16} />
                ) : (
                  t('campaigns.confirmStart.confirm')
                )}
              </button>
            </>
          }
        >
          <p className="confirm-message">
            <Trans
              i18nKey="campaigns.confirmStart.message"
              values={{ total: accepted.length, session: sessionName }}
              components={{ strong: <strong /> }}
            />
          </p>
        </Modal>
      )}

      {cancelling && (
        <Modal
          open
          onClose={() => setCancelling(null)}
          title={t('campaigns.confirmCancel.title')}
          className="confirm-modal"
          closeLabel={t('common.close')}
          footer={
            <>
              <button className="btn-secondary" onClick={() => setCancelling(null)}>
                {t('campaigns.confirmCancel.keep')}
              </button>
              <button className="btn-danger" onClick={() => void handleCancel()} disabled={cancelMutation.isPending}>
                {t('campaigns.confirmCancel.confirm')}
              </button>
            </>
          }
        >
          <div className="confirm-icon-wrapper">
            <AlertTriangle size={48} className="confirm-warning-icon" />
          </div>
          <p className="confirm-message">
            <Trans
              i18nKey="campaigns.confirmCancel.message"
              values={{ name: cancelling.name }}
              components={{ strong: <strong /> }}
            />
          </p>
        </Modal>
      )}
    </div>
  );
}
