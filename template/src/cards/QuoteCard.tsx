import React from "react";
import { AbsoluteFill } from "remotion";
import { StyleConfig } from "../schema";
import { useCardAnimation, fontFamily, cardContainer } from "./CardBase";

// Pulls a strong line from the transcript and puts it on screen
export const QuoteCard: React.FC<{
  text: string;
  style: StyleConfig;
}> = ({ text, style }) => {
  const { opacity, translateY } = useCardAnimation(style.animationSpeed);
  const font = fontFamily(style.fontPreset);

  return (
    <AbsoluteFill
      style={{
        justifyContent: "flex-end",
        alignItems: "center",
        paddingLeft: 60,
        paddingRight: 60,
        paddingBottom: 420, // above caption area
      }}
    >
      <div
        style={{
          ...cardContainer(opacity, translateY),
          borderLeft: `4px solid ${style.highlightColor}`,
          borderRadius: 0,
          paddingLeft: 32,
        }}
      >
        <p
          style={{
            fontFamily: font,
            fontSize: 46,
            fontWeight: 700,
            color: "#FFFFFF",
            margin: 0,
            lineHeight: 1.3,
            textTransform: style.fontPreset === "bold" ? "uppercase" : "none",
          }}
        >
          {text}
        </p>
      </div>
    </AbsoluteFill>
  );
};
