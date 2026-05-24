import Anthropic from "@anthropic-ai/sdk";
import { Task, ToolCall } from "../task-store";
import { Tools, ANTHROPIC_TOOL_DECLARATIONS } from "../tools";
import { ExecutionResult } from "./task-executor";
import { VerificationResult } from "./result-verifier";
import { withRetry } from "../retry";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const FIXER_SYSTEM = `You are a code fix agent for a Remotion video project. A task completed but produced incorrect results. Fix it.

APPROACH:
1. Read the verification feedback to understand what went wrong
2. Re-read the affected files
3. Make targeted, minimal corrections
4. Run TypeScript check to confirm the fix works

RULES:
- Only fix what's wrong — don't refactor unrelated code
- Write complete file contents when making edits
- Confirm your fix with the TypeScript checker`;

export type FixResult = {
  success: boolean;
  result: string;
  toolCalls: ToolCall[];
};

export async function runErrorFixer(
  task: Task,
  execResult: ExecutionResult,
  verifyResult: VerificationResult,
  tools: Tools,
  attemptNumber: number = 1,
  log: (msg: string) => void = console.log
): Promise<FixResult> {
  const toolCalls: ToolCall[] = [];

  log(`  [fixer:${task.id}] fix attempt ${attemptNumber}`);

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `Fix attempt #${attemptNumber}

ORIGINAL TASK: ${task.description}

WHAT WAS DONE:
${execResult.result}

VERIFICATION FEEDBACK (what went wrong):
${verifyResult.feedback}

Fix the issue now. Read the relevant files first, then make targeted corrections.`,
    },
  ];

  let iterations = 0;
  const MAX_ITERATIONS = 10;

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    const response = await withRetry(
      () =>
        client.messages.create({
          model: "claude-sonnet-4-6",
          max_tokens: 8096,
          system: FIXER_SYSTEM,
          tools: ANTHROPIC_TOOL_DECLARATIONS,
          messages,
        }),
      log
    );

    if (response.stop_reason === "end_turn") {
      const text = response.content.find((b) => b.type === "text")?.text ?? "Fix applied";
      return { success: true, result: text, toolCalls };
    }

    if (response.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: response.content });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of response.content) {
        if (block.type === "tool_use") {
          const result = await tools.executeTool(block.name, block.input as Record<string, any>);
          toolCalls.push({ name: block.name, args: block.input as Record<string, any>, result });
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
        }
      }

      messages.push({ role: "user", content: toolResults });
    } else {
      break;
    }
  }

  return { success: false, result: `Fixer hit max iterations (${MAX_ITERATIONS})`, toolCalls };
}
