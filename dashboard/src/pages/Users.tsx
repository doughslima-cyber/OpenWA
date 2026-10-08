import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { AlertCircle, AlertTriangle, Loader2, Pencil, Plus, Trash2, UserRound } from 'lucide-react';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useCreateUserMutation, useDeleteUserMutation, useUpdateUserMutation, useUsersQuery } from '../hooks/useUsers';
import { getSignedInUser, type DashboardUser } from '../services/users';
import type { UserRole } from '../types/role';
import { PageHeader } from '../components/PageHeader';
import { Modal } from '../components/Modal';
import { useToast } from '../hooks/useToast';
import './Users.css';

const ROLES: UserRole[] = ['admin', 'operator', 'viewer'];
const PASSWORD_MIN = 10;

interface FormState {
  name: string;
  email: string;
  password: string;
  role: UserRole;
  isActive: boolean;
}

const emptyForm: FormState = { name: '', email: '', password: '', role: 'operator', isActive: true };

export function Users() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  useDocumentTitle(t('users.title'));
  const me = getSignedInUser();

  const { data: users = [], isLoading, error } = useUsersQuery();
  const createMutation = useCreateUserMutation();
  const updateMutation = useUpdateUserMutation();
  const deleteMutation = useDeleteUserMutation();

  // null: closed; 'new': creating; a user: editing that user.
  const [editing, setEditing] = useState<DashboardUser | 'new' | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [formError, setFormError] = useState('');
  const [deleting, setDeleting] = useState<DashboardUser | null>(null);

  const isNew = editing === 'new';
  const saving = createMutation.isPending || updateMutation.isPending;

  const errorText = (err: unknown, fallbackKey: string): string => {
    const code = (err as { code?: string }).code;
    if (code && i18n.exists(`users.errors.${code}`)) return t(`users.errors.${code}`);
    return err instanceof Error && err.message ? err.message : t(fallbackKey);
  };

  const openCreate = () => {
    setForm(emptyForm);
    setFormError('');
    setEditing('new');
  };

  const openEdit = (user: DashboardUser) => {
    setForm({ name: user.name, email: user.email, password: '', role: user.role, isActive: user.isActive });
    setFormError('');
    setEditing(user);
  };

  const closeForm = () => {
    if (!saving) setEditing(null);
  };

  const handleSave = async () => {
    if (!form.name.trim() || !form.email.trim() || (isNew && !form.password)) {
      setFormError(t('users.form.requiredFields'));
      return;
    }
    if (form.password && form.password.length < PASSWORD_MIN) {
      setFormError(t('users.form.passwordTooShort'));
      return;
    }
    setFormError('');
    try {
      if (isNew) {
        await createMutation.mutateAsync({
          name: form.name.trim(),
          email: form.email.trim(),
          password: form.password,
          role: form.role,
        });
        toast.success(t('users.toast.created'));
      } else if (editing) {
        await updateMutation.mutateAsync({
          id: editing.id,
          data: {
            name: form.name.trim(),
            role: form.role,
            isActive: form.isActive,
            ...(form.password ? { password: form.password } : {}),
          },
        });
        toast.success(t('users.toast.updated'));
      }
      setEditing(null);
    } catch (err) {
      setFormError(errorText(err, 'users.toast.saveError'));
    }
  };

  const handleDelete = async () => {
    if (!deleting) return;
    try {
      await deleteMutation.mutateAsync(deleting.id);
      toast.success(t('users.toast.deleted'));
    } catch (err) {
      toast.error(t('users.toast.deleteError'), errorText(err, 'common.unknownError'));
    }
    setDeleting(null);
  };

  const formatDate = (iso?: string) =>
    iso ? new Date(iso).toLocaleString(i18n.resolvedLanguage || i18n.language) : t('common.never');

  if (isLoading) {
    return (
      <div className="users-page users-page--loading">
        <Loader2 className="animate-spin" size={32} />
      </div>
    );
  }

  const editingSelf = !isNew && editing !== null && editing.id === me?.id;

  return (
    <div className="users-page">
      <PageHeader
        title={t('users.title')}
        subtitle={t('users.subtitle')}
        actions={
          <button className="btn-primary" onClick={openCreate}>
            <Plus size={18} />
            {t('users.addBtn')}
          </button>
        }
      />

      <div className="users-table-container">
        {error ? (
          <div className="users-empty" role="alert">
            <AlertCircle size={48} strokeWidth={1} />
            <h3>{t('users.loadError')}</h3>
            <p>{error.message}</p>
          </div>
        ) : users.length === 0 ? (
          <div className="users-empty">
            <UserRound size={48} strokeWidth={1} />
            <h3>{t('users.empty')}</h3>
          </div>
        ) : (
          <table className="users-table">
            <thead>
              <tr>
                <th>{t('users.columns.name')}</th>
                <th>{t('users.columns.email')}</th>
                <th>{t('users.columns.role')}</th>
                <th>{t('users.columns.status')}</th>
                <th>{t('users.columns.lastLogin')}</th>
                <th className="users-actions-col">{t('users.columns.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {users.map(user => (
                <tr key={user.id}>
                  <td>
                    <span className="users-name">{user.name}</span>
                    {user.id === me?.id && <span className="users-you">{t('users.you')}</span>}
                    {user.mustChangePassword && (
                      <span className="users-temporary" title={t('users.temporaryHint')}>
                        {t('users.temporaryBadge')}
                      </span>
                    )}
                  </td>
                  <td>{user.email}</td>
                  <td>
                    <span className={`users-role users-role--${user.role}`}>{t(`apiKeys.roles.${user.role}`)}</span>
                  </td>
                  <td>
                    <span className={`users-status ${user.isActive ? 'is-active' : 'is-inactive'}`}>
                      {user.isActive ? t('common.active') : t('common.inactive')}
                    </span>
                  </td>
                  <td className="users-muted">{formatDate(user.lastLoginAt)}</td>
                  <td className="users-actions-col">
                    <button
                      className="btn-icon"
                      onClick={() => openEdit(user)}
                      aria-label={`${t('common.edit')} ${user.name}`}
                      title={t('common.edit')}
                    >
                      <Pencil size={16} />
                    </button>
                    <button
                      className="btn-icon"
                      onClick={() => setDeleting(user)}
                      disabled={user.id === me?.id}
                      aria-label={`${t('common.delete')} ${user.name}`}
                      title={t('common.delete')}
                    >
                      <Trash2 size={16} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {editing !== null && (
        <Modal
          open
          onClose={closeForm}
          hideCloseButton={saving}
          title={isNew ? t('users.form.createTitle') : t('users.form.editTitle')}
          closeLabel={t('common.close')}
          footer={
            <>
              <button className="btn-secondary" onClick={closeForm} disabled={saving}>
                {t('common.cancel')}
              </button>
              <button className="btn-primary" onClick={() => void handleSave()} disabled={saving}>
                {saving ? (
                  <Loader2 className="animate-spin" size={16} />
                ) : isNew ? (
                  t('common.create')
                ) : (
                  t('common.save')
                )}
              </button>
            </>
          }
        >
          <label htmlFor="user-name">{t('users.form.name')}</label>
          <input
            id="user-name"
            type="text"
            maxLength={100}
            placeholder={t('users.form.namePlaceholder')}
            value={form.name}
            onChange={e => setForm({ ...form, name: e.target.value })}
          />

          <label htmlFor="user-email">{t('users.form.email')}</label>
          <input
            id="user-email"
            type="email"
            autoComplete="off"
            placeholder="ana@empresa.com"
            value={form.email}
            disabled={!isNew}
            onChange={e => setForm({ ...form, email: e.target.value })}
          />

          <label htmlFor="user-password">{isNew ? t('users.form.password') : t('users.form.newPassword')}</label>
          <input
            id="user-password"
            type="password"
            autoComplete="new-password"
            placeholder={isNew ? t('users.form.passwordHint') : t('users.form.newPasswordHint')}
            value={form.password}
            onChange={e => setForm({ ...form, password: e.target.value })}
          />
          {!editingSelf && <p className="users-role-hint">{t('users.form.temporaryHint')}</p>}

          <label htmlFor="user-role">{t('users.form.role')}</label>
          <select
            id="user-role"
            value={form.role}
            disabled={editingSelf}
            onChange={e => setForm({ ...form, role: e.target.value as UserRole })}
          >
            {ROLES.map(role => (
              <option key={role} value={role}>
                {t(`apiKeys.roles.${role}`)}
              </option>
            ))}
          </select>
          <p className="users-role-hint">{t(`apiKeys.roleDescriptions.${form.role}`)}</p>

          {!isNew && (
            <div className="users-active-row">
              <input
                id="user-active"
                type="checkbox"
                checked={form.isActive}
                disabled={editingSelf}
                onChange={e => setForm({ ...form, isActive: e.target.checked })}
              />
              <label htmlFor="user-active">{t('users.form.active')}</label>
            </div>
          )}

          {formError && (
            <p className="users-form-error" role="alert">
              {formError}
            </p>
          )}
        </Modal>
      )}

      {deleting && (
        <Modal
          open
          onClose={() => setDeleting(null)}
          title={t('users.confirmDelete.title')}
          className="confirm-modal"
          closeLabel={t('common.close')}
          footer={
            <>
              <button className="btn-secondary" onClick={() => setDeleting(null)}>
                {t('common.cancel')}
              </button>
              <button className="btn-danger" onClick={() => void handleDelete()} disabled={deleteMutation.isPending}>
                {t('users.confirmDelete.confirm')}
              </button>
            </>
          }
        >
          <div className="confirm-icon-wrapper">
            <AlertTriangle size={48} className="confirm-warning-icon" />
          </div>
          <p className="confirm-message">
            <Trans
              i18nKey="users.confirmDelete.message"
              values={{ name: deleting.name }}
              components={{ strong: <strong /> }}
            />
          </p>
        </Modal>
      )}
    </div>
  );
}
