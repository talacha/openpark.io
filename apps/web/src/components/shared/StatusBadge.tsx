import { Badge } from '@/components/ui/badge';
import { type ReactNode } from 'react';

interface StatusBadgeProps {
  tone: 'success' | 'warning' | 'info' | 'destructive' | 'neutral';
  children: ReactNode;
}

export function StatusBadge({ tone, children }: StatusBadgeProps) {
  // Map semantic tones to available Badge variants
  const variantMap: Record<string, 'outline' | 'destructive' | 'secondary'> = {
    success: 'outline',
    warning: 'outline',
    info: 'outline',
    destructive: 'destructive',
    neutral: 'secondary',
  };
  const variant = variantMap[tone] ?? 'default';
  return <Badge variant={variant}>{children}</Badge>;
}
