import type { ConversationApi } from '@/shared/conversation-contract';
import type { FractalSettingsApi } from '@/shared/settings-contract';
import type { TerminalApi } from '@/shared/terminal-contract';

declare global {
  interface Window {
    fractal: {
      conversations: ConversationApi;
      settings: FractalSettingsApi;
      terminals: TerminalApi;
    };
  }
}

export {};
