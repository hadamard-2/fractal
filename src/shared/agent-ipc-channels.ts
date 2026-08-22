export const AGENT_INVOKE_CHANNEL = 'fractal:agent:invoke';
export const AGENT_EVENT_CHANNEL = 'fractal:agent:event';

export type AgentInvokeRequest =
  | { method: 'listConversations' }
  | { method: 'getConversation'; id: string }
  | { method: 'createConversation' }
  | { method: 'sendMessage'; input: { conversationId: string; text: string } }
  | { method: 'cancelTurn'; input: { conversationId: string } }
  | { method: 'respondToPermission'; input: { requestId: string; decision: import('@/shared/agent-contract').PermissionDecision } };
