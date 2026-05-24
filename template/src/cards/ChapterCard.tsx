import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { StyleConfig } from "../schema";
import { fontFamily } from "./CardBase";

// Subtle label that marks a new section — sits at the top, doesn't distract
export const ChapterCard: React.FC<{
  text: string;
  style: StyleConfig;
}> = ({ text, style }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const opacity = interpolate(
    frame,
    [0, fps * 0.3, durationInFrames - fps * 0.3, durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  const font = fontFamily(style.fontPreset);

  return (
    <AbsoluteFill
      style={{
        justifyContent: "flex-start",
        alignItems: "flex-start",
        paddingTop: 100,
        paddingLeft: 60,
      }}
    >
      <div
        style={{
          opacity,
          display: "flex",
          alignItems: "center",
          gap: 16,
        }}
      >
        <div
          style={{
            width: 6,
            height: 36,
            backgroundColor: style.highlightColor,
            borderRadius: 3,
          }}
        />
        <p
          style={{
            fontFamily: font,
            fontSize: 34,
            fontWeight: 700,
            color: "#FFFFFF",
            margin: 0,
            textTransform: "uppercase",
            letterSpacing: "0.1em",
          }}
        >
          {text}
        </p>
      </div>
    </AbsoluteFill>
  );
};
