import { type ReactNode } from 'react';

interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  breadcrumbs?: Array<{ label: string; to?: string }>;
  actions?: ReactNode;
}

export function PageHeader({ title, description, breadcrumbs, actions }: PageHeaderProps) {
  return (
    <div className="mb-6">
      {breadcrumbs && breadcrumbs.length > 0 && (
        <div className="mb-2">
          {/* TODO: Add breadcrumb component */}
          <nav className="flex" aria-label="Breadcrumb">
            {breadcrumbs.map((crumb, index) => (
              <div key={index} className="flex items-center">
                {index > 0 && <span className="mx-2 text-muted-foreground">/</span>}
                {crumb.to ? (
                  <a href={crumb.to} className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
                    {crumb.label}
                  </a>
                ) : (
                  <span className="text-sm font-medium text-foreground">{crumb.label}</span>
                )}
              </div>
            ))}
          </nav>
        </div>
      )}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {description && <p className="text-muted-foreground mt-1">{description}</p>}
        </div>
        {actions && <div className="flex-shrink-0">{actions}</div>}
      </div>
    </div>
  );
}
