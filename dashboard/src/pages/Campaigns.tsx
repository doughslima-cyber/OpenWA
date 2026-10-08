import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Clock,
  Loader2,
  Megaphone,
  Plus,
  Upload,
  XCircle,
} from 'lucide-react';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRole } from '../hooks/useRole';
import { useToast } from '../hooks/useToast';
import { useSessionsQuery } from '../hooks/queries';
import {
  useCampaignQuery,
  useCampaignRecipientsQuery,
  useCampaignsQuery,
  useCancelCampaignMutation,
  useCreateCampaignMutation,
} from '../hooks/useCampaigns';
import {
  RECIPIENT_STATUSES,
  type CampaignDetail,
  type CampaignSummary,
  type RecipientStatus,
} from '../services/campaigns';
import { CAMPAIGN_MAX_RECIPIENTS, readCampaignRecipients } from '../utils/campaignRecipients';
import {
  columnLetter,
  columnValues,
  guessPhoneColumn,
  parseDelimited,
  type RecipientTable,
} from '../utils/recipientTable';
import { readXlsx } from '../utils/xlsx';
import { BULK_RECIPIENTS_FILE_MAX_BYTES } from '../utils/bulkRecipients';
import { PageHeader } from '../components/PageHeader';
import { Modal } from '../components/Modal';
import './Campaigns.css';

const NAME_MAX = 100;
const TEXT_MAX = 4096;
/** Recipients per page on the campaign screen: the API's default page size. */
export const RECIPIENTS_PAGE_SIZE = 50;

/** The campaign the operator is about to cancel: from the list or from its own screen. */
type CancelTarget = Pick<CampaignSummary, 'id' | 'name'>;

/** `HH:MM` in the browser's time zone, as criterion 21 writes the next attempt. */
function hourMinute(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** Newest first, whatever order the rows arrive in. */
function newestFirst(rows: CampaignSummary[]): CampaignSummary[] {
  return [...rows].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

interface FormState {
  name: string;
  recipients: string;
  text: string;
}

const emptyForm: FormState = { name: '', recipients: '', text: '' };

/** A loaded file with more than one column, waiting for the operator to say which holds the phone. */
interface FileTable {
  fileName: string;
  rows: RecipientTable;
  column: number;
  header: boolean;
}

/** Rows of the loaded file shown under the column picker. */
const PREVIEW_ROWS = 5;

function readFile(file: File, as: 'text' | 'buffer'): Promise<string | ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => (reader.result === null ? reject(new Error('empty')) : resolve(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    if (as === 'text') reader.readAsText(file);
    else reader.readAsArrayBuffer(file);
  });
}

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
  // On by default: the gateway serves a Brazilian operation, where lists usually omit the 55.
  const [addBrazilCode, setAddBrazilCode] = useState(true);
  const [fileTable, setFileTable] = useState<FileTable | null>(null);
  const [cancelling, setCancelling] = useState<CancelTarget | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const sortedCampaigns = useMemo(() => newestFirst(campaigns), [campaigns]);

  // A campaign belongs to one session: switching sessions goes back to that session's list.
  useEffect(() => {
    setOpenId(null);
  }, [sessionId]);

  const read = useMemo(
    () => readCampaignRecipients(form.recipients, { addBrazilCode }),
    [form.recipients, addBrazilCode],
  );
  const accepted = read.ids;
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
    setFileTable(null);
    setConfirmingStart(false);
    setCreating(true);
  };

  const closeCreate = () => {
    if (createMutation.isPending) return;
    setConfirmingStart(false);
    setCreating(false);
  };

  const appendRecipients = (values: string[]) => {
    if (values.length === 0) return;
    setForm(prev => ({
      ...prev,
      recipients: (prev.recipients.trim() ? `${prev.recipients.trimEnd()}\n` : '') + values.join('\n'),
    }));
  };

  const handleFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setFormError('');
    // Refused before reading, as on the Message Tester: FileReader would hold the whole file in memory.
    if (file.size > BULK_RECIPIENTS_FILE_MAX_BYTES) {
      setFormError(t('campaigns.form.fileTooLarge'));
      return;
    }
    const name = file.name.toLowerCase();
    if (name.endsWith('.xls')) {
      setFormError(t('campaigns.form.xlsUnsupported'));
      return;
    }
    let rows: RecipientTable;
    try {
      rows = name.endsWith('.xlsx')
        ? await readXlsx((await readFile(file, 'buffer')) as ArrayBuffer)
        : parseDelimited((await readFile(file, 'text')) as string);
    } catch {
      setFormError(t('campaigns.form.fileReadError'));
      return;
    }
    if (rows.length === 0) return;
    // One column needs no choice; a header cell in it has no digits and is dropped by the parser.
    if (Math.max(...rows.map(row => row.length)) <= 1) {
      appendRecipients(columnValues(rows, 0, false));
      return;
    }
    setFileTable({ fileName: file.name, rows, ...guessPhoneColumn(rows) });
  };

  const applyFileColumn = () => {
    if (!fileTable) return;
    appendRecipients(columnValues(fileTable.rows, fileTable.column, fileTable.header));
    setFileTable(null);
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

  const renderCancelButton = (campaign: CancelTarget) => (
    <button
      className="btn-icon"
      onClick={() => setCancelling({ id: campaign.id, name: campaign.name })}
      aria-label={t('campaigns.cancelAria', { name: campaign.name })}
      title={t('campaigns.cancelBtn')}
    >
      <XCircle size={16} />
    </button>
  );

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

      {openId && sessionId ? (
        <CampaignScreen
          sessionId={sessionId}
          campaignId={openId}
          canWrite={canWrite}
          onBack={() => setOpenId(null)}
          onCancel={campaign => setCancelling({ id: campaign.id, name: campaign.name })}
          formatDate={formatDate}
        />
      ) : (
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
                {sortedCampaigns.map(campaign => (
                  <tr key={campaign.id}>
                    <td className="campaigns-name">
                      <button
                        type="button"
                        className="campaigns-link"
                        onClick={() => setOpenId(campaign.id)}
                        title={t('campaigns.openAria', { name: campaign.name })}
                      >
                        {campaign.name}
                      </button>
                    </td>
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
                        {campaign.status === 'running' && renderCancelButton(campaign)}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

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
              accept=".csv,.txt,.xlsx,text/csv,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={e => void handleFile(e)}
            />
          </div>
          <p className="campaigns-hint">{t('campaigns.form.recipientsHint')}</p>

          {fileTable && (
            <section className="campaigns-column-picker" aria-label={t('campaigns.form.columnPickerTitle')}>
              <p className="campaigns-column-title">
                {t('campaigns.form.columnPickerTitle')} <strong>{fileTable.fileName}</strong>
              </p>
              <div className="campaigns-column-controls">
                <label htmlFor="campaign-column">{t('campaigns.form.phoneColumn')}</label>
                <select
                  id="campaign-column"
                  value={fileTable.column}
                  onChange={e => setFileTable({ ...fileTable, column: Number(e.target.value) })}
                >
                  {Array.from({ length: Math.max(...fileTable.rows.map(row => row.length)) }, (_, i) => (
                    <option key={i} value={i}>
                      {fileTable.header && fileTable.rows[0][i]
                        ? `${columnLetter(i)} — ${fileTable.rows[0][i]}`
                        : columnLetter(i)}
                    </option>
                  ))}
                </select>
                <span className="campaigns-checkbox-row">
                  <input
                    id="campaign-header"
                    type="checkbox"
                    checked={fileTable.header}
                    onChange={e => setFileTable({ ...fileTable, header: e.target.checked })}
                  />
                  <label htmlFor="campaign-header">{t('campaigns.form.firstRowHeader')}</label>
                </span>
              </div>
              <div className="campaigns-preview-wrap">
                <table className="campaigns-preview">
                  <tbody>
                    {fileTable.rows.slice(0, PREVIEW_ROWS + (fileTable.header ? 1 : 0)).map((row, r) => (
                      <tr key={r} className={fileTable.header && r === 0 ? 'campaigns-preview-header' : undefined}>
                        {row.map((cell, c) => (
                          <td key={c} className={c === fileTable.column ? 'campaigns-preview-selected' : undefined}>
                            {cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="campaigns-column-actions">
                <button type="button" className="btn-secondary" onClick={() => setFileTable(null)}>
                  {t('campaigns.form.discardFile')}
                </button>
                <button type="button" className="btn-primary" onClick={applyFileColumn}>
                  {t('campaigns.form.useColumn', {
                    total: columnValues(fileTable.rows, fileTable.column, fileTable.header).length,
                  })}
                </button>
              </div>
            </section>
          )}

          <div className="campaigns-checkbox-row">
            <input
              id="campaign-brazil-code"
              type="checkbox"
              checked={addBrazilCode}
              onChange={e => setAddBrazilCode(e.target.checked)}
            />
            <label htmlFor="campaign-brazil-code">{t('campaigns.form.addBrazilCode')}</label>
          </div>
          {addBrazilCode && read.withBrazilCode > 0 && (
            <p className="campaigns-hint">{t('campaigns.form.brazilCodeAdded', { total: read.withBrazilCode })}</p>
          )}

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

interface CampaignScreenProps {
  sessionId: string;
  campaignId: string;
  canWrite: boolean;
  onBack: () => void;
  onCancel: (campaign: CampaignDetail) => void;
  formatDate: (iso: string) => string;
}

/**
 * One campaign: counters by status, why it is not sending, and its recipients filtered by status and
 * paged. Read again every 5 s while it runs (useCampaignQuery), so progress shows without a reload.
 */
function CampaignScreen({ sessionId, campaignId, canWrite, onBack, onCancel, formatDate }: CampaignScreenProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<RecipientStatus | ''>('');
  const [offset, setOffset] = useState(0);
  const { data: campaign, isLoading, error, refetch } = useCampaignQuery(sessionId, campaignId);
  const running = campaign?.status === 'running';
  const recipientQuery = useMemo(
    () => ({ ...(status ? { status } : {}), limit: RECIPIENTS_PAGE_SIZE, offset }),
    [status, offset],
  );
  const {
    data: page,
    isLoading: loadingRecipients,
    error: recipientsError,
  } = useCampaignRecipientsQuery(sessionId, campaignId, recipientQuery, running);

  const backButton = (
    <button type="button" className="btn-secondary campaigns-back" onClick={onBack}>
      <ArrowLeft size={16} />
      {t('campaigns.detail.back')}
    </button>
  );

  if (isLoading) {
    return (
      <div className="campaigns-detail">
        {backButton}
        <div className="campaigns-empty">
          <Loader2 className="animate-spin" size={32} />
        </div>
      </div>
    );
  }

  if (error || !campaign) {
    return (
      <div className="campaigns-detail">
        {backButton}
        <div className="campaigns-empty" role="alert">
          <AlertCircle size={48} strokeWidth={1} />
          <h3>{t('campaigns.detail.loadError')}</h3>
          <p>{error?.message}</p>
          <button className="btn-secondary" onClick={() => void refetch()}>
            {t('common.retry')}
          </button>
        </div>
      </div>
    );
  }

  let waitText: string | null = null;
  if (running && campaign.waiting) {
    const { reason, nextAttemptAt } = campaign.waiting;
    if (reason !== 'pacing') waitText = t(`campaigns.waiting.${reason}`);
    else if (nextAttemptAt) waitText = t('campaigns.waiting.pacing', { time: hourMinute(nextAttemptAt) });
    else waitText = t('campaigns.waiting.pacingNoTime');
  }

  const total = page?.total ?? 0;
  const items = page?.items ?? [];
  const from = total === 0 ? 0 : offset + 1;
  const to = offset + items.length;

  return (
    <div className="campaigns-detail">
      {backButton}

      <section className="campaigns-card campaigns-detail-header">
        <div>
          <h2 className="campaigns-detail-title">{campaign.name}</h2>
          <p className="campaigns-muted">{t('campaigns.detail.createdAt', { date: formatDate(campaign.createdAt) })}</p>
        </div>
        <div className="campaigns-detail-actions">
          <span className={`campaigns-status campaigns-status--${campaign.status}`}>
            {t(`campaigns.status.${campaign.status}`)}
          </span>
          {canWrite && running && (
            <button
              className="btn-danger"
              onClick={() => onCancel(campaign)}
              aria-label={t('campaigns.cancelAria', { name: campaign.name })}
            >
              <XCircle size={16} />
              {t('campaigns.cancelBtn')}
            </button>
          )}
        </div>
      </section>

      {waitText && (
        <p className="campaigns-waiting" role="status">
          <Clock size={16} />
          {waitText}
        </p>
      )}

      <dl className="campaigns-counters">
        <div className="campaigns-counter">
          <dt>{t('campaigns.detail.total')}</dt>
          <dd data-testid="campaign-count-total">{campaign.counts.total}</dd>
        </div>
        {RECIPIENT_STATUSES.map(key => (
          <div key={key} className={`campaigns-counter campaigns-counter--${key}`}>
            <dt>{t(`campaigns.recipientStatus.${key}`)}</dt>
            <dd data-testid={`campaign-count-${key}`}>{campaign.counts[key]}</dd>
          </div>
        ))}
      </dl>

      <div className="campaigns-card campaigns-detail-text">
        <span className="campaigns-detail-label">{t('campaigns.detail.message')}</span>
        <p>{campaign.text}</p>
      </div>

      <section className="campaigns-card">
        <div className="campaigns-recipients-toolbar">
          <h3>{t('campaigns.detail.recipients')}</h3>
          <select
            aria-label={t('campaigns.detail.filter')}
            value={status}
            onChange={event => {
              setStatus(event.target.value as RecipientStatus | '');
              setOffset(0);
            }}
          >
            <option value="">{t('campaigns.detail.allStatuses')}</option>
            {RECIPIENT_STATUSES.map(key => (
              <option key={key} value={key}>
                {t(`campaigns.recipientStatus.${key}`)}
              </option>
            ))}
          </select>
        </div>

        {recipientsError ? (
          <div className="campaigns-empty" role="alert">
            <p>{recipientsError.message}</p>
          </div>
        ) : loadingRecipients ? (
          <div className="campaigns-empty">
            <Loader2 className="animate-spin" size={24} />
          </div>
        ) : items.length === 0 ? (
          <div className="campaigns-empty">
            <p>{t('campaigns.detail.empty')}</p>
          </div>
        ) : (
          <div className="campaigns-table-scroll">
            <table className="campaigns-table">
              <thead>
                <tr>
                  <th>{t('campaigns.detail.columns.number')}</th>
                  <th>{t('campaigns.detail.columns.status')}</th>
                  <th>{t('campaigns.detail.columns.sentAt')}</th>
                  <th>{t('campaigns.detail.columns.repliedAt')}</th>
                  <th>{t('campaigns.detail.columns.error')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map(item => (
                  <tr key={item.chatId}>
                    <td className="campaigns-number">{item.chatId.split('@')[0]}</td>
                    <td>
                      <span className={`campaigns-status campaigns-status--r-${item.status}`}>
                        {t(`campaigns.recipientStatus.${item.status}`)}
                      </span>
                    </td>
                    <td className="campaigns-muted">{item.sentAt ? formatDate(item.sentAt) : '-'}</td>
                    <td className="campaigns-muted">{item.repliedAt ? formatDate(item.repliedAt) : '-'}</td>
                    <td className="campaigns-error-code" title={item.error?.message}>
                      {item.error?.code ?? '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="campaigns-pager">
          <span className="campaigns-muted">{t('campaigns.detail.range', { from, to, total })}</span>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setOffset(Math.max(0, offset - RECIPIENTS_PAGE_SIZE))}
            disabled={offset === 0}
          >
            <ChevronLeft size={16} />
            {t('campaigns.detail.previous')}
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setOffset(offset + RECIPIENTS_PAGE_SIZE)}
            disabled={offset + RECIPIENTS_PAGE_SIZE >= total}
          >
            {t('campaigns.detail.next')}
            <ChevronRight size={16} />
          </button>
        </div>
      </section>
    </div>
  );
}
