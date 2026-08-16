// v24 activity-mirror event types, shared by main and renderer.
//
// The main-process `activity-mirror` ring records what the AI's exec channels
// send/receive; these events are broadcast to every window rendering the
// activity terminal. Defining them in shared/ avoids parallel re-declarations
// in preload-api.ts, global.d.ts, and the renderer store.

export interface AgentMirrorCommandEvent {
  kind: 'command';
  seq: number;
  sessionId: string;
  hostId: string;
  hostName: string;
  toolName: string;
  command: string;
  description?: string;
  commandType: string;
}

export interface AgentMirrorChunkEvent {
  kind: 'chunk';
  seq: number;
  sessionId: string;
  hostId: string;
  stream: 'stdout' | 'stderr';
  /** Raw chunk as received from the transport (NOT cleaned). */
  data: string;
}

export interface AgentMirrorFinalEvent {
  kind: 'final';
  seq: number;
  sessionId: string;
  hostId: string;
  success: boolean;
  exitCode: number | null;
  durationMs?: number;
  stderr?: string;
  blockedReason?: string;
}

export type AgentMirrorEvent =
  | AgentMirrorCommandEvent
  | AgentMirrorChunkEvent
  | AgentMirrorFinalEvent;
