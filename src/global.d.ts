import type { AttachmentsApi, ConversationApi, ModelsApi } from '@/shared/conversation-contract';
import type { FractalSettingsApi } from '@/shared/settings-contract';
import type { TerminalApi } from '@/shared/terminal-contract';

declare global {
  interface Window {
    fractal: {
      conversations: ConversationApi;
      models: ModelsApi;
      settings: FractalSettingsApi;
      terminals: TerminalApi;
      attachments: AttachmentsApi;
    };
  }
}

export {};
