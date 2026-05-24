import Anthropic from "@anthropic-ai/sdk";
import { Task, ToolCall } from "../task-store";
import { Tools, ANTHROPIC_TOOL_DECLARATIONS } from "../tools";
import { withRetry } from "../retry";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const EXECUTOR_SYSTEM = `You are a code editing agent for a Remotion video project. Complete tasks by reading and editing TypeScript/React source files.

RULES:
- Always read a file before writing it — never overwrite blindly
- Write COMPLETE file contents (not diffs or partial edits)
- The project uses Remotion 4.x, React 18, TypeScript
- Style/color/size values come from props — do NOT hardcode dynamic values
- After editing files, run TypeScript check to confirm no errors
- Only edit files in the project — never outside it

REMOTION SPECIFICS:
- useCurrentFrame(), useVideoConfig() for frame/fps access
- interpolate(), spring() for animations
- AbsoluteFill for full-screen layers
- Sequence for time-based rendering
- staticFile() resolves public/ assets — but files are already passed as props (src="/public/reel.mp4")

When done with the task, briefly summarize what you changed and why.`;

export type ExecutionResult = {
  success: boolean;
  result: string;
  toolCalls: ToolCall[];
};

export async function runTaskExecutor(
  task: Task,
  tools: Tools,
  context?: string,
  log: (msg: string) => void = console.log
): Promise<ExecutionResult> {
  const toolCalls: ToolCall[] = [];

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: context
        ? `Task: ${task.description}\n\nContext:\n${context}\n\nComplete this task now.`
        : `Task: ${task.description}\n\nComplete this task now.`,
    },
  ];

  let iterations = 0;
  const MAX_ITERATIONS = 12;

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    log(`  [exec:${task.id}] iteration ${iterations}`);

    const response = await withRetry(
      () =>
        client.messages.create({
          model: "claude-sonnet-4-6",
          max_tokens: 8096,
          system: EXECUTOR_SYSTEM,
          tools: ANTHROPIC_TOOL_DECLARATIONS,
          messages,
        }),
      log
    );

    if (response.stop_reason === "end_turn") {
      const text = response.content.find((b) => b.type === "text")?.text ?? "Task completed";
      return { success: true, result: text, toolCalls };
    }

    if (response.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: response.content });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of response.content) {
        if (block.type === "tool_use") {
          const argSummary =
            block.name === "write_file"
              ? `path="${(block.input as any).path}" [${((block.input as any).content ?? "").split("\n").length} lines]`
              : JSON.stringify(block.input);
          log(`  [tool] ${block.name}(${argSummary})`);

          const result = await tools.executeTool(block.name, block.input as Record<string, any>);
          const parsed = JSON.parse(result) as { success: boolean; output: string };
          log(`  [tool] → ${parsed.success ? "✓" : "✗"} ${parsed.output.slice(0, 100).replace(/\n/g, " ")}`);

          toolCalls.push({ name: block.name, args: block.input as Record<string, any>, result });
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
        }
      }

      messages.push({ role: "user", content: toolResults });
    } else {
      break;
    }
  }

  return { success: false, result: `Hit max iterations (${MAX_ITERATIONS})`, toolCalls };
}
