import Anthropic from "@anthropic-ai/sdk";
import { RenderConfig } from "../engine";
import { createTools, ANTHROPIC_TOOL_DECLARATIONS } from "./tools";
import { withRetry } from "./retry";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM = `You are a code editor for a Remotion 4.x video project (React + TypeScript).

Your job: read the source files, edit them to match the render config, verify TypeScript compiles.

FILES YOU WILL EDIT:
- src/CaptionedVideo/index.tsx — main composition
- src/CaptionedVideo/Page.tsx — caption word highlight
- src/CaptionedVideo/SubtitlePage.tsx — caption spring animation
- src/cards/CardBase.tsx — useCardAnimation hook + dark container
- src/cards/HookCard.tsx, QuoteCard.tsx, StatCard.tsx, CTACard.tsx, ChapterCard.tsx

VISUAL GOALS:
- Cards: punchy spring entrance (stiffness 200+, damping <15) matching animationSpeed
- Captions: large + bold, positioned correctly (bottom = lower 40%, center = middle)
- Accent color used consistently: active caption word, card borders/fills/accents
- Cards in upper 55% of frame, captions in lower 45% — no overlap
- Dark semi-transparent card backgrounds (rgba(10,10,10,0.88))

RULES:
- Read files first, then write complete file contents (never partial)
- After all edits, run npx tsc --noEmit and fix any errors found
- Be efficient: read each file ONCE, write ONCE — no re-reading loops
- Stop when TypeScript passes cleanly`;

export async function runCodeAgent(
  jobId: string,
  projectDir: string,
  renderConfig: RenderConfig,
  renderError?: string,
  log: (msg: string) => void = console.log
): Promise<void> {
  const tag = `[agent:${jobId}]`;
  const tools = createTools(projectDir, log);

  const userMsg = renderError
    ? `Fix this render error and ensure the video works correctly.

RENDER ERROR:
${renderError}

RENDER CONFIG:
${JSON.stringify(renderConfig, null, 2)}

Steps:
1. Read all source files to understand current state
2. Fix the error
3. Run npx tsc --noEmit — fix any TypeScript errors
4. Confirm it compiles cleanly`
    : `Customize the Remotion components to match this render config.

RENDER CONFIG:
${JSON.stringify(renderConfig, null, 2)}

Steps:
1. Read all source files (index.tsx, Page.tsx, SubtitlePage.tsx, CardBase.tsx, all 5 card files)
2. Edit them to implement the style: fontPreset=${renderConfig.style.fontPreset}, highlightColor=${renderConfig.style.highlightColor}, captionSize=${renderConfig.style.captionSize}px, animationSpeed=${renderConfig.style.animationSpeed}, captionPosition=${renderConfig.style.captionPosition}
3. Make cards visually punchy and distinct — not generic divs
4. Run npx tsc --noEmit — fix any TypeScript errors found
5. Confirm clean compilation`;

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: userMsg }];

  let iterations = 0;
  const MAX = 20;

  log(`${tag} starting (${renderError ? "error-fix" : "customize"} mode)`);

  while (iterations < MAX) {
    iterations++;

    const response = await withRetry(
      () =>
        client.messages.create({
          model: "claude-sonnet-4-6",
          max_tokens: 8096,
          system: SYSTEM,
          tools: ANTHROPIC_TOOL_DECLARATIONS,
          messages,
        }),
      log
    );

    if (response.stop_reason === "end_turn") {
      const summary = response.content.find((b) => b.type === "text")?.text ?? "";
      log(`${tag} done in ${iterations} iterations`);
      if (summary) log(`${tag} ${summary.slice(0, 200)}`);
      return;
    }

    if (response.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: response.content });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of response.content) {
        if (block.type === "tool_use") {
          const argSummary =
            block.name === "write_file"
              ? `path="${(block.input as any).path}" [${((block.input as any).content ?? "").split("\n").length} lines]`
              : JSON.stringify(block.input).slice(0, 80);

          log(`  [tool] ${block.name}(${argSummary})`);
          const result = await tools.executeTool(block.name, block.input as Record<string, any>);
          const parsed = JSON.parse(result) as { success: boolean; output: string };
          log(`  [tool] → ${parsed.success ? "✓" : "✗"} ${parsed.output.slice(0, 100).replace(/\n/g, " ")}`);

          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
        }
      }

      messages.push({ role: "user", content: toolResults });
    } else {
      break;
    }
  }

  log(`${tag} hit max iterations (${MAX})`);
}
