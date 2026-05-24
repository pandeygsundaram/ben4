import { TikTokPage } from "@remotion/captions";
import React from "react";
import { AbsoluteFill, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { StyleConfig } from "../schema";
import { Page } from "./Page";

const SPRING_DAMPING: Record<StyleConfig["animationSpeed"], number> = {
  fast: 200,
  medium: 120,
  slow: 80,
};

const SPRING_DURATION: Record<StyleConfig["animationSpeed"], number> = {
  fast: 5,
  medium: 10,
  slow: 18,
};

const SubtitlePage: React.FC<{
  readonly page: TikTokPage;
  readonly style?: StyleConfig;
}> = ({ page, style }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const speed = style?.animationSpeed ?? "fast";

  const enter = spring({
    frame,
    fps,
    config: { damping: SPRING_DAMPING[speed] },
    durationInFrames: SPRING_DURATION[speed],
  });

  return (
    <AbsoluteFill>
      <Page enterProgress={enter} page={page} style={style} />
    </AbsoluteFill>
  );
};

export default SubtitlePage;
