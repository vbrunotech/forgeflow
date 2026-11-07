'use client';

import { useTrackAnalytics } from '../analytics/AnalyticsProvider.js';
import { AnalyticsEvents } from '../analytics/events.js';
import { Icon } from '../icons/Icon.js';
import { useOptionalWorkflowServer } from '../server/ServerContext.js';
import { useOptionalShellMode } from '../server/ShellModeContext.js';
import { isHubChromeEnabled } from '../server/serverChrome.js';
import { auiButtonClass, sidebarButtonRadiusClassName, sidebarRailButtonClassName } from './lib/buttonClasses.js';
import { cn } from './lib/cn.js';

export type HubButtonProps = {
  className?: string;
  compact?: boolean;
};

export function HubButton({ className, compact = false }: HubButtonProps) {
  const shell = useOptionalShellMode();
  const workflows = useOptionalWorkflowServer();
  const track = useTrackAnalytics();

  const enabled = isHubChromeEnabled({ workflows }) && shell != null;
  const open = shell?.hubOpen === true;

  if (!enabled) return null;

  return (
    <div className={cn('relative min-w-0', compact ? 'flex justify-center' : 'w-full', className)}>
      <button
        type="button"
        aria-label={compact ? 'Home' : undefined}
        title={compact ? 'Home' : undefined}
        aria-current={open ? 'page' : undefined}
        className={auiButtonClass({
          variant: 'ghost',
          className: cn(
            sidebarButtonRadiusClassName,
            'font-normal text-sidebar-text shadow-none hover:bg-secondary-button-hover hover:text-ghost-button-text',
            compact ? sidebarRailButtonClassName : 'h-8 w-full !justify-start px-2.5 text-sm',
            open &&
              'bg-primary-button-bg font-medium text-primary-button-text hover:bg-primary-button-hover hover:text-primary-button-text',
          ),
        })}
        onClick={() => {
          if (!open) track(AnalyticsEvents.Hub.PAGE_OPENED);
          shell.setHubOpen(true);
        }}
      >
        <Icon name="hub" size={compact ? 14 : undefined} />
        {compact ? (
          <span className="text-center">Home</span>
        ) : (
          <>
            <span className="truncate">Home</span>
            <Icon name="chevron-right" className="ml-auto size-3.5 shrink-0 opacity-60" />
          </>
        )}
      </button>
    </div>
  );
}

declare module '../theme/SlotsProvider.js' {
  interface AtomSlots {
    HubButton: typeof HubButton;
  }
}
