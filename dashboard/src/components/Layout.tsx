import { useState, useEffect, useRef } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  LayoutDashboard,
  Smartphone,
  MessageSquare,
  Webhook,
  Key,
  Users,
  Megaphone,
  UserRound,
  FileText,
  ClipboardList,
  LogOut,
  Send,
  Server,
  Puzzle,
  Sun,
  Moon,
  Monitor,
  Menu,
  X,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Languages,
  type LucideIcon,
} from 'lucide-react';
import { useTheme } from '../hooks/useTheme';
import { useRole, type UserRole } from '../hooks/useRole';
import { languageOptions, resolveSupportedLanguage, rtlLanguages, type SupportedLanguage } from '../i18n';
import { healthApi, infraApi } from '../services/api';
import { BRAND } from '../brand';
import { BrandLogo } from './BrandLogo';
import './Layout.css';

interface LayoutProps {
  onLogout: () => void;
  userRole: UserRole | null;
}

// unscopedOnly: every route behind the page refuses a key restricted to selected sessions, whatever its role.
interface NavItem {
  to: string;
  icon: LucideIcon;
  key: string;
  adminOnly: boolean;
  unscopedOnly?: boolean;
}

type NavSectionKey = 'operation' | 'messages' | 'administration';

const navSections: { key: NavSectionKey; items: NavItem[] }[] = [
  {
    key: 'operation',
    items: [
      { to: '/', icon: LayoutDashboard, key: 'dashboard' as const, adminOnly: false },
      { to: '/sessions', icon: Smartphone, key: 'sessions' as const, adminOnly: false },
      { to: '/chats', icon: MessageSquare, key: 'chats' as const, adminOnly: false },
      { to: '/campaigns', icon: Megaphone, key: 'campaigns' as const, adminOnly: false },
    ],
  },
  {
    key: 'messages',
    items: [
      { to: '/templates', icon: ClipboardList, key: 'templates' as const, adminOnly: false },
      { to: '/webhooks', icon: Webhook, key: 'webhooks' as const, adminOnly: false },
      { to: '/message-tester', icon: Send, key: 'messageTester' as const, adminOnly: false },
    ],
  },
  {
    key: 'administration',
    items: [
      { to: '/api-keys', icon: Key, key: 'apiKeys' as const, adminOnly: true, unscopedOnly: true },
      { to: '/users', icon: Users, key: 'users' as const, adminOnly: true, unscopedOnly: true },
      // Backend /infra/* is ADMIN-only; hide the nav item from non-admins (UX + defense-in-depth).
      { to: '/infrastructure', icon: Server, key: 'infrastructure' as const, adminOnly: true, unscopedOnly: true },
      { to: '/plugins', icon: Puzzle, key: 'plugins' as const, adminOnly: true, unscopedOnly: true },
      // Backend /audit is ADMIN-only too.
      { to: '/logs', icon: FileText, key: 'logs' as const, adminOnly: true },
    ],
  },
];

// Administration stays folded until it is needed; the everyday sections start open.
const initialOpenSections: Record<NavSectionKey, boolean> = {
  operation: true,
  messages: true,
  administration: false,
};

const isRouteInSection = (pathname: string, items: NavItem[]) =>
  items.some(item => (item.to === '/' ? pathname === '/' : pathname === item.to || pathname.startsWith(`${item.to}/`)));

const accountNavItem = { to: '/account', icon: UserRound, key: 'account' as const };

const themeIcons = { light: Sun, dark: Moon, system: Monitor };

export function Layout({ onLogout, userRole }: LayoutProps) {
  const { t, i18n } = useTranslation();
  const location = useLocation();
  const { theme, toggleTheme } = useTheme();
  const ThemeIcon = themeIcons[theme];
  const themeLabel = t(`theme.${theme}`);
  // toggleTheme cycles light, dark, system; the button names the state a click selects.
  const nextThemeLabel = t('theme.toggleTo', {
    value: t(`theme.${theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light'}`),
  });

  const { scoped } = useRole();
  const visibleNavSections = navSections.map(section => ({
    ...section,
    items: section.items.filter(item => (!item.adminOnly || userRole === 'admin') && (!item.unscopedOnly || !scoped)),
  }));

  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isMobileOpen, setIsMobileOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  const [openSections, setOpenSections] = useState(initialOpenSections);
  // Show the build-time version immediately, then replace it with the live running version from the
  // backend so a stale-built bundle can't display the wrong number. Falls back silently on error.
  const [version, setVersion] = useState(__APP_VERSION__);
  // A newer published release, shown to admins as a link to its notes. The route is ADMIN-only, refuses a
  // session-scoped key, and answers quietly when GitHub is unreachable or the check is turned off.
  const [update, setUpdate] = useState<{ latest: string; url: string } | null>(null);
  const [isLanguageMenuOpen, setIsLanguageMenuOpen] = useState(false);
  const languageMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleResize = () => {
      const mobile = window.innerWidth < 768;
      setIsMobile(mobile);
      if (!mobile) setIsMobileOpen(false);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    let active = true;
    healthApi
      .check()
      .then(info => {
        if (active && info?.version) setVersion(info.version);
      })
      .catch(() => {
        /* keep the build-time fallback */
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (userRole !== 'admin' || scoped) return;
    let active = true;
    infraApi
      .getUpdateCheck()
      .then(check => {
        if (active && check.updateAvailable && check.latest && check.releaseUrl) {
          setUpdate({ latest: check.latest, url: check.releaseUrl });
        }
      })
      .catch(() => {
        /* no notice */
      });
    return () => {
      active = false;
    };
  }, [userRole, scoped]);

  // A section opens when the current route is inside it, so the active link is never hidden.
  useEffect(() => {
    const active = navSections.find(section => isRouteInSection(location.pathname, section.items));
    if (active) setOpenSections(open => (open[active.key] ? open : { ...open, [active.key]: true }));
  }, [location.pathname]);

  const toggleSection = (key: NavSectionKey) => setOpenSections(open => ({ ...open, [key]: !open[key] }));

  const handleNavClick = () => {
    if (isMobile) setIsMobileOpen(false);
  };

  useEffect(() => {
    document.body.style.overflow = isMobileOpen ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [isMobileOpen]);

  useEffect(() => {
    if (!isLanguageMenuOpen) return;

    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!languageMenuRef.current?.contains(event.target as Node)) {
        setIsLanguageMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsLanguageMenuOpen(false);
    };

    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [isLanguageMenuOpen]);

  const toggleCollapse = () => setIsCollapsed(!isCollapsed);
  const toggleMobile = () => setIsMobileOpen(!isMobileOpen);

  const currentLang = resolveSupportedLanguage(i18n.resolvedLanguage || i18n.language);
  const languageLabel = languageOptions.find(option => option.value === currentLang)?.compactLabel ?? 'EN';
  const AccountIcon = accountNavItem.icon;
  const changeLanguage = (language: SupportedLanguage) => {
    setIsLanguageMenuOpen(false);
    void i18n.changeLanguage(language);
  };
  const isRtl = rtlLanguages.includes(currentLang);

  return (
    <div className="layout">
      {isMobile && (
        <header className="mobile-header">
          <button className="mobile-menu-btn" onClick={toggleMobile} aria-label={t('common.expand')}>
            {isMobileOpen ? <X size={24} /> : <Menu size={24} />}
          </button>
          <div className="mobile-brand">
            <BrandLogo className="sidebar-logo" />
            <span className="brand-name">{BRAND.name}</span>
          </div>
          <div style={{ width: 40 }} />
        </header>
      )}

      {isMobile && isMobileOpen && <div className="sidebar-overlay" onClick={() => setIsMobileOpen(false)} />}

      <aside
        className={`sidebar ${isCollapsed ? 'collapsed' : ''} ${isMobile ? 'mobile' : ''} ${isMobileOpen ? 'open' : ''}`}
      >
        <div className="sidebar-header">
          <BrandLogo className="sidebar-logo" />
          {!isCollapsed && (
            <div className="sidebar-brand">
              <span className="brand-name">{BRAND.name}</span>
              <span className="brand-version">v{version}</span>
              {update && (
                <a className="brand-update" href={update.url} target="_blank" rel="noopener noreferrer">
                  {t('common.updateAvailable', { version: update.latest })}
                </a>
              )}
            </div>
          )}
        </div>

        {!isMobile && (
          <button
            className="collapse-toggle"
            onClick={toggleCollapse}
            title={isCollapsed ? t('common.expand') : t('common.collapse')}
            aria-label={isCollapsed ? t('common.expand') : t('common.collapse')}
          >
            {isCollapsed ? (
              isRtl ? (
                <ChevronLeft size={16} />
              ) : (
                <ChevronRight size={16} />
              )
            ) : isRtl ? (
              <ChevronRight size={16} />
            ) : (
              <ChevronLeft size={16} />
            )}
          </button>
        )}

        <nav className="sidebar-nav" aria-label={t('common.appName')}>
          {visibleNavSections.map(section => {
            if (section.items.length === 0) return null;
            const isOpen = openSections[section.key];
            const title = t(`nav.sections.${section.key}`);
            const itemsId = `${section.key}-navigation`;

            return (
              <section className="sidebar-section" key={section.key}>
                {/* The heading keeps the group names in screen-reader heading navigation (WAI-ARIA accordion). */}
                <h2 className="sidebar-section-heading">
                  <button
                    className="sidebar-section-toggle"
                    onClick={() => toggleSection(section.key)}
                    aria-expanded={isOpen}
                    aria-controls={itemsId}
                    title={isCollapsed ? title : undefined}
                  >
                    {/* Icons-only mode keeps the name for assistive tech: a heading is not named by its button's title. */}
                    <span className={isCollapsed ? 'sidebar-section-label-hidden' : undefined}>{title}</span>
                    <ChevronDown className={isOpen ? '' : 'collapsed'} size={16} aria-hidden="true" />
                  </button>
                </h2>
                <div id={itemsId} className={`sidebar-section-items ${isOpen ? '' : 'hidden'}`} hidden={!isOpen}>
                  {section.items.map(({ to, icon: Icon, key }) => {
                    const label = t(`nav.${key}`);
                    return (
                      <NavLink
                        key={to}
                        to={to}
                        className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
                        end={to === '/'}
                        onClick={handleNavClick}
                        title={isCollapsed ? label : undefined}
                      >
                        <Icon size={20} />
                        {!isCollapsed && <span>{label}</span>}
                      </NavLink>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <NavLink
            to={accountNavItem.to}
            className={({ isActive }) => `nav-item account-nav-item ${isActive ? 'active' : ''}`}
            onClick={handleNavClick}
            title={isCollapsed ? t(`nav.${accountNavItem.key}`) : undefined}
          >
            <AccountIcon size={20} />
            {!isCollapsed && <span>{t(`nav.${accountNavItem.key}`)}</span>}
          </NavLink>
          <div className="language-menu" ref={languageMenuRef}>
            <button
              className="theme-toggle-btn"
              onClick={() => setIsLanguageMenuOpen(open => !open)}
              title={t('common.language')}
              aria-label={t('common.language')}
              aria-haspopup="menu"
              aria-expanded={isLanguageMenuOpen}
            >
              <Languages size={18} />
              {!isCollapsed && <span>{languageLabel}</span>}
            </button>
            {isLanguageMenuOpen && (
              <div className="language-menu-list" role="menu" aria-label={t('common.language')}>
                {languageOptions.map(option => (
                  <button
                    key={option.value}
                    className={`language-menu-item ${option.value === currentLang ? 'active' : ''}`}
                    onClick={() => changeLanguage(option.value)}
                    role="menuitemradio"
                    aria-checked={option.value === currentLang}
                  >
                    <span>{option.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="appearance-menu">
            <button
              className="theme-toggle-btn"
              onClick={toggleTheme}
              title={nextThemeLabel}
              aria-label={nextThemeLabel}
            >
              <span className="appearance-button-cue" aria-hidden="true">
                <ThemeIcon size={16} />
              </span>
              {!isCollapsed && <span>{themeLabel}</span>}
            </button>
          </div>
          <button className="logout-btn" onClick={onLogout} title={isCollapsed ? t('common.logout') : undefined}>
            <LogOut size={20} />
            {!isCollapsed && <span>{t('common.logout')}</span>}
          </button>
        </div>
      </aside>

      <main className={`main-content ${isCollapsed ? 'expanded' : ''} ${isMobile ? 'mobile' : ''}`}>
        <Outlet />
      </main>
    </div>
  );
}
