export interface RendererSettings {
  narrativeEngineUrl: string;
  narrativeAuthoringUrl: string;
  realtimeGatewayUrl: string;
  chatBackendUrl: string;
  setupMode: 'create' | 'join';
  roomName: string;
  roomShortlink: string;
  evdId: string;
  storyType: 'WHISPERS' | 'CREATOR';
  sessionToken: string;
  autoRender: boolean;
  useCharacterReferences: boolean;
  characterReferences: CharacterReferenceSetting[];
  resolution: '480P' | '768P';
  duration: number;
}

export interface MessageChannel {
  id: string;
  state?: string;
  story_id?: number | null;
  created_at?: string | null;
}

export interface NarrativeRoom {
  id: string;
  name?: string;
  shortlink?: string | null;
  active_story_id?: number | null;
  message_channels?: MessageChannel[];
}

export interface StartedShow {
  playthrough_id: string;
  episode_id: number;
  episode_number: number;
  total_episodes: number;
}

export interface StartedShowRoom {
  room: NarrativeRoom;
  show: StartedShow;
}

export interface PreparedRendererShow {
  room: NarrativeRoom;
  storyId: number;
  storyMessageChannelId: string;
  storyConfig: {
    base_structure: 'WHISPERS' | 'CREATOR';
    evd_id: string;
    character_ids: string[];
    message_channel_ids: string[];
    story_premise?: string;
  };
}

export interface AvailableEvd {
  id: string;
  cvd_id: string;
  cvd_name: string;
  name: string;
  episode_number: number;
  is_active: boolean;
  is_published: boolean;
}

export interface ChatMessage {
  id: string;
  content: string;
  alias?: string | null;
  user_name?: string | null;
  created_at?: string | null;
}

export interface DssCommand {
  command?: string;
  args?: Record<string, unknown>;
  content?: Record<string, unknown>;
  delay?: number;
  blocking?: boolean;
  await?: boolean;
}

export interface DssCommandGroup {
  id?: string;
  sequence?: number;
  commands?: DssCommand[];
}

export interface DssScript {
  story_block_id?: string;
  scene_index?: number;
  story_block_index?: number;
  command_groups?: DssCommandGroup[];
}

export interface DssBrowserEvent {
  schema_version?: number;
  episode_id: number;
  sequence: number;
  payload_id?: string;
  story_block_id: string;
  payload_hash?: string;
  ne_env?: string;
  script: DssScript;
}

export interface StoryBeat {
  storyBlockId: string;
  sceneIndex: number;
  blockIndex: number;
  prompt: string;
  sequence: number;
  durationSeconds?: number;
  title?: string;
  source?: 'live' | 'imported';
  chunkIndex?: number;
  chunkCount?: number;
  sourceEventKey?: string;
  sourceGroupId?: string;
  characterNames?: string[];
  speakerName?: string;
  dialogueAudioUrl?: string;
  dialogueAudioDurationSeconds?: number;
}

export interface CharacterReferenceSetting {
  characterName: string;
  imageUrl: string;
  audioUrl: string;
}

export interface CharacterReferenceMedia {
  characterName: string;
  assetKey?: string;
  imageUrl?: string;
  audioUrl?: string;
  audioRole?: 'voice_sample' | 'dialogue_performance';
  audioDurationSeconds?: number;
}

export interface ImportedEpisode {
  id: string;
  serviceEvdId: string | null;
  name: string;
  episodeNumber: number;
  beats: StoryBeat[];
}

export interface ImportedShow {
  name: string;
  storyType: 'WHISPERS' | 'CREATOR' | null;
  episodes: ImportedEpisode[];
}

export interface GeneratedClip {
  id: string;
  storyBlockId: string;
  prompt: string;
  videoUrl: string;
  requestId: string;
  createdAt: number;
  durationSeconds: number;
  totalSeconds: number;
  generationMs: number;
  generationMode: 'text' | 'reference';
  referenceCharacters: string[];
}

export interface ExternalRendererPlaybackState {
  update_id: string;
  played_through_sequence: number;
  ready_video_seconds: number;
  generating_video_seconds: number;
  generation_latency_p90_ms: number | null;
  desired_runway_seconds: number;
}

export interface ExternalRendererPlaybackStateResult {
  story_id: number;
  update_id: string;
  accepted_played_through_sequence: number;
  completion_frontier: number;
  highest_sent_sequence: number;
  desired_runway_seconds: number;
}
