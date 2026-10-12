// The connection choice of the New session form (OpenMsg, docs/32 F3): a linked device paired by QR,
// or Meta's official Cloud API, which needs the number's Phone Number ID, its WABA ID and a token.
import { useTranslation } from 'react-i18next';
import type { SessionCreateMetaCloud } from '../../services/metaCloud';

export type SessionEngineChoice = 'qr' | 'meta-cloud';

interface MetaCloudFieldsProps {
  engine: SessionEngineChoice;
  onEngineChange: (engine: SessionEngineChoice) => void;
  value: SessionCreateMetaCloud;
  onChange: (value: SessionCreateMetaCloud) => void;
}

function MetaCloudFields({ engine, onEngineChange, value, onChange }: MetaCloudFieldsProps) {
  const { t } = useTranslation();
  const field = (key: keyof SessionCreateMetaCloud, type: 'text' | 'password') => (
    <>
      <label htmlFor={`create-meta-${key}`}>{t(`metaCloud.fields.${key}`)}</label>
      <input
        id={`create-meta-${key}`}
        type={type}
        autoComplete="off"
        value={value[key]}
        onChange={e => onChange({ ...value, [key]: e.target.value })}
      />
    </>
  );

  return (
    <div className="meta-cloud-fields">
      <fieldset className="meta-cloud-engine-choice">
        <legend>{t('metaCloud.engine.label')}</legend>
        <label htmlFor="create-engine-qr">
          <input
            id="create-engine-qr"
            type="radio"
            name="create-engine"
            checked={engine === 'qr'}
            onChange={() => onEngineChange('qr')}
          />
          {t('metaCloud.engine.qr')}
        </label>
        <label htmlFor="create-engine-meta-cloud">
          <input
            id="create-engine-meta-cloud"
            type="radio"
            name="create-engine"
            checked={engine === 'meta-cloud'}
            onChange={() => onEngineChange('meta-cloud')}
          />
          {t('metaCloud.engine.cloud')}
        </label>
      </fieldset>
      {engine === 'meta-cloud' && (
        <div className="meta-cloud-credentials">
          {field('phoneNumberId', 'text')}
          {field('wabaId', 'text')}
          {field('accessToken', 'password')}
          <p className="input-hint">{t('metaCloud.fields.hint')}</p>
        </div>
      )}
    </div>
  );
}

export default MetaCloudFields;
