import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { AlertCircle } from 'lucide-react';

interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  destructive?: boolean;
  requireText?: string;
}

interface ConfirmResult {
  confirmed: boolean;
  text?: string;
}

export function useConfirm() {
  const controllerRef = useRef<{
    resolve: ((result: ConfirmResult) => void) | null;
    options: ConfirmOptions | null;
  }>({ resolve: null, options: null });

  useEffect(() => {
    return () => {
      if (controllerRef.current.resolve) {
        controllerRef.current.resolve({ confirmed: false });
        controllerRef.current.resolve = null;
      }
    };
  }, []);

  const confirm = (options: ConfirmOptions): Promise<ConfirmResult> => {
    controllerRef.current.options = options;
    return new Promise((resolve) => {
      controllerRef.current.resolve = resolve;
    });
  };

  const close = (confirmed: boolean, text?: string) => {
    if (controllerRef.current.resolve) {
      controllerRef.current.resolve({ confirmed, text });
      controllerRef.current.resolve = null;
      controllerRef.current.options = null;
    }
  };

  const isOpen = controllerRef.current.resolve !== null;
  const options = controllerRef.current.options;

  return { confirm, close, isOpen, options };
}
