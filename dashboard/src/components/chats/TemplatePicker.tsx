// The approved-template picker of a WhatsApp Cloud API chat (OpenMsg, docs/32 F3): the only message
// Meta accepts once the customer's 24-hour window has closed. Lists the account's APPROVED templates,
// asks for one value per body placeholder, previews the body and sends it.
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, RefreshCw } from 'lucide-react';
import { Modal } from '../Modal';
import { useMetaTemplates } from '../../hooks/useMetaCloud';
import { useToast } from '../../hooks/useToast';
import {
  metaCloudApi,
  metaErrorText,
  type MetaTemplate,
  type MetaTemplateComponent,
  type SendMetaTemplateBody,
} from '../../services/metaCloud';

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
const MEDIA_FORMATS = new Set(['IMAGE', 'VIDEO', 'DOCUMENT', 'LOCATION']);
const PARAMETER_BUTTONS = new Set(['COPY_CODE', 'OTP']);
const FILLABLE_COMPONENTS = new Set(['HEADER', 'BODY', 'FOOTER', 'BUTTONS']);

const componentOf = (template: MetaTemplate, type: string): MetaTemplateComponent | undefined =>
  template.components.find(c => c.type === type);

function bodyText(template: MetaTemplate): string {
  return componentOf(template, 'BODY')?.text ?? '';
}

/** The body's placeholders in order: `1`, `2`, ... for a positional template, names for a named one. */
function placeholdersOf(template: MetaTemplate): string[] {
  const found = [...new Set([...bodyText(template).matchAll(PLACEHOLDER)].map(m => m[1]))];
  return isNamed(template) ? found : found.sort((a, b) => Number(a) - Number(b));
}

function isNamed(template: MetaTemplate): boolean {
  return template.parameterFormat === 'NAMED';
}

/**
 * Only the body can be filled in here: a header with media or a variable, or a button that takes a
 * parameter, needs values this picker does not ask for (doc 32 F4).
 */
function isSendable(template: MetaTemplate): boolean {
  // A CAROUSEL nests per-card media and buttons, and Meta adds component types over time: anything
  // beyond these four needs values this picker cannot ask for.
  if (template.components.some(c => !FILLABLE_COMPONENTS.has(c.type))) return false;
  const header = componentOf(template, 'HEADER');
  if (header && (MEDIA_FORMATS.has(header.format ?? '') || (header.text ?? '').includes('{{'))) return false;
  const buttons = componentOf(template, 'BUTTONS')?.buttons ?? [];
  return !buttons.some(b => PARAMETER_BUTTONS.has(b.type) || (b.url ?? '').includes('{{'));
}

function render(text: string, values: Record<string, string>): string {
  return text.replace(PLACEHOLDER, (whole, key: string) => values[key] || whole);
}

const keyOf = (t: MetaTemplate) => `${t.name}:${t.language}`;

interface TemplatePickerProps {
  sessionId: string;
  chatId: string;
  onClose: () => void;
  /** The send was accepted: its message id and the body the customer receives. */
  onSent: (messageId: string, body: string) => void;
}

function TemplatePicker({ sessionId, chatId, onClose, onSent }: TemplatePickerProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const templates = useMetaTemplates(sessionId);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);

  const approved = useMemo(
    () =>
      (templates.data?.templates ?? [])
        .filter(tpl => tpl.status === 'APPROVED')
        .sort((a, b) => a.name.localeCompare(b.name) || a.language.localeCompare(b.language)),
    [templates.data],
  );
  const selected = approved.find(tpl => keyOf(tpl) === selectedKey) ?? null;
  const placeholders = selected ? placeholdersOf(selected) : [];
  const complete = placeholders.every(p => (values[p] ?? '').trim());
  const canSend = !!selected && isSendable(selected) && complete && !sending;

  const select = (tpl: MetaTemplate) => {
    setSelectedKey(keyOf(tpl));
    setValues({});
  };

  const handleSend = async () => {
    if (!selected || !canSend) return;
    const body: SendMetaTemplateBody = { chatId, name: selected.name, language: selected.language };
    if (placeholders.length) {
      body.parameters = isNamed(selected)
        ? Object.fromEntries(placeholders.map(p => [p, values[p]]))
        : placeholders.map(p => values[p]);
    }
    setSending(true);
    try {
      const result = await metaCloudApi.sendTemplate(sessionId, body);
      toast.success(t('metaCloud.templates.sentTitle'));
      onSent(result.messageId, render(bodyText(selected), values));
      onClose();
    } catch (err) {
      toast.error(t('metaCloud.templates.errorTitle'), metaErrorText(t, err));
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      className="template-picker"
      title={t('metaCloud.templates.title')}
      closeLabel={t('common.close')}
      headerExtra={
        <button
          type="button"
          className="btn-secondary template-picker-refresh"
          onClick={() => void templates.refresh()}
          disabled={templates.isFetching}
        >
          <RefreshCw size={14} />
          {t('metaCloud.templates.refresh')}
        </button>
      }
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn-primary" onClick={() => void handleSend()} disabled={!canSend}>
            {sending ? <Loader2 className="animate-spin" size={16} /> : t('metaCloud.templates.send')}
          </button>
        </>
      }
    >
      {templates.isLoading ? (
        <div className="template-picker-state">
          <Loader2 className="animate-spin" size={20} />
          <span>{t('metaCloud.templates.loading')}</span>
        </div>
      ) : templates.isError ? (
        <div className="template-picker-state template-picker-error" role="alert">
          {metaErrorText(t, templates.error) ?? t('common.unknownError')}
        </div>
      ) : approved.length === 0 ? (
        <div className="template-picker-state">{t('metaCloud.templates.empty')}</div>
      ) : (
        <div className="template-picker-layout">
          <div className="template-picker-list" aria-label={t('metaCloud.templates.choose')} role="group">
            {approved.map(tpl => (
              <button
                key={keyOf(tpl)}
                type="button"
                className={`template-picker-item${keyOf(tpl) === selectedKey ? ' active' : ''}`}
                aria-pressed={keyOf(tpl) === selectedKey}
                aria-label={[tpl.name, tpl.language, tpl.category]
                  .concat(isSendable(tpl) ? [] : [t('metaCloud.templates.notSendable')])
                  .join(', ')}
                onClick={() => select(tpl)}
              >
                <span className="template-picker-name">{tpl.name}</span>
                <span className="template-picker-language">{tpl.language}</span>
                <span className="template-picker-category">{tpl.category}</span>
                {!isSendable(tpl) && (
                  <small className="template-picker-unsendable">{t('metaCloud.templates.notSendable')}</small>
                )}
              </button>
            ))}
          </div>
          {selected && (
            <div className="template-picker-detail">
              {placeholders.map(p => (
                <div key={p} className="template-picker-field">
                  <label htmlFor={`template-param-${p}`}>{`{{${p}}}`}</label>
                  <input
                    id={`template-param-${p}`}
                    type="text"
                    value={values[p] ?? ''}
                    onChange={e => setValues(current => ({ ...current, [p]: e.target.value }))}
                  />
                </div>
              ))}
              <div className="template-picker-preview">
                <span className="template-picker-preview-label">{t('metaCloud.templates.preview')}</span>
                <p>{render(bodyText(selected), values)}</p>
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

export default TemplatePicker;
