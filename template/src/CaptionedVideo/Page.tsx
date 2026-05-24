import { makeTransform, scale, translateY } from "@remotion/animation-utils";
import { TikTokPage } from "@remotion/captions";
import { fitText } from "@remotion/layout-utils";
import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { TheBoldFont } from "../load-font";
import { StyleConfig } from "../schema";

const DEFAULT_STYLE: StyleConfig = {
  fontPreset: "bold",
  highlightColor: "#39E508",
  captionSize: 120,
  animationSpeed: "fast",
  captionPosition: "bottom",
};

export const Page: React.FC<{
  readonly enterProgress: number;
  readonly page: TikTokPage;
  readonly style?: StyleConfig;
}> = ({ enterProgress, page, style = DEFAULT_STYLE }) => {
  const frame = useCurrentFrame();
  const { width, fps } = useVideoConfig();
  const timeInMs = (frame / fps) * 1000;

  const resolvedFont =
    style.fontPreset === "bold" || style.fontPreset === "condensed"
      ? TheBoldFont
      : "system-ui, -apple-system, Helvetica Neue, sans-serif";

  const isUpperCase = style.fontPreset === "bold" || style.fontPreset === "condensed";

  const fittedText = fitText({
    fontFamily: resolvedFont,
    text: page.text,
    withinWidth: width * 0.9,
    textTransform: isUpperCase ? "uppercase" : "none",
  });

  const fontSize = Math.min(style.captionSize, fittedText.fontSize);

  const containerStyle: React.CSSProperties = {
    justifyContent: "center",
    alignItems: style.captionPosition === "center" ? "center" : "flex-end",
    top: undefined,
    bottom: style.captionPosition === "center" ? undefined : 350,
    height: style.captionPosition === "center" ? undefined : 150,
  };

  return (
    <AbsoluteFill style={containerStyle}>
      <div
        style={{
          fontSize,
          color: "white",
          WebkitTextStroke: "18px black",
          paintOrder: "stroke",
          transform: makeTransform([
            scale(interpolate(enterProgress, [0, 1], [0.85, 1])),
            translateY(interpolate(enterProgress, [0, 1], [40, 0])),
          ]),
          fontFamily: resolvedFont,
          textTransform: isUpperCase ? "uppercase" : "none",
          letterSpacing: style.fontPreset === "condensed" ? "-0.02em" : "normal",
        }}
      >
        {page.tokens.map((t) => {
          const startRelativeToSequence = t.fromMs - page.startMs;
          const endRelativeToSequence = t.toMs - page.startMs;
          const active =
            startRelativeToSequence <= timeInMs && endRelativeToSequence > timeInMs;

          return (
            <span
              key={t.fromMs}
              style={{
                display: "inline",
                whiteSpace: "pre",
                color: active ? style.highlightColor : "white",
              }}
            >
              {t.text}
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
