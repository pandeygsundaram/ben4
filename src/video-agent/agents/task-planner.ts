import Anthropic from "@anthropic-ai/sdk";
import { RenderConfig } from "../../engine";
import { Task } from "../task-store";
import { withRetry } from "../retry";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PLANNER_SYSTEM = `You are a task planning agent for an AI video editor built on Remotion (React-based video framework).

Break down a video customization request into a dependency graph of discrete coding tasks that make the video VISUALLY STUNNING.

PROJECT STRUCTURE:
- src/CaptionedVideo/index.tsx — main composition: video + captions + cards + audio
- src/CaptionedVideo/Page.tsx — caption text with word-level karaoke highlight
- src/CaptionedVideo/SubtitlePage.tsx — spring animation wrapper per caption page
- src/cards/CardBase.tsx — shared useCardAnimation hook + dark container + font resolver
- src/cards/HookCard.tsx — opening grab card (large text, last word in accent color)
- src/cards/QuoteCard.tsx — pull quote with left accent border
- src/cards/StatCard.tsx — big number + label
- src/cards/CTACard.tsx — end card with filled accent background
- src/cards/ChapterCard.tsx — subtle section label

VISUAL QUALITY GOALS:
1. Cards have punchy spring animations (high stiffness, low damping) matching animationSpeed
2. Captions are large, bold, readable — correct position (bottom/center), no overflow
3. Each card type has distinct polished styling — not just a div with text
4. Accent/highlight color flows consistently: caption highlights, card accents, borders, fills
5. Cards never overlap captions — positioned in upper half, captions in lower half
6. All TypeScript compiles without errors

RULES:
- Task 1: read ALL source files in one task (no deps)
- Split writes by file/concern so they can run in parallel (all depend on task 1)
- Last task: verify TypeScript (depends on all write tasks)
- Max 7 tasks
- Return ONLY valid JSON, no markdown, no explanation

Format:
{"tasks":[{"id":"task-1","description":"...","dependencies":[]},{"id":"task-2","description":"...","dependencies":["task-1"]}]}`;

export async function runTaskPlanner(
  renderConfig: RenderConfig,
  renderError?: string
): Promise<Omit<Task, "status" | "attempts">[]> {
  const userPrompt = renderError
    ? `RENDER ERROR TO FIX:\n${renderError}\n\nRENDER CONFIG:\n${JSON.stringify(renderConfig, null, 2)}\n\nPlan tasks to read the relevant files, understand the error, and fix it. End with TypeScript check.`
    : `RENDER CONFIG:\n${JSON.stringify(renderConfig, null, 2)}\n\nPlan tasks to customize the Remotion source code for this video. Focus on visual quality: animations, card layouts, caption styling for videoType="${renderConfig.videoType}", animationSpeed="${renderConfig.style.animationSpeed}", highlightColor="${renderConfig.style.highlightColor}".`;

  const response = await withRetry(() =>
    client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      system: PLANNER_SYSTEM,
      messages: [{ role: "user", content: userPrompt }],
    })
  );

  const raw = response.content.find((b) => b.type === "text")?.text?.trim() ?? "";
  const json = raw.replace(/^```json\n?/, "").replace(/\n?```$/, "");

  try {
    const parsed: { tasks: { id: string; description: string; dependencies: string[] }[] } = JSON.parse(json);
    return parsed.tasks;
  } catch {
    console.warn("[task-planner] parse failed — using fallback tasks");
    return [
      { id: "task-1", description: "Read all source files: index.tsx, Page.tsx, SubtitlePage.tsx, CardBase.tsx and all cards", dependencies: [] },
      {
        id: "task-2",
        description: renderError
          ? `Fix render error: ${renderError.slice(0, 200)}`
          : `Update caption styling and card animations for videoType=${renderConfig.videoType}, animationSpeed=${renderConfig.style.animationSpeed}, highlightColor=${renderConfig.style.highlightColor}`,
        dependencies: ["task-1"],
      },
      { id: "task-3", description: "Verify TypeScript compiles: npx tsc --noEmit", dependencies: ["task-2"] },
    ];
  }
}
