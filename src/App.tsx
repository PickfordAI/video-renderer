import { type ChangeEvent, type FormEvent, useEffect, useMemo, useRef, useState } from 'react';

import {
  createDefaultCharacterReferences,
  loadCharacterReferences,
  resolveCharacterReferences,
} from './lib/character-references';
import { buildStoryShots, createDssShotPlannerState, dssEventKey } from './lib/dss';
import { matchImportedEpisode, parseCvdOrEvdExport } from './lib/evd';
import { desiredRunwaySeconds, ExternalPlaybackTracker, percentile90 } from './lib/external-playback';
import {
  getExternalRendererConnection,
  startExternalRendererConnection,
  stopExternalRendererConnection,
} from './lib/external-renderer';
import { playMediaMuted, playMediaWithSound, unlockMediaPlayback } from './lib/media-unlock';
import {
  createAndStartShow,
  prepareRendererShow,
  joinAndReadRoom,
  listAvailableEvds,
  openChat,
  openDssEvents,
  pickActiveMessageChannel,
  reportExternalPlaybackState,
  stopStartedShow,
  type ChatConnection,
} from './lib/narrative-engine';
import {
  attachHlsPlayer,
  enqueuePlayoutClip,
  getPlayoutStatus,
  startPlayout,
  stopPlayout,
  type PlayoutStatus,
} from './lib/playout';
import { orderClipsByTimeline, RenderPipeline, type RenderPipelineSnapshot } from './lib/render-pipeline';
import { renderBeat } from './lib/renderer';
import { isUuid } from './lib/uuid';
import type {
  ChatMessage,
  CharacterReferenceSetting,
  GeneratedClip,
  ImportedEpisode,
  ImportedShow,
  NarrativeRoom,
  AvailableEvd,
  RendererSettings,
  StoryBeat,
} from './lib/types';

const DEFAULT_SETTINGS: RendererSettings = {
  narrativeEngineUrl: 'http://localhost:8081',
  narrativeAuthoringUrl: 'http://localhost:8091',
  realtimeGatewayUrl: 'http://localhost:8092',
  chatBackendUrl: 'http://localhost:8080',
  setupMode: 'create',
  roomName: 'MiniMax H3 Live Show',
  roomShortlink: '',
  evdId: '',
  storyType: 'WHISPERS',
  sessionToken: '',
  autoRender: false,
  useCharacterReferences: false,
  characterReferences: createDefaultCharacterReferences(),
  resolution: '768P',
  duration: 5,
};

const SAMPLE_BEAT: StoryBeat = {
  storyBlockId: 'sample-beat',
  sceneIndex: 0,
  blockIndex: 0,
  sequence: -1,
  prompt:
    'Cinematic live-action noir story scene inside a rain-slicked late-night diner. ' +
    'A detective studies an abandoned coffee cup as red neon flickers across the window. ' +
    'Slow dolly forward, moody practical lighting, shallow depth of field, subtle rain and room tone.',
};

type ConnectionState = 'idle' | 'connecting' | 'connected' | 'error';
type TransportState = 'idle' | 'connected' | 'error' | 'closed';
type ImportedSource = { value: unknown; fileName: string };

const EMPTY_PIPELINE: RenderPipelineSnapshot = { queuedIds: [], activeIds: [], failedIds: [] };

function loadSettings(): RendererSettings {
  try {
    const persisted = JSON.parse(localStorage.getItem('h3-renderer-settings') ?? '{}') as Partial<RendererSettings> & {
      characterReferenceUrls?: string;
    };
    return {
      ...DEFAULT_SETTINGS,
      ...persisted,
      evdId: isUuid(persisted.evdId) ? persisted.evdId.trim() : '',
      sessionToken: sessionStorage.getItem('h3-renderer-token') ?? '',
      characterReferences: loadCharacterReferences(persisted.characterReferences, persisted.characterReferenceUrls),
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveSettings(settings: RendererSettings): void {
  const { sessionToken, ...persisted } = settings;
  localStorage.setItem('h3-renderer-settings', JSON.stringify(persisted));
  sessionStorage.setItem('h3-renderer-token', sessionToken);
}

function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, { ...byId.get(message.id), ...message });
  return [...byId.values()]
    .sort((a, b) => Date.parse(a.created_at ?? '') - Date.parse(b.created_at ?? ''))
    .slice(-200);
}

function messageAuthor(message: ChatMessage): string {
  return message.alias || message.user_name || 'Audience';
}

function plannedDuration(beat: StoryBeat, fallback: number): number {
  return beat.durationSeconds ?? fallback;
}

function renderCost(
  durationSeconds: number,
  resolution: RendererSettings['resolution'],
  usesReferences = false,
): string {
  const rate = usesReferences
    ? resolution === '480P' ? 0.05 : 0.08
    : resolution === '480P' ? 0.025 : 0.04;
  return (durationSeconds * rate).toFixed(2);
}

function StatusDot({ state }: { state: ConnectionState | TransportState }) {
  return <span className={`status-dot status-${state}`} aria-hidden="true" />;
}

export function App() {
  const [settings, setSettings] = useState<RendererSettings>(loadSettings);
  const [showSettings, setShowSettings] = useState(true);
  const [connectionState, setConnectionState] = useState<ConnectionState>('idle');
  const [dssState, setDssState] = useState<TransportState>('idle');
  const [chatState, setChatState] = useState<TransportState>('idle');
  const [room, setRoom] = useState<NarrativeRoom | null>(null);
  const [beats, setBeats] = useState<Map<string, StoryBeat>>(new Map());
  const [lastBeatId, setLastBeatId] = useState<string | null>(null);
  const [clips, setClips] = useState<GeneratedClip[]>([]);
  const [currentClipId, setCurrentClipId] = useState<string | null>(null);
  const [playoutStatus, setPlayoutStatus] = useState<PlayoutStatus | null>(null);
  const [playbackActivated, setPlaybackActivated] = useState(false);
  const [streamPlayable, setStreamPlayable] = useState(false);
  const [generatingBeatId, setGeneratingBeatId] = useState<string | null>(null);
  const [pipelineState, setPipelineState] = useState<RenderPipelineSnapshot>(EMPTY_PIPELINE);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [importedShow, setImportedShow] = useState<ImportedShow | null>(null);
  const [importedEpisodeId, setImportedEpisodeId] = useState<string>('');
  const [importedSource, setImportedSource] = useState<ImportedSource | null>(null);
  const [availableEvds, setAvailableEvds] = useState<AvailableEvd[]>([]);
  const [loadingAvailableEvds, setLoadingAvailableEvds] = useState(false);
  const [stoppingShow, setStoppingShow] = useState(false);
  const [chatDraft, setChatDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [falConfigured, setFalConfigured] = useState<boolean | null>(null);
  const [videoProvider, setVideoProvider] = useState<'minimax-direct' | 'fal' | null>(null);
  const [rendererPlatformConfigured, setRendererPlatformConfigured] = useState(false);
  const [platformRunId, setPlatformRunId] = useState<string | null>(null);
  const [platformOutcome, setPlatformOutcome] = useState<'ended' | 'stopped' | 'failed' | null>(null);
  const [showStartGate, setShowStartGate] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [masterVolume, setMasterVolume] = useState(0.85);
  const dssRef = useRef<EventSource | null>(null);
  const dssPlannerRef = useRef(createDssShotPlannerState());
  const durationRef = useRef(settings.duration);
  const settingsRef = useRef(settings);
  const falConfiguredRef = useRef(falConfigured);
  const chatRef = useRef<ChatConnection | null>(null);
  const liveTimelineRef = useRef<StoryBeat[]>([]);
  const clipByBeatRef = useRef(new Map<string, GeneratedClip>());
  const currentClipIdRef = useRef<string | null>(null);
  const playbackCursorRef = useRef(0);
  const streamVideoRef = useRef<HTMLVideoElement | null>(null);
  const playoutSessionIdRef = useRef<string | null>(null);
  const platformRunIdRef = useRef<string | null>(null);
  const enqueuedPlayoutBeatsRef = useRef(new Set<string>());
  const lastPlayedPlayoutPositionRef = useRef(-1);
  const pipelineRef = useRef<RenderPipeline | null>(null);
  const manualRenderControllerRef = useRef<AbortController | null>(null);
  const startedShowSettingsRef = useRef<RendererSettings | null>(null);
  const connectedRoomSettingsRef = useRef<RendererSettings | null>(null);
  const roomRef = useRef<NarrativeRoom | null>(null);
  const externalPlaybackEnabledRef = useRef(false);
  const externalPlaybackTrackerRef = useRef(new ExternalPlaybackTracker());
  const generationLatenciesRef = useRef<number[]>([]);
  const externalReportChainRef = useRef<Promise<void>>(Promise.resolve());
  const externalSessionRef = useRef(0);

  const currentClip = clips.find((clip) => clip.id === currentClipId) ?? null;
  const latestBeat = lastBeatId ? beats.get(lastBeatId) ?? null : null;
  const selectedImportedEpisode = importedShow?.episodes.find((episode) => episode.id === importedEpisodeId) ?? null;
  const importedServerMatch = importedShow && selectedImportedEpisode
    ? matchImportedEpisode(availableEvds, importedShow, selectedImportedEpisode)
    : null;
  const baselineSpendPerClip = renderCost(settings.duration, settings.resolution);
  const selectedBeatDuration = plannedDuration(latestBeat ?? SAMPLE_BEAT, settings.duration);
  const selectedBeatReferences = settings.useCharacterReferences
    ? resolveCharacterReferences(latestBeat ?? SAMPLE_BEAT, settings.characterReferences)
    : [];
  const selectedBeatSpend = renderCost(
    selectedBeatDuration,
    settings.resolution,
    selectedBeatReferences.length > 0,
  );
  const configuredModelLabel = videoProvider === 'minimax-direct' ? 'MiniMax H3 Max direct' : 'MiniMax H3 Max Turbo via fal';
  const needsPlaybackStart = !playbackActivated;
  const hlsAttachmentKey = playoutStatus?.hlsUrl
    ? `${playoutStatus.hlsUrl}:hlsjs-first`
    : undefined;

  const orderedBeats = useMemo(
    () => [...beats.values()].sort((a, b) => b.sequence - a.sequence),
    [beats],
  );

  const updateCharacterReference = (
    index: number,
    field: keyof CharacterReferenceSetting,
    value: string,
  ) => {
    setSettings((current) => ({
      ...current,
      characterReferences: current.characterReferences.map((reference, referenceIndex) =>
        referenceIndex === index ? { ...reference, [field]: value } : reference,
      ),
    }));
  };

  const addCharacterReference = () => {
    setSettings((current) => ({
      ...current,
      characterReferences: [...current.characterReferences, { characterName: '', imageUrl: '', audioUrl: '' }],
    }));
  };

  const removeCharacterReference = (index: number) => {
    setSettings((current) => ({
      ...current,
      characterReferences: current.characterReferences.filter((_, referenceIndex) => referenceIndex !== index),
    }));
  };

  useEffect(() => {
    void fetch('/api/config').then(response => response.json()).then((config) => {
      const endpoints = Object.fromEntries(Object.entries(config).filter(([key, value]) => key in DEFAULT_SETTINGS && typeof value === 'string' && value));
      setSettings(current => ({ ...current, ...endpoints }));
    }).catch(() => undefined);
    void fetch('/api/health')
      .then((response) => response.json())
      .then((body: { provider?: 'minimax-direct' | 'fal'; falKeyConfigured?: boolean; minimaxKeyConfigured?: boolean; rendererPlatformConfigured?: boolean }) => {
        setVideoProvider(body.provider ?? null);
        setFalConfigured(Boolean(body.falKeyConfigured || body.minimaxKeyConfigured));
        setRendererPlatformConfigured(Boolean(body.rendererPlatformConfigured));
      })
      .catch(() => setFalConfigured(false));
  }, []);

  useEffect(() => {
    durationRef.current = settings.duration;
    settingsRef.current = settings;
  }, [settings.duration]);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    falConfiguredRef.current = falConfigured;
  }, [falConfigured]);

  const selectClip = (clipId: string | null) => {
    currentClipIdRef.current = clipId;
    setCurrentClipId(clipId);
  };

  const queueExternalPlaybackReport = (pipeline = pipelineRef.current?.snapshot() ?? EMPTY_PIPELINE) => {
    const activeRoom = roomRef.current;
    const activeSettings = startedShowSettingsRef.current;
    if (!externalPlaybackEnabledRef.current || !activeRoom || !activeSettings) return;
    const generationLatencyP90Ms = percentile90(generationLatenciesRef.current);
    const readyClips = liveTimelineRef.current
      .slice(playbackCursorRef.current)
      .filter((beat) => clipByBeatRef.current.has(beat.storyBlockId));
    const timelineById = new Map(liveTimelineRef.current.map((beat) => [beat.storyBlockId, beat]));
    const durationForId = (id: string) => plannedDuration(timelineById.get(id) ?? SAMPLE_BEAT, activeSettings.duration);
    const recentDurations = liveTimelineRef.current
      .slice(-20)
      .map((beat) => plannedDuration(beat, activeSettings.duration));
    const typicalClipDuration = recentDurations.length > 0
      ? recentDurations.reduce((total, duration) => total + duration, 0) / recentDurations.length
      : activeSettings.duration;
    const state = {
      update_id: crypto.randomUUID(),
      played_through_sequence: externalPlaybackTrackerRef.current.frontier(),
      ready_video_seconds: readyClips.reduce(
        (total, beat) => total + plannedDuration(beat, activeSettings.duration),
        0,
      ),
      generating_video_seconds: [...pipeline.activeIds, ...pipeline.queuedIds].reduce(
        (total, id) => total + durationForId(id),
        0,
      ),
      generation_latency_p90_ms: generationLatencyP90Ms,
      desired_runway_seconds: desiredRunwaySeconds(generationLatencyP90Ms, typicalClipDuration),
    };
    const session = externalSessionRef.current;
    externalReportChainRef.current = externalReportChainRef.current
      .catch(() => undefined)
      .then(async () => {
        await reportExternalPlaybackState(activeSettings, activeRoom.id, state);
      })
      .catch((reportError: unknown) => {
        if (session !== externalSessionRef.current) return;
        setError(reportError instanceof Error
          ? `Narrative Engine rejected renderer progress: ${reportError.message}`
          : 'Narrative Engine rejected renderer progress.');
      });
  };

  const applyMasterAudio = (enabled: boolean, volume: number) => {
    const video = streamVideoRef.current;
    if (!video) return;
    video.muted = !enabled;
    video.volume = volume;
  };

  const toggleMasterSound = () => {
    const enabled = !soundEnabled;
    setSoundEnabled(enabled);
    const video = streamVideoRef.current;
    if (!video) return;
    if (!enabled) {
      applyMasterAudio(false, masterVolume);
      return;
    }
    void playMediaWithSound(video, masterVolume)
      .then(() => setPlaybackActivated(true))
      .catch(() => undefined);
  };

  const startStreamPlayback = () => {
    const video = streamVideoRef.current;
    if (!video) return;
    setSoundEnabled(true);
    void playMediaWithSound(video, masterVolume).then(() => {
      setPlaybackActivated(true);
    }).catch((playError: unknown) => {
      setError(playError instanceof Error
        ? `The browser could not start the live stream: ${playError.message}`
        : 'The browser could not start the live stream.');
    });
  };

  const changeMasterVolume = (volume: number) => {
    const nextVolume = Math.max(0, Math.min(1, volume));
    setMasterVolume(nextVolume);
    applyMasterAudio(soundEnabled, nextVolume);
  };

  const handleStreamVolumeChange = () => {
    const video = streamVideoRef.current;
    if (!video) return;
    const enabled = !video.muted;
    setSoundEnabled(enabled);
    setMasterVolume(video.volume);
    if (enabled && !video.paused) setPlaybackActivated(true);
    applyMasterAudio(enabled, video.volume);
  };

  useEffect(() => {
    applyMasterAudio(soundEnabled, masterVolume);
  }, [soundEnabled, masterVolume]);

  useEffect(() => {
    const video = streamVideoRef.current;
    if (!video || !playoutStatus?.hlsUrl) return undefined;
    setPlaybackActivated(false);
    setStreamPlayable(false);
    setSoundEnabled(false);
    video.muted = true;
    video.volume = masterVolume;
    const detach = attachHlsPlayer(video, playoutStatus.hlsUrl, (message) => setError(message));
    return detach;
  }, [playoutStatus?.sessionId, hlsAttachmentKey]);

  const enqueueClipForPlayout = (clip: GeneratedClip) => {
    const sessionId = playoutSessionIdRef.current;
    const position = liveTimelineRef.current.findIndex((beat) => beat.storyBlockId === clip.storyBlockId);
    if (!sessionId || position < 0 || enqueuedPlayoutBeatsRef.current.has(clip.storyBlockId)) return;
    enqueuedPlayoutBeatsRef.current.add(clip.storyBlockId);
    void enqueuePlayoutClip(sessionId, clip, position)
      .then((status) => setPlayoutStatus(status))
      .catch((playoutError: unknown) => {
        enqueuedPlayoutBeatsRef.current.delete(clip.storyBlockId);
        setError(playoutError instanceof Error ? `Continuous playout failed: ${playoutError.message}` : 'Continuous playout failed.');
      });
  };

  useEffect(() => {
    const sessionId = playoutStatus?.sessionId;
    if (!sessionId || sessionId.startsWith('external:')) return undefined;
    let cancelled = false;
    const poll = async () => {
      try {
        const status = await getPlayoutStatus(sessionId);
        if (cancelled) return;
        setPlayoutStatus(status);
        if (status.state === 'error') {
          setError(`Continuous playout failed: ${status.error ?? 'the stream publisher stopped'}`);
          return;
        }
        if (status.currentPosition !== null) {
          const beat = liveTimelineRef.current[status.currentPosition];
          const clip = beat ? clipByBeatRef.current.get(beat.storyBlockId) : null;
          if (clip && clip.id !== currentClipIdRef.current) selectClip(clip.id);
        }
        if (status.playedThroughPosition > lastPlayedPlayoutPositionRef.current) {
          for (
            let position = lastPlayedPlayoutPositionRef.current + 1;
            position <= status.playedThroughPosition;
            position += 1
          ) {
            const beat = liveTimelineRef.current[position];
            if (beat) externalPlaybackTrackerRef.current.markPlayed(beat.storyBlockId);
          }
          lastPlayedPlayoutPositionRef.current = status.playedThroughPosition;
          playbackCursorRef.current = status.playedThroughPosition + 1;
          queueExternalPlaybackReport();
        }
      } catch (statusError) {
        if (!cancelled) {
          setError(statusError instanceof Error
            ? `Could not read continuous playout status: ${statusError.message}`
            : 'Could not read continuous playout status.');
        }
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 750);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [playoutStatus?.sessionId]);

  useEffect(() => {
    if (!platformRunId) return undefined;
    let cancelled = false;
    const poll = async () => {
      try {
        const status = await getExternalRendererConnection();
        if (cancelled || status.runId !== platformRunId) return;
        if (status.state === 'ended' || status.state === 'stopped' || status.state === 'failed') {
          cancelled = true;
          disconnect(false);
          startedShowSettingsRef.current = null;
          setPlatformOutcome(status.state);
          if (status.state === 'failed') {
            setError(status.failures.at(-1) ?? 'Renderer Platform bridge failed');
            setConnectionState('error');
            setDssState('error');
          }
          return;
        }
        setDssState(status.state === 'running' ? 'connected' : 'idle');
        if (status.hlsUrl) {
          setPlayoutStatus({
            sessionId: `external:${status.runId}`,
            hlsUrl: status.hlsUrl,
            state: status.clipsRendered > 0 ? 'streaming' : 'buffering',
            normalizedClips: status.clipsRendered,
            pendingClips: 0,
            currentPosition: null,
            playedThroughPosition: status.clipsRendered - 1,
            outputSeconds: 0,
            error: null,
          });
        }
      } catch (statusError) {
        if (!cancelled) setError(statusError instanceof Error ? statusError.message : 'Could not read Renderer Platform status');
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 750);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [platformRunId]);

  useEffect(() => {
    const pipeline = new RenderPipeline({
      concurrency: 3,
      retries: 0,
      render: (beat, signal) => renderBeat(beat, settingsRef.current, signal),
      onClip: (_beat, clip) => {
        clipByBeatRef.current.set(clip.storyBlockId, clip);
        generationLatenciesRef.current = [...generationLatenciesRef.current.slice(-49), clip.generationMs];
        setClips(orderClipsByTimeline(liveTimelineRef.current, clipByBeatRef.current));
        enqueueClipForPlayout(clip);
        queueExternalPlaybackReport();
      },
      onError: (beat, renderError) => {
        setError(`Video generation failed for ${beat.title ?? beat.storyBlockId}: ${renderError.message}`);
        pipelineRef.current?.clear();
      },
      onState: (snapshot) => {
        setPipelineState(snapshot);
        queueExternalPlaybackReport(snapshot);
      },
    });
    pipelineRef.current = pipeline;
    return () => {
      pipeline.clear();
      pipelineRef.current = null;
    };
  }, []);

  useEffect(() => {
    return () => {
      dssRef.current?.close();
      chatRef.current?.socket.close(1000, 'renderer unmounted');
      const sessionId = playoutSessionIdRef.current;
      playoutSessionIdRef.current = null;
      if (sessionId) void stopPlayout(sessionId).catch(() => undefined);
      if (platformRunIdRef.current) void stopExternalRendererConnection(platformRunIdRef.current).catch(() => undefined);
    };
  }, []);

  const disconnect = (stopPlatform = true) => {
    setPlatformOutcome(null);
    externalSessionRef.current += 1;
    externalPlaybackEnabledRef.current = false;
    externalPlaybackTrackerRef.current.reset();
    generationLatenciesRef.current = [];
    roomRef.current = null;
    connectedRoomSettingsRef.current = null;
    dssRef.current?.close();
    dssRef.current = null;
    const playoutSessionId = playoutSessionIdRef.current;
    playoutSessionIdRef.current = null;
    if (playoutSessionId) void stopPlayout(playoutSessionId).catch(() => undefined);
    if (stopPlatform && platformRunIdRef.current) void stopExternalRendererConnection(platformRunIdRef.current).catch(() => undefined);
    platformRunIdRef.current = null;
    setPlatformRunId(null);
    setPlayoutStatus(null);
    enqueuedPlayoutBeatsRef.current.clear();
    lastPlayedPlayoutPositionRef.current = -1;
    chatRef.current?.socket.close(1000, 'renderer disconnected');
    chatRef.current = null;
    setConnectionState('idle');
    setDssState('idle');
    setChatState('idle');
    setRoom(null);
    dssPlannerRef.current = createDssShotPlannerState();
    pipelineRef.current?.clear();
    manualRenderControllerRef.current?.abort(new DOMException('Renderer stopped', 'AbortError'));
    manualRenderControllerRef.current = null;
    setGeneratingBeatId(null);
    liveTimelineRef.current = [];
    clipByBeatRef.current.clear();
    playbackCursorRef.current = 0;
    setPlaybackActivated(false);
    setStreamPlayable(false);
    selectClip(null);
  };

  const stopShow = async () => {
    if (stoppingShow) return;
    setStoppingShow(true);
    setError(null);
    let stopFailure: unknown = null;
    try {
      const connectedRoomSettings = connectedRoomSettingsRef.current;
      if (connectedRoomSettings) {
        await stopStartedShow(connectedRoomSettings);
      }
    } catch (stopError) {
      stopFailure = stopError;
    } finally {
      startedShowSettingsRef.current = null;
      disconnect();
      setBeats(new Map());
      setLastBeatId(null);
      setClips([]);
      setMessages([]);
      setChatDraft('');
      setImportedShow(null);
      setImportedEpisodeId('');
      setImportedSource(null);
      setShowSettings(true);
      setStoppingShow(false);
    }
    if (stopFailure) {
      setError(stopFailure instanceof Error ? `Could not stop the Narrative Engine show: ${stopFailure.message}` : 'Could not stop the Narrative Engine show.');
    }
  };

  const loadImportedEpisode = (episode: ImportedEpisode, show = importedShow) => {
    const importedBeats = new Map(episode.beats.map((beat) => [beat.storyBlockId, beat]));
    const matched = show ? matchImportedEpisode(availableEvds, show, episode) : null;
    setBeats(importedBeats);
    setLastBeatId(episode.beats[0]?.storyBlockId ?? null);
    setImportedEpisodeId(episode.id);
    setSettings((current) => ({ ...current, evdId: episode.serviceEvdId ?? matched?.id ?? '' }));
    setError(null);
  };

  const applyImportedSource = (source: ImportedSource, duration: number, preferredEpisodeId?: string) => {
    const parsed = parseCvdOrEvdExport(source.value, source.fileName, { durationSeconds: duration });
    const episode = parsed.episodes.find((item) => item.id === preferredEpisodeId) ?? parsed.episodes[0];
    setImportedShow(parsed);
    setClips([]);
    setCurrentClipId(null);
    loadImportedEpisode(episode, parsed);
    return { parsed, episode };
  };

  const importShow = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const source = { value: JSON.parse(await file.text()) as unknown, fileName: file.name };
      disconnect();
      setImportedSource(source);
      const { parsed, episode } = applyImportedSource(source, settings.duration);
      const storyType = parsed.storyType ?? settings.storyType;
      setSettings((current) => ({
        ...current,
        storyType,
        evdId: episode.serviceEvdId ?? '',
      }));
      if (settings.sessionToken.trim()) void loadAvailableShows(parsed, episode, storyType);
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : 'Could not read this CVD/EVD export.');
      event.target.value = '';
    }
  };

  const loadAvailableShows = async (
    show = importedShow,
    episode = show?.episodes.find((item) => item.id === importedEpisodeId) ?? show?.episodes[0] ?? null,
    storyType = settings.storyType,
  ) => {
    if (!settings.sessionToken.trim()) {
      setError('Enter a fresh session token before loading Narrative Engine shows.');
      return;
    }
    setLoadingAvailableEvds(true);
    setError(null);
    try {
      const available = await listAvailableEvds({ ...settings, storyType });
      setAvailableEvds(available);
      if (available.length === 0) {
        setSettings((current) => ({ ...current, evdId: '' }));
        setError(`Narrative Authoring returned no ${storyType === 'CREATOR' ? 'Creator' : 'Whispers'} EVDs visible to this account. The JSON file is a local preview and is not uploaded.`);
        return;
      }
      const matched = show && episode ? matchImportedEpisode(available, show, episode) : null;
      setSettings((current) => ({
        ...current,
        storyType,
        evdId: matched?.id ?? (available.some((evd) => evd.id === current.evdId) ? current.evdId : available[0].id),
      }));
    } catch (loadError) {
      setAvailableEvds([]);
      setError(loadError instanceof Error ? loadError.message : 'Could not load Narrative Engine EVDs.');
    } finally {
      setLoadingAvailableEvds(false);
    }
  };

  const generate = async (beat: StoryBeat) => {
    if (generatingBeatId) return;
    if (platformRunIdRef.current || connectionState === 'connecting') {
      setError('Manual rendering is disabled while the Renderer Platform run is active.');
      return;
    }
    if (!falConfigured) {
      setError('A MiniMax or fal API key is not configured on the local renderer server.');
      return;
    }
    setGeneratingBeatId(beat.storyBlockId);
    setError(null);
    const controller = new AbortController();
    manualRenderControllerRef.current = controller;
    try {
      const clip = await renderBeat(beat, settings, controller.signal);
      if (controller.signal.aborted || manualRenderControllerRef.current !== controller) return;
      if (!playoutSessionIdRef.current) {
        const initialPlayoutStatus = await startPlayout(1);
        if (controller.signal.aborted || manualRenderControllerRef.current !== controller) {
          await stopPlayout(initialPlayoutStatus.sessionId).catch(() => undefined);
          return;
        }
        playoutSessionIdRef.current = initialPlayoutStatus.sessionId;
        setPlayoutStatus(initialPlayoutStatus);
      }
      if (!liveTimelineRef.current.some((item) => item.storyBlockId === beat.storyBlockId)) {
        liveTimelineRef.current.push(beat);
      }
      clipByBeatRef.current.set(beat.storyBlockId, clip);
      setClips(orderClipsByTimeline(liveTimelineRef.current, clipByBeatRef.current));
      selectClip(clip.id);
      enqueueClipForPlayout(clip);
    } catch (generationError) {
      if (!controller.signal.aborted) {
        setError(generationError instanceof Error ? generationError.message : 'Video generation failed');
      }
    } finally {
      if (manualRenderControllerRef.current === controller) {
        manualRenderControllerRef.current = null;
        setGeneratingBeatId(null);
      }
    }
  };

  useEffect(() => {
    if (settings.autoRender && connectionState === 'connected') {
      pipelineRef.current?.enqueue(liveTimelineRef.current);
    }
  }, [connectionState, settings.autoRender]);

  const validateConnection = (): string | null => {
    if (!settings.sessionToken.trim()) {
      return 'A session token is required.';
    }
    if (settings.setupMode === 'join' && !settings.roomShortlink.trim()) {
      return 'A room code is required when joining an existing show.';
    }
    if (settings.setupMode === 'create' && (!settings.roomName.trim() || !settings.evdId.trim())) {
      return 'Room name and a Narrative Engine EVD are required to start a show.';
    }
    if (settings.setupMode === 'create' && !isUuid(settings.evdId)) {
      return 'Choose a Narrative Engine EVD. Local labels such as episode-0 cannot start a show.';
    }
    if (settings.setupMode === 'create' && !settings.autoRender && !rendererPlatformConfigured) {
      return 'Enable continuous auto-render before starting a live H3 Max show.';
    }
    if (settings.setupMode === 'create' && !falConfigured) {
      return 'A MiniMax or fal API key must be configured before starting a live H3 Max show.';
    }
    return null;
  };

  const requestConnection = (event: FormEvent) => {
    event.preventDefault();
    const validationError = validateConnection();
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    setShowStartGate(true);
  };

  const connect = async () => {
    const validationError = validateConnection();
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    try {
      if (startedShowSettingsRef.current) {
        await stopStartedShow(startedShowSettingsRef.current);
        startedShowSettingsRef.current = null;
      }
      disconnect();
      saveSettings(settings);
      setConnectionState('connecting');
      const usePlatformBridge = settings.setupMode === 'create' && rendererPlatformConfigured;
      if (!usePlatformBridge) {
        const initialPlayoutStatus = await startPlayout();
        playoutSessionIdRef.current = initialPlayoutStatus.sessionId;
        setPlayoutStatus(initialPlayoutStatus);
      }
      let connectedSettings = settings;
      let joinedRoom: NarrativeRoom;
      if (settings.setupMode === 'create') {
        const started = usePlatformBridge
          ? await prepareRendererShow(settings)
          : await createAndStartShow(settings);
        const shortlink = started.room.shortlink?.trim();
        if (!shortlink) throw new Error('Narrative Engine created a room without a room code.');
        connectedSettings = { ...settings, roomShortlink: shortlink };
        setSettings(connectedSettings);
        saveSettings(connectedSettings);
        joinedRoom = started.room;
        startedShowSettingsRef.current = connectedSettings;
        externalPlaybackEnabledRef.current = !usePlatformBridge;
        if (usePlatformBridge) {
          const prepared = started as Awaited<ReturnType<typeof prepareRendererShow>>;
          const bridge = await startExternalRendererConnection({
            storyId: prepared.storyId,
            roomId: prepared.room.id,
            storyMessageChannelId: prepared.storyMessageChannelId,
            storyConfig: prepared.storyConfig,
            storyStatusBaseUrl: settings.narrativeEngineUrl.trim().replace(/\/$/, ''),
            storyStatusToken: settings.sessionToken,
          });
          platformRunIdRef.current = bridge.runId;
          setPlatformRunId(bridge.runId);
          setPlayoutStatus(bridge.hlsUrl ? {
            sessionId: `external:${bridge.runId}`,
            hlsUrl: bridge.hlsUrl,
            state: 'buffering',
            normalizedClips: 0,
            pendingClips: 0,
            currentPosition: null,
            playedThroughPosition: -1,
            outputSeconds: 0,
            error: null,
          } : null);
        }
      } else {
        joinedRoom = await joinAndReadRoom(settings);
        startedShowSettingsRef.current = null;
      }
      connectedRoomSettingsRef.current = connectedSettings;
      const channel = pickActiveMessageChannel(joinedRoom);
      roomRef.current = joinedRoom;
      setRoom(joinedRoom);
      setImportedShow(null);
      setImportedEpisodeId('');
      setImportedSource(null);
      setMessages([]);
      setBeats(new Map());
      setLastBeatId(null);
      setClips([]);
      clipByBeatRef.current.clear();
      liveTimelineRef.current = [];
      playbackCursorRef.current = 0;
      selectClip(null);
      dssPlannerRef.current = createDssShotPlannerState();

      dssRef.current = usePlatformBridge ? null : openDssEvents(
        connectedSettings,
        (dssEvent) => {
          try {
            const eventKey = dssEventKey(dssEvent);
            const nextShots = buildStoryShots(dssEvent, durationRef.current, dssPlannerRef.current);
            externalPlaybackTrackerRef.current.register(
              dssEvent.sequence,
              nextShots.map((shot) => shot.storyBlockId),
            );
            setBeats((current) => {
              const next = new Map(current);
              for (const [id, beat] of next) {
                if (beat.sourceEventKey === eventKey) next.delete(id);
              }
              for (const shot of nextShots) next.set(shot.storyBlockId, shot);
              return next;
            });
            const knownIds = new Set(liveTimelineRef.current.map((beat) => beat.storyBlockId));
            const unseenShots = nextShots.filter((shot) => !knownIds.has(shot.storyBlockId));
            liveTimelineRef.current.push(...unseenShots);
            if (settingsRef.current.autoRender && falConfiguredRef.current) {
              pipelineRef.current?.enqueue(unseenShots);
            }
            const latestShot = nextShots[0];
            if (latestShot) setLastBeatId(latestShot.storyBlockId);
            queueExternalPlaybackReport();
          } catch (planningError) {
            setDssState('error');
            setError(planningError instanceof Error ? `DSS shot planning failed: ${planningError.message}` : 'DSS shot planning failed.');
          }
        },
        (state) => setDssState(state),
      );
      if (usePlatformBridge) setDssState('connected');

      if (channel) {
        chatRef.current = openChat(
          connectedSettings,
          channel.id,
          (incoming) => setMessages((current) => mergeMessages(current, incoming)),
          (state) => setChatState(state),
        );
      } else {
        setChatState('error');
      }
      setConnectionState('connected');
      setShowSettings(false);
      queueExternalPlaybackReport();
    } catch (connectError) {
      if (platformRunIdRef.current) {
        void stopExternalRendererConnection(platformRunIdRef.current).catch(() => undefined);
        platformRunIdRef.current = null;
        setPlatformRunId(null);
      }
      const playoutSessionId = playoutSessionIdRef.current;
      playoutSessionIdRef.current = null;
      if (playoutSessionId) void stopPlayout(playoutSessionId).catch(() => undefined);
      setPlayoutStatus(null);
      setConnectionState('error');
      setError(connectError instanceof Error ? connectError.message : 'Could not connect');
    }
  };

  const startWithSound = () => {
    // Do not await: both unlock calls must begin inside this click before room
    // creation crosses its first asynchronous boundary.
    void unlockMediaPlayback();
    setSoundEnabled(true);
    applyMasterAudio(true, masterVolume);
    setShowStartGate(false);
    void connect();
  };

  const submitChat = (event: FormEvent) => {
    event.preventDefault();
    const content = chatDraft.trim();
    if (!content) return;
    if (!chatRef.current?.sendMessage(content)) {
      setError('Chat is not connected yet.');
      return;
    }
    setChatDraft('');
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark"><span /></div>
          <div>
            <strong>MiniMax Renderer</strong>
            <small>{videoProvider === 'minimax-direct' ? 'Direct MiniMax API' : videoProvider === 'fal' ? 'fal Turbo API' : 'Narrative Engine renderer lab'}</small>
          </div>
        </div>
        <div className="transport-strip" aria-label="Connection status">
          <span><StatusDot state={connectionState} />Engine</span>
          <span><StatusDot state={dssState} />Story</span>
          <span><StatusDot state={chatState} />Chat</span>
          <span><StatusDot state={falConfigured ? 'connected' : falConfigured === false ? 'error' : 'idle'} />{videoProvider === 'minimax-direct' ? 'MiniMax direct' : 'fal video'}</span>
        </div>
        <div className="topbar-actions">
          {connectionState === 'connected' && (
            <button className="stop-show-button" type="button" disabled={stoppingShow} onClick={() => void stopShow()}>
              {stoppingShow ? 'Stopping…' : 'Stop Show'}
            </button>
          )}
          <button className="ghost-button" onClick={() => setShowSettings((value) => !value)}>
            {showSettings ? 'Close setup' : 'Setup'}
          </button>
        </div>
      </header>

      {showSettings && (
        <section className="setup-panel">
          <div className="setup-copy">
            <span className="eyebrow">External service test</span>
            <h1>Start a real live show.</h1>
            <p>
              Create and join a private room, start a draft or published EVD, then turn its DSS commands into an
              ordered {configuredModelLabel} reel. You can also attach to a room that is already running.
            </p>
          </div>
          <form className="setup-form" onSubmit={requestConnection}>
            <div className="setup-mode" role="group" aria-label="Show setup mode">
              <button
                type="button"
                className={settings.setupMode === 'create' ? 'active' : ''}
                onClick={() => setSettings({ ...settings, setupMode: 'create' })}
              >
                Create & start show
              </button>
              <button
                type="button"
                className={settings.setupMode === 'join' ? 'active' : ''}
                onClick={() => setSettings({ ...settings, setupMode: 'join' })}
              >
                Join existing room
              </button>
            </div>
            <label>
              <span>Narrative Engine API</span>
              <input value={settings.narrativeEngineUrl} onChange={(event) => setSettings({ ...settings, narrativeEngineUrl: event.target.value })} />
            </label>
            <label>
              <span>Narrative Authoring API</span>
              <input value={settings.narrativeAuthoringUrl} onChange={(event) => setSettings({ ...settings, narrativeAuthoringUrl: event.target.value })} />
            </label>
            <label>
              <span>Realtime gateway</span>
              <input value={settings.realtimeGatewayUrl} onChange={(event) => setSettings({ ...settings, realtimeGatewayUrl: event.target.value })} />
            </label>
            <label>
              <span>Chat service</span>
              <input value={settings.chatBackendUrl} onChange={(event) => setSettings({ ...settings, chatBackendUrl: event.target.value })} />
            </label>
            <div className="field-row">
              {settings.setupMode === 'create' ? (
                <label>
                  <span>Room name</span>
                  <input value={settings.roomName} onChange={(event) => setSettings({ ...settings, roomName: event.target.value })} />
                </label>
              ) : (
                <label>
                  <span>Existing room code</span>
                  <input placeholder="e.g. cobalt-fox" value={settings.roomShortlink} onChange={(event) => setSettings({ ...settings, roomShortlink: event.target.value })} />
                </label>
              )}
              <label>
                <span>Room session token</span>
                <input type="password" placeholder="Stored for this tab only" value={settings.sessionToken} onChange={(event) => setSettings({ ...settings, sessionToken: event.target.value })} />
              </label>
            </div>
            {settings.setupMode === 'create' && (
              <div className="field-row show-source-row">
                <label>
                  <span>Show type</span>
                  <select
                    value={settings.storyType}
                    onChange={(event) => {
                      setAvailableEvds([]);
                      setSettings({ ...settings, storyType: event.target.value as 'WHISPERS' | 'CREATOR', evdId: '' });
                    }}
                  >
                    <option value="WHISPERS">Whispers</option>
                    <option value="CREATOR">Creator</option>
                  </select>
                </label>
                <label>
                  <span>Narrative Engine EVD</span>
                  <div className="evd-picker-control">
                    {availableEvds.length > 0 ? (
                      <select value={settings.evdId} onChange={(event) => setSettings({ ...settings, evdId: event.target.value })}>
                        {availableEvds.map((evd) => (
                          <option key={evd.id} value={evd.id}>
                            {evd.cvd_name} · Episode {evd.episode_number}: {evd.name} · {evd.is_published ? 'Published' : 'Draft'}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input placeholder="Load shows or paste a UUID" value={settings.evdId} onChange={(event) => setSettings({ ...settings, evdId: event.target.value })} />
                    )}
                    <button className="ghost-button" type="button" disabled={loadingAvailableEvds} onClick={() => void loadAvailableShows()}>
                      {loadingAvailableEvds ? 'Loading…' : availableEvds.length > 0 ? 'Reload' : 'Load my shows'}
                    </button>
                  </div>
                </label>
              </div>
            )}
            <div className="show-import">
              <label className="file-picker">
                <span>CVD / EVD JSON <em>Optional</em></span>
                <input type="file" accept=".json,application/json" onChange={(event) => void importShow(event)} />
                <small>Choose an export for local shot planning and server-EVD matching. The file itself is not uploaded.</small>
              </label>
              {importedShow && (
                <label className="episode-picker">
                  <span>Imported episode</span>
                  <select
                    value={importedEpisodeId}
                    onChange={(event) => {
                      const episode = importedShow.episodes.find((item) => item.id === event.target.value);
                      if (episode) loadImportedEpisode(episode);
                    }}
                  >
                    {importedShow.episodes.map((episode) => (
                      <option key={episode.id} value={episode.id}>
                        {episode.episodeNumber}. {episode.name} · {episode.beats.length} shots
                      </option>
                    ))}
                  </select>
                  <small>
                    {importedShow.name} · {selectedImportedEpisode?.serviceEvdId
                      ? 'service EVD UUID copied into the live-show setup'
                      : importedServerMatch
                        ? `matched to ${importedServerMatch.cvd_name} episode ${importedServerMatch.episode_number} (${importedServerMatch.is_published ? 'published' : 'draft'})`
                        : 'this export has no service UUID; use Load my shows above to match it'}
                  </small>
                </label>
              )}
            </div>
            <div className="reference-settings">
              <div className="reference-header">
                <label className="toggle-label reference-toggle">
                  <input
                    type="checkbox"
                    checked={settings.useCharacterReferences}
                    onChange={(event) => setSettings({ ...settings, useCharacterReferences: event.target.checked })}
                  />
                  <span>
                    <b>Character reference lock</b>
                    <small>Optional · enable to trade generation speed for stronger character and voice consistency.</small>
                  </span>
                </label>
                <div className="reference-actions">
                  <button className="ghost-button" type="button" onClick={() => setSettings({ ...settings, characterReferences: createDefaultCharacterReferences() })}>
                    Reset defaults
                  </button>
                  <button className="ghost-button" type="button" onClick={addCharacterReference}>
                    Add character
                  </button>
                </div>
              </div>
              {settings.useCharacterReferences && (
                <div className="reference-editor" aria-label="Editable character media references">
                  {settings.characterReferences.length === 0 && (
                    <p className="reference-empty">No character references configured. Add characters and media you have permission to use.</p>
                  )}
                  {settings.characterReferences.map((reference, index) => (
                    <article className="reference-row" key={index}>
                      <div className="reference-portrait">
                        {reference.imageUrl ? <img src={reference.imageUrl} alt="" /> : <span>No image</span>}
                      </div>
                      <label>
                        <span>Character</span>
                        <input
                          aria-label={`Character ${index + 1} name`}
                          placeholder="Character name"
                          value={reference.characterName}
                          onChange={(event) => updateCharacterReference(index, 'characterName', event.target.value)}
                        />
                      </label>
                      <label>
                        <span>Image reference</span>
                        <input
                          aria-label={`${reference.characterName || `Character ${index + 1}`} image reference`}
                          placeholder="https://…"
                          value={reference.imageUrl}
                          onChange={(event) => updateCharacterReference(index, 'imageUrl', event.target.value)}
                        />
                      </label>
                      <label>
                        <span>Audio reference</span>
                        <input
                          aria-label={`${reference.characterName || `Character ${index + 1}`} audio reference`}
                          placeholder="https://…/voice-sample.mp3"
                          value={reference.audioUrl}
                          onChange={(event) => updateCharacterReference(index, 'audioUrl', event.target.value)}
                        />
                      </label>
                      <div className="reference-audio-preview">
                        {reference.audioUrl.startsWith('https://')
                          ? <audio controls preload="none" src={reference.audioUrl} aria-label={`${reference.characterName || `Character ${index + 1}`} voice sample`} />
                          : <span>No audio</span>}
                      </div>
                      <button
                        className="reference-remove"
                        type="button"
                        aria-label={`Remove ${reference.characterName || `character ${index + 1}`}`}
                        onClick={() => removeCharacterReference(index)}
                      >
                        ×
                      </button>
                    </article>
                  ))}
                  <small className="reference-help">
                    Images and audio samples must use public HTTPS URLs. H3 Max receives only the characters matched to each shot.
                  </small>
                </div>
              )}
            </div>
            <div className="generation-row">
              <label>
                <span>Resolution</span>
                <select value={settings.resolution} onChange={(event) => setSettings({ ...settings, resolution: event.target.value as '480P' | '768P' })}>
                  <option value="768P">768P{videoProvider === 'fal' ? ' · fal Turbo from $0.04/sec' : ''}</option>
                  <option value="480P">480P{videoProvider === 'fal' ? ' · fal Turbo from $0.025/sec' : ''}</option>
                </select>
              </label>
              <label>
                <span>Minimum clip length</span>
                <select
                  value={settings.duration}
                  onChange={(event) => {
                    const duration = Number(event.target.value);
                    setSettings({ ...settings, duration });
                    if (importedSource) applyImportedSource(importedSource, duration, importedEpisodeId);
                  }}
                >
                  {[5, 6, 8, 10, 12, 15].map((duration) => (
                    <option key={duration} value={duration}>
                      {duration} seconds
                    </option>
                  ))}
                </select>
              </label>
              <label className="toggle-label">
                <input type="checkbox" checked={settings.autoRender} onChange={(event) => setSettings({ ...settings, autoRender: event.target.checked })} />
                <span><b>Continuous auto-render</b><small>One DSS line per shot · expands through 15s{videoProvider === 'fal' ? ` · from ~${baselineSpendPerClip}/clip` : ''}</small></span>
              </label>
            </div>
            <div className="setup-actions">
              <button className="primary-button" type="submit" disabled={connectionState === 'connecting'}>
                {connectionState === 'connecting'
                  ? settings.setupMode === 'create' ? 'Starting show…' : 'Connecting…'
                  : settings.setupMode === 'create' ? 'Create room & start show' : 'Join room'}
              </button>
              <span className="credential-note">Video API keys stay on this app’s server.</span>
            </div>
          </form>
        </section>
      )}

      {showStartGate && (
        <div className="show-start-gate" role="presentation">
          <section className="show-start-dialog" role="dialog" aria-modal="true" aria-labelledby="show-start-title">
            <span className="eyebrow">Sound check</span>
            <h2 id="show-start-title">Enter the show with sound?</h2>
            <p>
              Generation has not started yet. Choose the intended volume now. When the real live stream is ready,
              your browser may require one final Play click to enable its sound.
            </p>
            <label className="start-volume-control">
              <span>Master volume</span>
              <input
                aria-label="Starting master volume"
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={masterVolume}
                onChange={(event) => changeMasterVolume(Number(event.target.value))}
              />
              <output>{Math.round(masterVolume * 100)}%</output>
            </label>
            <div className="show-start-actions">
              <button className="ghost-button" type="button" onClick={() => setShowStartGate(false)}>Back to setup</button>
              <button className="primary-button" type="button" autoFocus onClick={startWithSound}>
                {settings.setupMode === 'create' ? 'Enter & start show' : 'Enter & join show'}
              </button>
            </div>
          </section>
        </div>
      )}

      {error && <div className="error-banner" role="alert"><span>!</span>{error}<button onClick={() => setError(null)}>Dismiss</button></div>}

      <main className="workspace">
        <section className="stage-column">
          <div className="stage">
            {playoutStatus && (
              <video
                ref={streamVideoRef}
                className="stream-video active"
                data-playout-session={playoutStatus.sessionId}
                autoPlay
                muted={!soundEnabled}
                controls
                playsInline
                preload="auto"
                onCanPlay={() => {
                  const video = streamVideoRef.current;
                  if (video) {
                    setStreamPlayable(true);
                  }
                  if (video && !playbackActivated) {
                    void playMediaMuted(video, masterVolume).catch(() => setStreamPlayable(false));
                  }
                }}
                onEmptied={() => setStreamPlayable(false)}
                onVolumeChange={handleStreamVolumeChange}
              />
            )}
            {needsPlaybackStart && (
              <div className="empty-stage">
                <div className="scanline" />
                {playoutStatus?.state === 'streaming' && streamPlayable ? (
                  <>
                    <span className="eyebrow">Stream ready</span>
                    <h2>Start live playback.</h2>
                    <p>Your browser requires one final gesture on the real stream before it can play with sound.</p>
                    <button className="primary-button stream-start-button" type="button" onClick={startStreamPlayback}>
                      Play live stream
                    </button>
                  </>
                ) : (
                  <>
                    <span className="eyebrow">{platformOutcome ? 'Renderer finished' : 'Awaiting picture'}</span>
                    <h2>{platformOutcome === 'ended' ? 'The story has ended.' : platformOutcome === 'stopped' ? 'The renderer has stopped.' : platformOutcome === 'failed' ? 'The renderer failed.' : importedShow ? `${importedShow.name} is ready.` : connectionState === 'connected' ? 'The story feed is live.' : 'Start a Narrative Engine show.'}</h2>
                    <p>{platformOutcome ? 'Start a new show when you are ready.' : playoutStatus?.state === 'buffering'
                      ? `Building the ${playoutStatus.normalizedClips > 0 ? 'opening stream buffer' : 'first scenes'}…`
                      : playoutStatus?.state === 'starting'
                        ? 'Starting the continuous live stream…'
                        : playoutStatus?.state === 'streaming'
                          ? 'Reconnecting to the continuous live stream…'
                        : pipelineState.activeIds.length > 0
                          ? `Rendering ${pipelineState.activeIds.length} scenes ahead…`
                          : latestBeat ? 'A narrative beat is ready to render.' : `Incoming DSS commands become cinematic ${configuredModelLabel} prompts here.`}</p>
                  </>
                )}
              </div>
            )}
            <div className="stage-overlay">
              <span className="live-pill"><i />{connectionState === 'connected' ? 'LIVE ENGINE' : 'RENDER LAB'}</span>
              <div className="stage-controls">
                {(room || importedShow) && <span>{room?.name ?? importedShow?.name ?? settings.roomShortlink}</span>}
                {playoutStatus && (
                  <div className="master-audio-control" aria-label="Master video sound">
                    <button type="button" onClick={toggleMasterSound}>
                      {soundEnabled ? 'Mute' : 'Enable sound'}
                    </button>
                    <input
                      aria-label="Master volume"
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={masterVolume}
                      onChange={(event) => changeMasterVolume(Number(event.target.value))}
                    />
                    <output>{Math.round(masterVolume * 100)}%</output>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="director-card">
            <div className="director-header">
              <div>
                <span className="eyebrow">Director prompt</span>
                <h3>{latestBeat?.title ?? (latestBeat ? `Scene ${latestBeat.sceneIndex + 1} · Beat ${latestBeat.blockIndex + 1}` : 'Sample establishing beat')}</h3>
                <small className="reference-status">
                  {selectedBeatReferences.length > 0
                    ? `${configuredModelLabel} reference-to-video · ${selectedBeatReferences.map((reference) => `${reference.characterName} (${[reference.assetKey || reference.imageUrl ? 'image' : '', reference.audioUrl ? 'audio' : ''].filter(Boolean).join(' + ')})`).join(' · ')}`
                    : `${configuredModelLabel} text-to-video · no matched character reference`}
                </small>
              </div>
              <button
                className="render-button"
                disabled={
                  Boolean(generatingBeatId) ||
                  Boolean(platformRunId) ||
                  connectionState === 'connecting' ||
                  pipelineState.activeIds.includes(latestBeat?.storyBlockId ?? '') ||
                  pipelineState.queuedIds.includes(latestBeat?.storyBlockId ?? '')
                }
                onClick={() => void generate(latestBeat ?? SAMPLE_BEAT)}
              >
                {generatingBeatId ? <><span className="spinner" />Generating…</> : <>Render {selectedBeatDuration}s beat{videoProvider === 'fal' && <span>~${selectedBeatSpend}</span>}</>}
              </button>
            </div>
            <p className="prompt-copy">{latestBeat?.prompt ?? SAMPLE_BEAT.prompt}</p>
          </div>

          <div className="clip-rail">
            <div className="section-heading"><span>Generated reel</span><small>{clips.length} ready · {pipelineState.activeIds.length} rendering · {pipelineState.queuedIds.length} queued</small></div>
            <div className="clip-list">
              {clips.length === 0 && <div className="empty-rail">Generated MiniMax clips will collect here.</div>}
              {clips.map((clip, index) => (
                <button
                  key={clip.id}
                  className={`clip-card ${currentClip?.id === clip.id ? 'active' : ''}`}
                  onClick={() => {
                    const timelineIndex = liveTimelineRef.current.findIndex((beat) => beat.storyBlockId === clip.storyBlockId);
                    if (timelineIndex >= 0) playbackCursorRef.current = timelineIndex;
                    selectClip(clip.id);
                  }}
                >
                  <video src={clip.videoUrl} muted preload="metadata" />
                  <span>
                    <b>Shot {index + 1} · {clip.durationSeconds}s</b>
                    <small>{clip.totalSeconds.toFixed(1)}s generation · {clip.generationMode === 'reference' ? `${clip.referenceCharacters.length} character ref` : 'text'}</small>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </section>

        <aside className="side-column">
          <section className="chat-card">
            <div className="section-heading">
              <div><span>Audience room</span><small>{chatState === 'connected' ? 'Chat connected' : 'Waiting for chat'}</small></div>
              <StatusDot state={chatState} />
            </div>
            <div className="message-list" aria-live="polite">
              {messages.length === 0 && <div className="chat-empty"><span>◌</span><p>Audience messages will appear here and flow back into the live Narrative Engine story.</p></div>}
              {messages.map((message) => (
                <article className="message" key={message.id}>
                  <div className="avatar">{messageAuthor(message).slice(0, 1).toUpperCase()}</div>
                  <div><b>{messageAuthor(message)}</b><p>{message.content}</p></div>
                </article>
              ))}
            </div>
            <form className="chat-composer" onSubmit={submitChat}>
              <input value={chatDraft} maxLength={2000} onChange={(event) => setChatDraft(event.target.value)} placeholder="Influence the story…" aria-label="Chat message" />
              <button aria-label="Send message" disabled={chatState !== 'connected' || !chatDraft.trim()}>↑</button>
            </form>
          </section>

          <section className="story-feed">
            <div className="section-heading"><span>Narrative feed</span><small>{orderedBeats.length} shots</small></div>
            <div className="beat-list">
              {orderedBeats.length === 0 && <div className="feed-empty">Import a CVD/EVD or listen for DSS story commands…</div>}
              {orderedBeats.map((beat) => {
                const clip = clips.find((item) => item.storyBlockId === beat.storyBlockId);
                const isRendering = pipelineState.activeIds.includes(beat.storyBlockId);
                const isQueued = pipelineState.queuedIds.includes(beat.storyBlockId);
                const failed = pipelineState.failedIds.includes(beat.storyBlockId);
                return (
                  <button key={beat.storyBlockId} className={`beat-row ${lastBeatId === beat.storyBlockId ? 'selected' : ''}`} onClick={() => setLastBeatId(beat.storyBlockId)}>
                    <span className={clip ? 'beat-index rendered' : 'beat-index'}>{clip ? '✓' : beat.blockIndex + 1}</span>
                    <span><b>{beat.title ?? `Scene ${beat.sceneIndex + 1} · Beat ${beat.blockIndex + 1}`}</b><small>{clip ? `${clip.durationSeconds}s clip ready` : isRendering ? `Rendering ${plannedDuration(beat, settings.duration)}s with ${configuredModelLabel}…` : isQueued ? `${plannedDuration(beat, settings.duration)}s queued` : failed ? 'Render failed' : beat.source === 'imported' ? `Scene ${beat.sceneIndex + 1} · Beat ${beat.blockIndex + 1}` : `${plannedDuration(beat, settings.duration)}s · ready to render`}</small></span>
                    <span>{lastBeatId === beat.storyBlockId ? '●' : '→'}</span>
                  </button>
                );
              })}
            </div>
          </section>
        </aside>
      </main>
    </div>
  );
}
