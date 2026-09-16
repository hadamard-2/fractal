import type { ConversationApi } from '@/shared/conversation-contract';
import type { FractalSettingsApi } from '@/shared/settings-contract';

declare global {
  interface Window {
    fractal: {
      conversations: ConversationApi;
      settings: FractalSettingsApi;
    };
  }
}

export {};
