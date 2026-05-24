import React from "react";
import { AbsoluteFill } from "remotion";
import { StyleConfig } from "../schema";
import { useCardAnimation, fontFamily, cardContainer } from "./CardBase";

// Opening card — grabs attention in the first 2-3 seconds
export const HookCard: React.FC<{
  text: string;
  style: StyleConfig;
}> = ({ text, style }) => {
  const { opacity, translateY } = useCardAnimation(style.animationSpeed);
  const font = fontFamily(style.fontPreset);
  const isUpperCase = style.fontPreset === "bold" || style.fontPreset === "condensed";

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        paddingLeft: 60,
        paddingRight: 60,
      }}
    >
      <div style={cardContainer(opacity, translateY)}>
        <p
          style={{
            fontFamily: font,
            fontSize: style.fontPreset === "bold" ? 72 : 56,
            fontWeight: 800,
            color: "#FFFFFF",
            margin: 0,
            textAlign: "center",
            lineHeight: 1.15,
            letterSpacing: style.fontPreset === "condensed" ? "-0.02em" : "normal",
            textTransform: isUpperCase ? "uppercase" : "none",
            // Accent on the last word
          }}
        >
          {splitAccent(text, style.highlightColor, font, isUpperCase)}
        </p>
      </div>
    </AbsoluteFill>
  );
};

// Highlight the last word in the hook with the accent color
function splitAccent(
  text: string,
  highlightColor: string,
  font: string,
  uppercase: boolean
): React.ReactNode {
  const words = text.trim().split(" ");
  if (words.length <= 1) {
    return <span style={{ color: highlightColor }}>{uppercase ? text.toUpperCase() : text}</span>;
  }
  const body = words.slice(0, -1).join(" ");
  const last = words[words.length - 1];
  return (
    <>
      {uppercase ? body.toUpperCase() : body}{" "}
      <span style={{ color: highlightColor }}>
        {uppercase ? last.toUpperCase() : last}
      </span>
    </>
  );
}
