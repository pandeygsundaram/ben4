import { z } from "zod";

export const styleConfigSchema = z.object({
  fontPreset: z.enum(["bold", "clean", "condensed", "playful"]).default("bold"),
  highlightColor: z.string().default("#FFE500"),
  captionSize: z.number().default(120),
  animationSpeed: z.enum(["fast", "medium", "slow"]).default("fast"),
  captionPosition: z.enum(["bottom", "center"]).default("bottom"),
});

export const timelineEventSchema = z.object({
  atMs: z.number(),
  durationMs: z.number(),
  type: z.enum(["hook", "quote", "stat", "cta", "chapter"]),
  text: z.string(),
});

export const captionedVideoSchema = z.object({
  src: z.string(),
  style: styleConfigSchema.optional(),
  events: z.array(timelineEventSchema).optional(),
  // voiceSrc = Rumic AI generated voiceover (full volume, video muted)
  voiceSrc: z.string().optional(),
  // musicSrc = background music track (low volume, mixed under voice/video)
  musicSrc: z.string().optional(),
  musicVolume: z.number().default(0.18),
});

export type StyleConfig = z.infer<typeof styleConfigSchema>;
export type TimelineEvent = z.infer<typeof timelineEventSchema>;
export type CaptionedVideoProps = z.infer<typeof captionedVideoSchema>;
