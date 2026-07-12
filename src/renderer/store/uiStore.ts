import { create } from 'zustand';

// Reusable confirm dialog state. Replaces native window.confirm() which
// steals OS-level keyboard focus from the BrowserWindow on Windows.
// Any component can call `useUiStore.getState().confirm({...})` and await
// the boolean result.

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'danger' | 'primary';
}

interface ConfirmState extends ConfirmOptions {
  open: boolean;
  resolve: ((value: boolean) => void) | null;
}

interface UiStore {
  confirmState: ConfirmState;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  resolveConfirm: (value: boolean) => void;
}

const initialConfirmState: ConfirmState = {
  open: false,
  title: '',
  message: '',
  confirmLabel: '确定',
  cancelLabel: '取消',
  variant: 'primary',
  resolve: null,
};

export const useUiStore = create<UiStore>((set, get) => ({
  confirmState: initialConfirmState,

  confirm: (options) =>
    new Promise<boolean>((resolve) => {
      set({
        confirmState: {
          open: true,
          title: options.title ?? '',
          message: options.message,
          confirmLabel: options.confirmLabel ?? '确定',
          cancelLabel: options.cancelLabel ?? '取消',
          variant: options.variant ?? 'primary',
          resolve,
        },
      });
    }),

  resolveConfirm: (value) => {
    const { resolve } = get().confirmState;
    resolve?.(value);
    set({ confirmState: initialConfirmState });
  },
}));
