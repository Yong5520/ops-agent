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

// AskUserQuestion dialog state (P1-4). Mirrors the confirm() Promise pattern.
// The main process calls onAskUser -> renderer shows AskUserDialog -> user
// responds -> Promise resolves with answers.
interface AskUserOption {
  label: string;
  description?: string;
}

interface AskUserQuestionItem {
  question: string;
  header: string;
  options: AskUserOption[];
  multiSelect: boolean;
}

export interface AskUserAnswer {
  question: string;
  answer: string;
  isOther?: boolean;
  notes?: string;
}

interface AskUserState {
  open: boolean;
  sessionId: string;
  questions: AskUserQuestionItem[];
  resolve: ((answers: AskUserAnswer[]) => void) | null;
}

interface UiStore {
  confirmState: ConfirmState;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  resolveConfirm: (value: boolean) => void;
  askUserState: AskUserState;
  askUser: (sessionId: string, questions: AskUserQuestionItem[]) => Promise<AskUserAnswer[]>;
  resolveAskUser: (answers: AskUserAnswer[]) => void;
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

const initialAskUserState: AskUserState = {
  open: false,
  sessionId: '',
  questions: [],
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

  askUserState: initialAskUserState,

  askUser: (sessionId, questions) =>
    new Promise<AskUserAnswer[]>((resolve) => {
      set({
        askUserState: {
          open: true,
          sessionId,
          questions,
          resolve,
        },
      });
    }),

  resolveAskUser: (answers) => {
    const { resolve } = get().askUserState;
    resolve?.(answers);
    set({ askUserState: initialAskUserState });
  },
}));
