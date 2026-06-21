import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function SettingsSection({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('divide-y rounded-lg border bg-card text-card-foreground', className)}>
      {children}
    </div>
  );
}

export function SettingsItem({
  title,
  description,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-h-18 items-center gap-4 px-4 py-4">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-foreground">{title}</div>
        {description && (
          <div className="mt-1 text-sm text-muted-foreground">
            {description}
          </div>
        )}
      </div>
      {children && <div className="shrink-0">{children}</div>}
    </div>
  );
}
