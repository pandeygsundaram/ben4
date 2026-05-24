import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { StyleConfig } from "../schema";
import { fontFamily } from "./CardBase";

// End card — call to action. Fades in and stays to the end.
export const CTACard: React.FC<{
  text: string;
  style: StyleConfig;
}> = ({ text, style }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const opacity = interpolate(frame, [0, fps * 0.4], [0, 1], {
    extrapolateRight: "clamp",
  });

  const font = fontFamily(style.fontPreset);

  return (
    <AbsoluteFill
      style={{
        justifyContent: "flex-end",
        alignItems: "center",
        paddingBottom: 160,
      }}
    >
      <div
        style={{
          opacity,
          backgroundColor: style.highlightColor,
          borderRadius: 6,
          paddingTop: 28,
          paddingBottom: 28,
          paddingLeft: 60,
          paddingRight: 60,
        }}
      >
        <p
          style={{
            fontFamily: font,
            fontSize: 52,
            fontWeight: 800,
            color: "#0A0A0A",
            margin: 0,
            textAlign: "center",
            textTransform: style.fontPreset === "bold" ? "uppercase" : "none",
            letterSpacing: "0.02em",
          }}
        >
          {text}
        </p>
      </div>
    </AbsoluteFill>
  );
};
