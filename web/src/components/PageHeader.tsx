import React from "react";
import { clsx } from "clsx";

export interface PageHeaderProps {
  /** Page title. Rendered as the page's single h1. */
  title: React.ReactNode;
  /** Short description under the title. */
  subtitle?: React.ReactNode;
  /** Small elements next to the title (spinner, badges, counters). */
  titleExtra?: React.ReactNode;
  /** Replaces the title with a custom control (e.g. the Rules / Filters switcher on phones). */
  switcher?: React.ReactNode;
  /** Buttons or badges aligned to the right (stack under the title on narrow screens). */
  actions?: React.ReactNode;
  className?: string;
}

/**
 * The one header every dashboard page uses, so title size, weight and spacing
 * are identical everywhere. Type sizes live in index.css (.page-title / .page-subtitle).
 */
export const PageHeader: React.FC<PageHeaderProps> = ({
  title,
  subtitle,
  titleExtra,
  switcher,
  actions,
  className,
}) => (
  <header
    className={clsx(
      "mb-6 flex flex-wrap items-center justify-between gap-x-4 gap-y-3",
      className
    )}
  >
    <div className="min-w-0 flex-1 basis-60">
      {switcher ?? (
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="page-title min-w-0 break-words">{title}</h1>
          {titleExtra}
        </div>
      )}
      {subtitle && <p className="page-subtitle">{subtitle}</p>}
    </div>
    {actions && (
      <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
    )}
  </header>
);
