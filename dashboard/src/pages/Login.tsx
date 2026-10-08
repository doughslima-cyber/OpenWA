import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff, Languages } from 'lucide-react';
import { GithubIcon } from '../components/GithubIcon';
import { CustomSelect } from '../components/CustomSelect';
import { BrandLogo } from '../components/BrandLogo';
import { languageOptions, resolveSupportedLanguage, type SupportedLanguage } from '../i18n';
import { signIn, SignInError, storeSignedInUser } from '../services/users';
import './Login.css';

const PASSWORD_MIN = 10;

interface LoginProps {
  onLogin: (apiKey: string, role?: string, engineType?: string, scoped?: boolean) => void;
}

export function Login({ onLogin }: LoginProps) {
  const { t, i18n } = useTranslation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  // Set once the gateway answers that the password is temporary: the form then asks for the
  // user's own password and repeats the sign-in with it.
  const [mustChoose, setMustChoose] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const currentLang = resolveSupportedLanguage(i18n.resolvedLanguage || i18n.language);

  const changeLanguage = (language: SupportedLanguage) => {
    void i18n.changeLanguage(language);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) {
      setError(t('login.credentialsRequired'));
      return;
    }
    if (mustChoose) {
      if (newPassword.length < PASSWORD_MIN) {
        setError(t('users.form.passwordTooShort'));
        return;
      }
      if (newPassword !== confirmPassword) {
        setError(t('account.mismatch'));
        return;
      }
    }
    setIsLoading(true);
    setError('');

    try {
      const result = await signIn(email.trim(), password, mustChoose ? newPassword : undefined);
      if (result.passwordChangeRequired) {
        setMustChoose(true);
        return;
      }
      storeSignedInUser(result.user);
      onLogin(result.apiKey, result.role, result.engineType, result.scoped);
    } catch (err) {
      const code = err instanceof SignInError ? err.code : 'NETWORK';
      setError(
        t(
          code === 'INVALID_CREDENTIALS'
            ? 'login.invalidCredentials'
            : code === 'TOO_MANY_ATTEMPTS'
              ? 'login.tooManyAttempts'
              : code === 'SAME_PASSWORD'
                ? 'account.samePassword'
                : 'login.connectionError',
        ),
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="login-container">
      <div className="login-card">
        <div className="login-logo">
          <BrandLogo className="logo-icon" />
          <span className="version-info">
            {t('login.version', {
              version: __APP_VERSION__,
              // ISO date (YYYYMMDD) so the format is stable across locales/regions instead of the
              // locale-dependent toLocaleDateString() which renders differently per browser region.
              date: new Date(__BUILD_TIME__).toISOString().slice(0, 10).replace(/-/g, ''),
            })}
          </span>
        </div>

        <div className="login-language">
          <Languages size={18} />
          <CustomSelect
            value={currentLang}
            onChange={value => changeLanguage(value as SupportedLanguage)}
            options={languageOptions.map(opt => ({ value: opt.value, label: opt.label }))}
            ariaLabel={t('common.language')}
          />
        </div>

        <form onSubmit={handleSubmit} className="login-form">
          {mustChoose && (
            <p className="login-notice" role="status">
              {t('login.choosePasswordHint')}
            </p>
          )}
          <div className="input-group" hidden={mustChoose}>
            <label htmlFor="email">{t('login.email')}</label>
            <div className="input-wrapper">
              <input
                id="email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder={t('login.emailPlaceholder')}
                className={error ? 'error' : ''}
              />
            </div>
          </div>

          <div className="input-group" hidden={mustChoose}>
            <label htmlFor="password">{t('login.password')}</label>
            <div className="input-wrapper">
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder={t('login.passwordPlaceholder')}
                className={error ? 'error' : ''}
              />
              <button
                type="button"
                className="toggle-visibility"
                onClick={() => setShowPassword(!showPassword)}
                aria-label={showPassword ? t('common.hidePassword') : t('common.showPassword')}
              >
                {showPassword ? <EyeOff size={20} /> : <Eye size={20} />}
              </button>
            </div>
            {error && !mustChoose && <span className="error-message">{error}</span>}
          </div>

          {mustChoose && (
            <>
              <div className="input-group">
                <label htmlFor="new-password">{t('account.newPassword')}</label>
                <div className="input-wrapper">
                  <input
                    id="new-password"
                    type="password"
                    autoComplete="new-password"
                    value={newPassword}
                    onChange={e => setNewPassword(e.target.value)}
                    placeholder={t('users.form.passwordHint')}
                    className={error ? 'error' : ''}
                  />
                </div>
              </div>
              <div className="input-group">
                <label htmlFor="confirm-password">{t('account.confirmPassword')}</label>
                <div className="input-wrapper">
                  <input
                    id="confirm-password"
                    type="password"
                    autoComplete="new-password"
                    value={confirmPassword}
                    onChange={e => setConfirmPassword(e.target.value)}
                    placeholder={t('account.confirmPlaceholder')}
                    className={error ? 'error' : ''}
                  />
                </div>
                {error && <span className="error-message">{error}</span>}
              </div>
            </>
          )}

          <button type="submit" className="connect-btn" disabled={isLoading}>
            {isLoading ? t('login.signingIn') : mustChoose ? t('login.choosePasswordSubmit') : t('login.signIn')}
          </button>
        </form>

        <p className="login-help">{t('login.forgotHint')}</p>
      </div>

      <footer className="login-footer">
        <span>{t('login.footer')}</span>
        <a
          href="https://github.com/rmyndharis/OpenWA"
          target="_blank"
          rel="noopener noreferrer"
          className="github-link"
          aria-label="GitHub"
        >
          <GithubIcon size={18} />
        </a>
      </footer>
    </div>
  );
}
