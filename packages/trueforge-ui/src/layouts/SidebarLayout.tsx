'use client';

import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
  type Ref,
} from 'react';

import { useTrackAnalytics } from '../analytics/AnalyticsProvider.js';
import { AnalyticsEvents } from '../analytics/events.js';
import { useAui } from '../assistant-ui.js';
import { DesktopOnlyNotice } from '../atoms/DesktopOnlyNotice.js';
import { auiButtonClass, sidebarRailButtonClassName } from '../atoms/lib/buttonClasses.js';
import { cn } from '../atoms/lib/cn.js';
import { useIsMobile } from '../atoms/lib/useIsMobile.js';
import { NamedAgentHeaderLabel } from '../atoms/NamedAgentHeaderLabel.js';
import { PageHeader } from '../atoms/PageHeader.js';
import { Spinner } from '../atoms/primitives/Spinner.js';
import { ShellActions } from '../atoms/ShellActions.js';
import { AgentConfigDrawerContainer } from '../containers/AgentConfigDrawerContainer.js';
import { Thread } from '../containers/Thread.js';
import { ThreadListContainer } from '../containers/ThreadListContainer.js';
import { FilePreviewProvider, useFilePreview } from '../filePreview/FilePreviewContext.js';
import { useChatHeaderContentVisible } from '../hooks/useChatChromeActionsVisible.js';
import { Icon } from '../icons/Icon.js';
import { isHubChromeEnabled } from '../server/serverChrome.js';
import { useOptionalWorkflowServer } from '../server/ServerContext.js';
import {
  shellIsCreateAgent,
  useOptionalShellMode,
  type ShellMode,
  type WorkflowsSection,
} from '../server/ShellModeContext.js';
import { resolveBrandChrome, useBrandName } from '../theme/brand.js';
import { useSlot } from '../theme/SlotsProvider.js';
import { useBrand } from '../theme/ThemeProvider.js';

const TruefoundrySettingsBuilder = lazy(() => import('../containers/SettingsBuilder/index.js'));
const HubPage = lazy(() => import('../atoms/hub/HubPage.js').then(m => ({ default: m.HubPage })));
const SchedulesPage = lazy(() =>
  import('../atoms/schedules/SchedulesPage.js').then(m => ({ default: m.SchedulesPage })),
);
const EnvironmentsPage = lazy(() =>
  import('../atoms/environments/EnvironmentsPage.js').then(m => ({ default: m.EnvironmentsPage })),
);

const brandLogoClassName = 'h-9 w-9 max-w-40 shrink-0 object-contain';
const brandLogoExpandedClassName = 'h-7 max-w-48 shrink-0 object-contain';
const railWidthClassName = 'w-20';
const mobileDrawerWidthClassName = 'w-80';

const paneFallback = (
  <div className="flex h-full items-center justify-center" role="status" aria-live="polite" aria-busy="true">
    <Spinner size={28} className="text-text-primary" />
    <span className="sr-only">Loading</span>
  </div>
);

const railActionButtonClassName = cn(sidebarRailButtonClassName, 'text-sidebar-text');

const railSelectedClassName =
  'bg-primary-button-bg font-medium text-primary-button-text hover:bg-primary-button-hover hover:text-primary-button-text';

function isRecentHistoryVisible({ overlayOpen, mode }: { overlayOpen: boolean; mode?: ShellMode }): boolean {
  return !overlayOpen && mode?.status === 'active' && !mode.isCreateAgent;
}

function RecentChatsAside() {
  const preview = useFilePreview();
  if (preview.presentation === 'full') return null;
  return (
    <aside
      aria-label="Recent chats"
      className="hidden min-h-0 w-64 shrink-0 border-r border-border bg-sidebar-bg md:flex"
    >
      <ThreadListContainer variant="recent-history" />
    </aside>
  );
}

function RailButton({
  icon,
  label,
  selected,
  onClick,
}: {
  icon: string;
  label: string;
  selected: boolean;
  onClick: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-current={selected ? 'page' : undefined}
      className={auiButtonClass({
        variant: 'ghost',
        className: cn(railActionButtonClassName, selected && railSelectedClassName),
      })}
      onClick={onClick}
    >
      <Icon name={icon} size={14} />
      <span className="text-center whitespace-nowrap">{label}</span>
    </button>
  );
}

const WORKFLOW_NAV: Array<{ section: WorkflowsSection; icon: string; label: string }> = [
  { section: 'list', icon: 'workflow', label: 'Workflows' },
  { section: 'new', icon: 'plus', label: 'New Workflow' },
  { section: 'runs', icon: 'clock-rotate-left', label: 'Runs' },
];

function SidebarNav(): ReactNode {
  const shell = useOptionalShellMode();
  const workflows = useOptionalWorkflowServer();
  const track = useTrackAnalytics();
  const HubButton = useSlot('HubButton');
  const SchedulesButton = useSlot('SchedulesButton');
  // Without the workflows port there is no Home, so the Agents menu is the whole rail.
  const hubEnabled = isHubChromeEnabled({ workflows });
  const space = hubEnabled ? (shell?.navSpace ?? 'agents') : 'agents';

  return (
    <nav className="flex min-h-0 flex-1 flex-col items-center gap-1 p-1" aria-label="Sidebar">
      <HubButton compact />
      {hubEnabled ? <div aria-hidden className="my-1 h-px w-12 bg-border" /> : null}
      {space === 'home' ? (
        <>
          <RailButton
            icon="agent-2"
            label="Agents"
            selected={false}
            onClick={() => {
              track(AnalyticsEvents.Hub.SPACE_OPENED, { space: 'agents' });
              shell?.setHubOpen(false);
            }}
          />
          <RailButton
            icon="workflow"
            label="Workflows"
            selected={false}
            onClick={() => {
              track(AnalyticsEvents.Hub.SPACE_OPENED, { space: 'workflows' });
              shell?.setWorkflowsSection('list');
            }}
          />
        </>
      ) : space === 'workflows' ? (
        <>
          {WORKFLOW_NAV.map(item => (
            <RailButton
              key={item.section}
              icon={item.icon}
              label={item.label}
              selected={shell?.workflowsSection === item.section}
              onClick={() => {
                track(AnalyticsEvents.Workflow.NAV_OPENED, { section: item.section });
                shell?.setWorkflowsSection(item.section);
              }}
            />
          ))}
          <SchedulesButton compact />
        </>
      ) : (
        <AgentsNav />
      )}
    </nav>
  );
}

function AgentsNav(): ReactNode {
  const aui = useAui();
  const shell = useOptionalShellMode();
  const AgentsLibraryButton = useSlot('AgentsLibraryButton');
  const SessionsBrowserButton = useSlot('SessionsBrowserButton');
  const SchedulesButton = useSlot('SchedulesButton');
  const EnvironmentsButton = useSlot('EnvironmentsButton');
  const showNewActions = shell?.isNewChatEnabled !== false;
  const overlayOpen =
    shell?.settingsOpen === true ||
    shell?.libraryOpen === true ||
    shell?.sessionsOpen === true ||
    shell?.schedulesOpen === true ||
    shell?.hubOpen === true ||
    shell?.workflowsSection != null ||
    shell?.environmentsOpen === true;
  const mode = shell?.mode;
  const newChatSelected =
    !overlayOpen &&
    mode?.status === 'active' &&
    !mode.isCreateAgent &&
    shell?.historyAgentFilter?.intent !== 'try-agent';
  const newAgentSelected = !overlayOpen && mode != null && shellIsCreateAgent(mode);

  const handleNewChat = () => {
    shell?.setLibraryOpen(false);
    shell?.setSessionsOpen(false);
    if (shell?.isComposerEnabled) {
      shell.openDraft();
      return;
    }
    shell?.setSettingsOpen(false);
    shell?.setSchedulesOpen(false);
    shell?.setEnvironmentsOpen(false);
    shell?.setHubOpen(false);
    void Promise.resolve(aui.threads().switchToNewThread()).catch(() => undefined);
  };

  const handleNewAgent = () => {
    shell?.setLibraryOpen(false);
    shell?.setSessionsOpen(false);
    if (shell?.isComposerEnabled) {
      shell.openAgentBuilder();
    }
  };

  return (
    <>
      {showNewActions ? (
        <button
          type="button"
          aria-label="Start new chat"
          title="New chat"
          aria-current={newChatSelected ? 'page' : undefined}
          className={auiButtonClass({
            variant: 'ghost',
            className: cn(railActionButtonClassName, newChatSelected && railSelectedClassName),
          })}
          onClick={handleNewChat}
        >
          <Icon name="square-pen" size={14} />
          <span className="text-center">New Chat</span>
        </button>
      ) : null}
      {showNewActions && shell?.isComposerEnabled ? (
        <button
          type="button"
          aria-label="Start new agent"
          title="New Agent"
          aria-current={newAgentSelected ? 'page' : undefined}
          className={auiButtonClass({
            variant: 'ghost',
            className: cn(railActionButtonClassName, newAgentSelected && railSelectedClassName),
          })}
          onClick={handleNewAgent}
        >
          <Icon name="agent-2" size={14} />
          <span className="text-center whitespace-nowrap">Build Agent</span>
        </button>
      ) : null}
      <AgentsLibraryButton compact />
      <SessionsBrowserButton compact />
      <SchedulesButton compact />
      <EnvironmentsButton compact />
    </>
  );
}

/** Desktop icon+label rail (brand, nav, footer actions). */
function SidebarRail({
  className,
  railRef,
  ...dialogProps
}: {
  className?: string;
  railRef?: Ref<HTMLElement>;
} & Omit<ComponentPropsWithoutRef<'aside'>, 'children' | 'className'>): ReactNode {
  const brand = useBrand();
  const chrome = resolveBrandChrome(brand);
  const BrandLogo = useSlot('BrandLogo');
  const UserAvatar = useSlot('UserAvatar');

  return (
    <aside
      ref={railRef}
      className={cn(
        railWidthClassName,
        'flex min-h-0 shrink-0 flex-col border-r border-border bg-sidebar-bg',
        className,
      )}
      {...dialogProps}
    >
      <div className="flex h-14 w-full shrink-0 items-center justify-center text-text-primary">
        <BrandLogo variant={chrome.collapsedVariant} className={brandLogoClassName} />
      </div>
      <SidebarNav />
      <footer className="flex shrink-0 flex-col items-center border-border p-2">
        <ShellActions labeled className="flex-col" />
        <UserAvatar labeled className="mt-2 py-1.5" />
      </footer>
    </aside>
  );
}

/** Claude-style mobile side drawer: branding, New Chat + Agents, history, footer actions. */
function MobileNavDrawer({ drawerRef, onClose }: { drawerRef: Ref<HTMLElement>; onClose: () => void }): ReactNode {
  const brand = useBrand();
  const chrome = resolveBrandChrome(brand);
  const brandName = useBrandName();
  const BrandLogo = useSlot('BrandLogo');
  const UserAvatar = useSlot('UserAvatar');

  return (
    <aside
      ref={drawerRef}
      role="dialog"
      aria-label="Navigation"
      tabIndex={-1}
      className={cn(
        mobileDrawerWidthClassName,
        'absolute inset-y-0 left-0 z-10 flex min-h-0 flex-col border-r border-border bg-sidebar-bg shadow-lg outline-none md:hidden',
      )}
    >
      <div className="flex h-14 w-full shrink-0 items-center gap-2 border-b border-border px-3 text-text-primary">
        <BrandLogo variant={chrome.expandedVariant} className={brandLogoExpandedClassName} />
        {chrome.showTitle && brandName != null ? (
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">{brandName}</span>
        ) : (
          <span className="min-w-0 flex-1" />
        )}
        <button
          type="button"
          aria-label="Close navigation"
          className={auiButtonClass({ variant: 'ghost', size: 'icon' })}
          onClick={onClose}
        >
          <Icon name="xmark" />
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <ThreadListContainer variant="mobile-drawer" onThreadOpen={onClose} />
      </div>
      <footer className="flex shrink-0 items-center justify-around gap-1 border-t border-border p-2 text-sidebar-text">
        {/* `contents` lets Docs / Theme / Settings share this row with the avatar. */}
        <ShellActions labeled onAction={onClose} className="contents" />
        <UserAvatar labeled />
      </footer>
    </aside>
  );
}

export function SidebarLayout({ className }: { className?: string }) {
  const shell = useOptionalShellMode();
  const isMobile = useIsMobile();
  const AgentDetailsPage = useSlot('AgentDetailsPage');
  const AgentsLibrary = useSlot('AgentsLibrary');
  const SessionsPage = useSlot('SessionsPage');
  const ShareChatButton = useSlot('ShareChatButton');
  const ResetAgentBuilderButton = useSlot('ResetAgentBuilderButton');
  const ClearChatButton = useSlot('ClearChatButton');
  const SaveAgentButton = useSlot('SaveAgentButton');
  const SelectAgentEmptyState = useSlot('SelectAgentEmptyState');
  const WorkflowsPage = useSlot('WorkflowsPage');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);
  const isIdle = shell?.mode.status === 'idle';
  const settingsOpen = shell?.settingsOpen === true;
  const libraryOpen = shell?.libraryOpen === true;
  const libraryListOpen = libraryOpen && shell?.libraryAgentId == null;
  const sessionsOpen = shell?.sessionsOpen === true;
  const schedulesOpen = shell?.schedulesOpen === true;
  const environmentsOpen = shell?.environmentsOpen === true;
  const hubOpen = shell?.hubOpen === true;
  const workflowsSection = shell?.workflowsSection ?? null;
  const workflowsOpen = workflowsSection != null;
  const overlayOpen =
    settingsOpen || libraryOpen || sessionsOpen || schedulesOpen || hubOpen || workflowsOpen || environmentsOpen;
  const isCreateAgent = shell != null && shellIsCreateAgent(shell.mode);
  // Build Agent, Sessions, Schedules, Home, Workflows, and Environments are desktop-only; keep the URL and show a notice.
  const showDesktopOnlyNotice =
    isMobile &&
    (sessionsOpen ||
      schedulesOpen ||
      hubOpen ||
      workflowsOpen ||
      environmentsOpen ||
      (isCreateAgent && !settingsOpen && !libraryOpen));
  const showAgentConfig = isCreateAgent && !overlayOpen && !isMobile;
  const showRecentHistory = isRecentHistoryVisible({ overlayOpen, mode: shell?.mode });
  const hasChatHeaderContent = useChatHeaderContentVisible();
  // Agents / Settings own a page header — put the hamburger there instead of a second top bar.
  const inlineMobileNav = isMobile && (settingsOpen || libraryListOpen);
  const closeMobileNav = () => setMobileNavOpen(false);
  const mobileNavButton = (
    <button
      ref={menuBtnRef}
      type="button"
      aria-label="Navigation"
      aria-expanded={mobileNavOpen}
      className={cn(auiButtonClass({ variant: 'ghost', size: 'icon' }), 'md:hidden')}
      onClick={() => setMobileNavOpen(true)}
    >
      <Icon name="panel-left" />
    </button>
  );

  useEffect(() => {
    if (!mobileNavOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Capture + stop so Settings / Agents / Agent Details Escape handlers do not steal this.
      event.stopImmediatePropagation();
      setMobileNavOpen(false);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [mobileNavOpen]);

  useEffect(() => {
    const main = mainRef.current;
    if (mobileNavOpen) {
      wasOpen.current = true;
      if (main) main.inert = true;
      dialogRef.current?.focus();
      return;
    }
    if (wasOpen.current) {
      if (main) main.inert = false;
      menuBtnRef.current?.focus();
      wasOpen.current = false;
    }
  }, [mobileNavOpen]);

  return (
    <div className={cn('relative flex h-full min-h-0 w-full min-w-0', className)}>
      <SidebarRail className="hidden md:flex" />

      {showAgentConfig ? (
        <aside
          role="dialog"
          aria-label="Agent Config"
          className="absolute inset-y-0 left-0 z-20 w-full max-w-sm border-r border-border shadow-xl md:static md:z-auto md:max-w-140 md:flex-1 md:shadow-none 2xl:max-w-150"
        >
          <AgentConfigDrawerContainer />
        </aside>
      ) : null}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-primary-bg">
        {/* Desktop keeps shell chrome in the rail footer (always mounted, including
            when visually hidden on small screens so host action-slot state persists).
            Mobile reaches theme/settings via the nav drawer. */}
        {inlineMobileNav ? null : (
          <PageHeader
            className={cn(
              'bg-topbar-bg',
              // Desktop: hide when settings/idle or the thread header has nothing to show
              // (empty untitled draft). Mobile still needs the menu button.
              // Builder mode keeps New Agent and its actions beside the persistent config.
              (overlayOpen || isIdle || !hasChatHeaderContent || showDesktopOnlyNotice) && 'md:hidden',
            )}
            start={mobileNavButton}
            title={!overlayOpen && !showDesktopOnlyNotice ? <NamedAgentHeaderLabel /> : null}
            end={
              !overlayOpen && !showDesktopOnlyNotice ? (
                <>
                  <ResetAgentBuilderButton />
                  <ShareChatButton />
                  <ClearChatButton />
                  <SaveAgentButton />
                </>
              ) : null
            }
          />
        )}

        <FilePreviewProvider>
          <div className="flex min-h-0 min-w-0 flex-1">
            {showRecentHistory ? <RecentChatsAside /> : null}

            <div ref={mainRef} className="min-h-0 min-w-0 flex-1">
              {settingsOpen ? (
                <Suspense
                  fallback={
                    <div
                      className="flex h-full items-center justify-center"
                      role="status"
                      aria-live="polite"
                      aria-busy="true"
                    >
                      <Spinner size={28} className="text-text-primary" />
                      <span className="sr-only">Loading</span>
                    </div>
                  }
                >
                  <TruefoundrySettingsBuilder {...(inlineMobileNav ? { headerStart: mobileNavButton } : {})} />
                </Suspense>
              ) : showDesktopOnlyNotice ? (
                <DesktopOnlyNotice />
              ) : sessionsOpen ? (
                <SessionsPage />
              ) : libraryOpen && shell?.libraryAgentId != null ? (
                <AgentDetailsPage key={shell.libraryAgentId} agentId={shell.libraryAgentId} />
              ) : libraryOpen ? (
                <AgentsLibrary
                  onSelectAgent={closeMobileNav}
                  {...(inlineMobileNav ? { headerStart: mobileNavButton } : {})}
                />
              ) : hubOpen ? (
                <Suspense
                  fallback={
                    <div
                      className="flex h-full items-center justify-center"
                      role="status"
                      aria-live="polite"
                      aria-busy="true"
                    >
                      <Spinner size={28} className="text-text-primary" />
                      <span className="sr-only">Loading</span>
                    </div>
                  }
                >
                  <HubPage />
                </Suspense>
              ) : workflowsSection != null ? (
                <Suspense fallback={paneFallback}>
                  {/* Keyed so switching sections from the rail closes any open editor. */}
                  <WorkflowsPage key={workflowsSection} section={workflowsSection} />
                </Suspense>
              ) : schedulesOpen ? (
                <Suspense
                  fallback={
                    <div
                      className="flex h-full items-center justify-center"
                      role="status"
                      aria-live="polite"
                      aria-busy="true"
                    >
                      <Spinner size={28} className="text-text-primary" />
                      <span className="sr-only">Loading</span>
                    </div>
                  }
                >
                  <SchedulesPage />
                </Suspense>
              ) : environmentsOpen ? (
                <Suspense
                  fallback={
                    <div
                      className="flex h-full items-center justify-center"
                      role="status"
                      aria-live="polite"
                      aria-busy="true"
                    >
                      <Spinner size={28} className="text-text-primary" />
                      <span className="sr-only">Loading</span>
                    </div>
                  }
                >
                  <EnvironmentsPage />
                </Suspense>
              ) : isIdle ? (
                <SelectAgentEmptyState />
              ) : (
                <Thread />
              )}
            </div>
          </div>
        </FilePreviewProvider>
      </div>

      {mobileNavOpen ? (
        <>
          <button
            type="button"
            aria-label="Close navigation backdrop"
            className="absolute inset-0 z-[9] cursor-pointer bg-[var(--overlay)] md:hidden"
            onClick={closeMobileNav}
          />
          <MobileNavDrawer drawerRef={dialogRef} onClose={closeMobileNav} />
        </>
      ) : null}
    </div>
  );
}
