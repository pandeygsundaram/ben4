import { Caption, createTikTokStyleCaptions } from "@remotion/captions";
import { getVideoMetadata } from "@remotion/media-utils";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AbsoluteFill,
  Audio,
  CalculateMetadataFunction,
  cancelRender,
  getStaticFiles,
  OffthreadVideo,
  Sequence,
  useDelayRender,
  useVideoConfig,
  watchStaticFile,
} from "remotion";
import { loadFont } from "../load-font";
import { NoCaptionFile } from "./NoCaptionFile";
import SubtitlePage from "./SubtitlePage";
import { CaptionedVideoProps } from "../schema";
import { HookCard } from "../cards/HookCard";
import { QuoteCard } from "../cards/QuoteCard";
import { StatCard } from "../cards/StatCard";
import { CTACard } from "../cards/CTACard";
import { ChapterCard } from "../cards/ChapterCard";

export { captionedVideoSchema } from "../schema";
export type { CaptionedVideoProps as SubtitleProp };

const SWITCH_CAPTIONS_EVERY_MS = 1200;

export const calculateCaptionedVideoMetadata: CalculateMetadataFunction<
  CaptionedVideoProps
> = async ({ props }) => {
  const fps = 30;
  const metadata = await getVideoMetadata(props.src);
  return {
    fps,
    durationInFrames: Math.floor(metadata.durationInSeconds * fps),
  };
};

const getFileExists = (file: string) => {
  const files = getStaticFiles();
  return Boolean(files.find((f) => f.src === file));
};

export const CaptionedVideo: React.FC<CaptionedVideoProps> = ({
  src,
  style,
  events = [],
  voiceSrc,
  musicSrc,
  musicVolume = 0.18,
}) => {
  const [subtitles, setSubtitles] = useState<Caption[]>([]);
  const { delayRender, continueRender } = useDelayRender();
  const [handle] = useState(() => delayRender());
  const { fps } = useVideoConfig();

  const subtitlesFile = src
    .replace(/.mp4$/, ".json")
    .replace(/.mkv$/, ".json")
    .replace(/.mov$/, ".json")
    .replace(/.webm$/, ".json");

  const fetchSubtitles = useCallback(async () => {
    try {
      await loadFont();
      const res = await fetch(subtitlesFile);
      const data = (await res.json()) as Caption[];
      setSubtitles(data);
      continueRender(handle);
    } catch (e) {
      cancelRender(e);
    }
  }, [continueRender, handle, subtitlesFile]);

  useEffect(() => {
    fetchSubtitles();
    const c = watchStaticFile(subtitlesFile, fetchSubtitles);
    return () => c.cancel();
  }, [fetchSubtitles, src, subtitlesFile]);

  const { pages } = useMemo(() => {
    return createTikTokStyleCaptions({
      combineTokensWithinMilliseconds: SWITCH_CAPTIONS_EVERY_MS,
      captions: subtitles ?? [],
    });
  }, [subtitles]);

  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      {/* Video track — muted when Rumic AI voiceover is present */}
      <AbsoluteFill>
        <OffthreadVideo
          style={{ objectFit: "cover" }}
          src={src}
          muted={Boolean(voiceSrc)}
        />
      </AbsoluteFill>

      {/* Rumic AI voiceover — full volume, replaces original audio */}
      {voiceSrc ? <Audio src={voiceSrc} volume={1} /> : null}

      {/* Background music — lower volume, mixed under voice */}
      {musicSrc ? <Audio src={musicSrc} volume={musicVolume} /> : null}

      {/* Caption sequences */}
      {pages.map((page, index) => {
        const nextPage = pages[index + 1] ?? null;
        const subtitleStartFrame = (page.startMs / 1000) * fps;
        const subtitleEndFrame = Math.min(
          nextPage ? (nextPage.startMs / 1000) * fps : Infinity,
          subtitleStartFrame + SWITCH_CAPTIONS_EVERY_MS
        );
        const durationInFrames = subtitleEndFrame - subtitleStartFrame;
        if (durationInFrames <= 0) return null;

        return (
          <Sequence key={index} from={subtitleStartFrame} durationInFrames={durationInFrames}>
            <SubtitlePage page={page} style={style} />
          </Sequence>
        );
      })}

      {/* Timeline events (hook, quote, stat, cta, chapter) */}
      {events.map((event, index) => {
        const fromFrame = Math.round((event.atMs / 1000) * fps);
        const durationInFrames = Math.round((event.durationMs / 1000) * fps);
        if (durationInFrames <= 0) return null;

        const cardStyle = style ?? {
          fontPreset: "bold" as const,
          highlightColor: "#FFE500",
          captionSize: 120,
          animationSpeed: "fast" as const,
          captionPosition: "bottom" as const,
        };

        return (
          <Sequence key={`event-${index}`} from={fromFrame} durationInFrames={durationInFrames}>
            {event.type === "hook" && <HookCard text={event.text} style={cardStyle} />}
            {event.type === "quote" && <QuoteCard text={event.text} style={cardStyle} />}
            {event.type === "stat" && <StatCard text={event.text} style={cardStyle} />}
            {event.type === "cta" && <CTACard text={event.text} style={cardStyle} />}
            {event.type === "chapter" && <ChapterCard text={event.text} style={cardStyle} />}
          </Sequence>
        );
      })}

      {getFileExists(subtitlesFile) ? null : <NoCaptionFile />}
    </AbsoluteFill>
  );
};
