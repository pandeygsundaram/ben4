import React from "react";
import { AbsoluteFill } from "remotion";
import { StyleConfig } from "../schema";
import { useCardAnimation, fontFamily, cardContainer } from "./CardBase";

// A number or short fact — split on the first space into value + label
// e.g. "48 hours to ship" → big "48" + smaller "hours to ship"
export const StatCard: React.FC<{
  text: string;
  style: StyleConfig;
}> = ({ text, style }) => {
  const { opacity, translateY } = useCardAnimation(style.animationSpeed);
  const font = fontFamily(style.fontPreset);

  const [value, ...rest] = text.trim().split(" ");
  const label = rest.join(" ");

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "flex-start",
        paddingLeft: 80,
        paddingTop: 200,
      }}
    >
      <div style={cardContainer(opacity, translateY)}>
        <p
          style={{
            fontFamily: font,
            fontSize: 110,
            fontWeight: 900,
            color: style.highlightColor,
            margin: 0,
            lineHeight: 1,
            textTransform: "uppercase",
          }}
        >
          {value}
        </p>
        {label ? (
          <p
            style={{
              fontFamily: font,
              fontSize: 38,
              fontWeight: 600,
              color: "#FFFFFF",
              margin: 0,
              marginTop: 8,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
            }}
          >
            {label}
          </p>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};
