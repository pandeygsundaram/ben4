import React from "react";
import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { StyleConfig } from "../schema";

// Shared enter/exit animation for all cards
export function useCardAnimation(animationSpeed: StyleConfig["animationSpeed"]) {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const durationMap = { fast: 6, medium: 10, slow: 16 };
  const durationInFrames_ = durationMap[animationSpeed];

  const enter = spring({
    frame,
    fps,
    config: { damping: 180, stiffness: 140 },
    durationInFrames: durationInFrames_,
  });

  // Fade out in the last 8 frames
  const opacity = interpolate(
    frame,
    [durationInFrames - 8, durationInFrames],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  const translateY = interpolate(enter, [0, 1], [24, 0]);

  return { enter, opacity, translateY };
}

// Font family per preset
export function fontFamily(preset: StyleConfig["fontPreset"]): string {
  if (preset === "bold" || preset === "condensed") return "TheBoldFont, sans-serif";
  return "system-ui, -apple-system, Helvetica Neue, sans-serif";
}

// Shared card container style — dark bg, clean edges, no gradients
export const cardContainer = (
  opacity: number,
  translateY: number
): React.CSSProperties => ({
  backgroundColor: "rgba(10, 10, 10, 0.88)",
  borderRadius: 6,
  paddingTop: 28,
  paddingBottom: 28,
  paddingLeft: 40,
  paddingRight: 40,
  opacity,
  transform: `translateY(${translateY}px)`,
});
