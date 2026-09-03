import type { AvailableEvd, ImportedEpisode, ImportedShow, StoryBeat } from './types';
import { isUuid } from './uuid';

const STYLE_PREFIX =
  'Cinematic live-action story scene, expressive natural performances, moody practical lighting, shallow depth of field, coherent characters, subtle ambient sound, no titles or captions.';

type JsonRecord = Record<string, unknown>;

interface ParseExportOptions {
  durationSeconds?: number;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function descriptionText(value: unknown): string | null {
  const raw = nonEmptyString(value) ?? (isRecord(value) ? nonEmptyString(value.template) : null);
  if (!raw) return null;
  const withoutUnresolvedVariables = raw.replace(/\{\{[^}]+\}\}/g, ' ');
  return nonEmptyString(withoutUnresolvedVariables.replace(/\s+/g, ' '));
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function episodeRows(value: JsonRecord): JsonRecord[] {
  if (Array.isArray(value.evds)) return value.evds.filter(isRecord);
  if (Array.isArray(value.episodes)) return value.episodes.filter(isRecord);
  return [value];
}

function episodeDocument(row: JsonRecord): JsonRecord | null {
  if (isRecord(row.document) && Array.isArray(row.document.scenes)) return row.document;
  if (Array.isArray(row.scenes)) return row;
  return null;
}

function showName(value: JsonRecord, fallbackName: string): string {
  if (isRecord(value.cvd)) return nonEmptyString(value.cvd.name) ?? fallbackName;
  return nonEmptyString(value.show_name) ?? fallbackName;
}

function showStoryType(value: JsonRecord): 'WHISPERS' | 'CREATOR' | null {
  const candidate = isRecord(value.cvd) ? value.cvd.story_type : value.story_type;
  return candidate === 'WHISPERS' || candidate === 'CREATOR' ? candidate : null;
}

function castNames(value: JsonRecord): string[] {
  const rows = Array.isArray(value.cast_members) ? value.cast_members.filter(isRecord) : [];
  return rows.map((row) => nonEmptyString(row.name)).filter((name): name is string => Boolean(name));
}

function mentionedCastNames(value: string, names: string[]): string[] {
  const normalized = value.toLocaleLowerCase();
  return names.filter((name) => normalized.includes(name.toLocaleLowerCase()));
}

function wordCount(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

function balancedWordGroups(value: string, maxWords: number): string[] {
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return [value.trim()];
  const groupCount = Math.ceil(words.length / maxWords);
  const groupSize = Math.ceil(words.length / groupCount);
  const groups: string[] = [];
  for (let index = 0; index < words.length; index += groupSize) {
    groups.push(words.slice(index, index + groupSize).join(' '));
  }
  return groups;
}

function semanticUnits(sentence: string, maxWords: number): string[] {
  if (wordCount(sentence) <= maxWords) return [sentence.trim()];
  const marked = sentence
    .replace(/([,;:—–])\s+/g, '$1|')
    .replace(/\s+(and then|then|but|while|before|after)\s+/gi, '|$1 ');
  return marked
    .split('|')
    .map((part) => part.trim())
    .filter(Boolean)
    .flatMap((part) => balancedWordGroups(part, maxWords));
}

export function splitBeatDescription(description: string, durationSeconds = 5): string[] {
  const normalized = description.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  const maxWords = Math.max(8, Math.floor(durationSeconds * 1.8));
  const sentences = normalized.match(/[^.!?]+(?:[.!?]+|$)/g)?.map((part) => part.trim()) ?? [normalized];
  const units = sentences.flatMap((sentence) => semanticUnits(sentence, maxWords));
  const chunks: string[] = [];
  let current = '';

  for (const unit of units) {
    const combined = current ? `${current} ${unit}` : unit;
    if (current && wordCount(combined) > maxWords) {
      chunks.push(current);
      current = unit;
    } else {
      current = combined;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function normalizedName(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

export function matchImportedEpisode(
  available: AvailableEvd[],
  show: ImportedShow,
  episode: ImportedEpisode,
): AvailableEvd | null {
  const episodeNumberMatches = available.filter((evd) => evd.episode_number === episode.episodeNumber);
  const showMatches = episodeNumberMatches.filter((evd) => normalizedName(evd.cvd_name) === normalizedName(show.name));
  const candidates = showMatches.length > 0
    ? showMatches
    : episodeNumberMatches.filter((evd) => normalizedName(evd.name) === normalizedName(episode.name));
  return candidates.find((evd) => evd.is_active) ?? candidates[0] ?? null;
}

function buildEpisode(
  row: JsonRecord,
  show: string,
  rowIndex: number,
  totalRows: number,
  durationSeconds: number,
  knownCastNames: string[],
): ImportedEpisode | null {
  const document = episodeDocument(row);
  if (!document) return null;

  const episodeNumber = positiveNumber(row.episode_number, rowIndex + 1);
  const name = nonEmptyString(row.name) ?? (totalRows === 1 ? show : `Episode ${episodeNumber}`);
  const beats: StoryBeat[] = [];
  const scenes = (document.scenes as unknown[]).filter(isRecord);

  scenes.forEach((scene, sceneIndex) => {
    const sceneTitle = nonEmptyString(scene.title) ?? `Scene ${sceneIndex + 1}`;
    const explanation = nonEmptyString(scene.explanation);
    const variants = Array.isArray(scene.variants) ? scene.variants.filter(isRecord) : [];

    variants.forEach((variant, variantIndex) => {
      const variantLabel = nonEmptyString(variant.label);
      const setName = nonEmptyString(variant.set_name);
      const storyBlocks = Array.isArray(variant.story_blocks)
        ? variant.story_blocks.filter(isRecord)
        : [];

      storyBlocks.forEach((block, blockIndex) => {
        const description = descriptionText(block.description);
        if (!description) return;
        const chunks = splitBeatDescription(description, durationSeconds);
        chunks.forEach((chunk, chunkIndex) => {
          const promptParts = [
            STYLE_PREFIX,
            `Show: ${show}. Episode: ${name}.`,
            `Scene: ${sceneTitle}.`,
          ];
          if (explanation) promptParts.push(`Scene context: ${explanation}.`);
          if (setName) promptParts.push(`Location and production set: ${setName}.`);
          if (variantLabel && variantLabel.toLowerCase() !== 'default') {
            promptParts.push(`Story variation: ${variantLabel}.`);
          }
          promptParts.push(`The only dramatic moment in this shot is: ${chunk}`);

          const titleParts = [sceneTitle];
          if (variantLabel && variantLabel.toLowerCase() !== 'default') titleParts.push(variantLabel);
          if (chunks.length > 1) titleParts.push(`Shot ${chunkIndex + 1}/${chunks.length}`);
          beats.push({
            storyBlockId: `imported-${rowIndex}-${sceneIndex}-${variantIndex}-${blockIndex}-${chunkIndex}`,
            sceneIndex,
            blockIndex,
            prompt: promptParts.join(' '),
            sequence: 0,
            title: titleParts.join(' · '),
            source: 'imported',
            chunkIndex,
            chunkCount: chunks.length,
            characterNames: mentionedCastNames(chunk, knownCastNames),
          });
        });
      });
    });
  });

  beats.forEach((beat, index) => {
    beat.sequence = beats.length - index;
  });

  if (beats.length === 0) return null;
  const candidateIds = [row.id, row.evd_id];
  const serviceEvdId = candidateIds.find(isUuid)?.trim() ?? null;
  return {
    id: serviceEvdId ?? `episode-${rowIndex}`,
    serviceEvdId,
    name,
    episodeNumber,
    beats,
  };
}

export function parseCvdOrEvdExport(
  value: unknown,
  fallbackName = 'Imported show',
  options: ParseExportOptions = {},
): ImportedShow {
  if (!isRecord(value)) throw new Error('This file is not a CVD or EVD JSON object.');
  const name = showName(value, fallbackName.replace(/\.json$/i, '') || 'Imported show');
  const storyType = showStoryType(value);
  const durationSeconds = options.durationSeconds ?? 5;
  const knownCastNames = castNames(value);
  const rows = episodeRows(value);
  const episodes = rows
    .map((row, index) => buildEpisode(row, name, index, rows.length, durationSeconds, knownCastNames))
    .filter((episode): episode is ImportedEpisode => episode !== null)
    .sort((left, right) => left.episodeNumber - right.episodeNumber);

  if (episodes.length === 0) {
    throw new Error('No renderable EVD story blocks were found. Export a full CVD bundle or an EVD containing scenes, variants, and story blocks.');
  }
  return { name, storyType, episodes };
}
