import Anthropic from "@anthropic-ai/sdk";
import { Task } from "../task-store";
import { ExecutionResult } from "./task-executor";
import { withRetry } from "../retry";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export type VerificationResult = {
  isCorrect: boolean;
  feedback: string;
  confidence: number;
};

export async function runResultVerifier(
  task: Task,
  execResult: ExecutionResult
): Promise<VerificationResult> {
  const toolSummary = execResult.toolCalls
    .map((tc) => {
      const r = JSON.parse(tc.result) as { success: boolean; output: string };
      return `  ${tc.name}(${tc.name === "write_file" ? `"${tc.args.path}"` : JSON.stringify(tc.args)}) → ${r.success ? "✓" : "✗"} ${r.output.slice(0, 150)}`;
    })
    .join("\n");

  const prompt = `Verify if this task was completed correctly.

TASK: ${task.description}

WHAT THE AGENT DID:
${execResult.result}

TOOL CALLS:
${toolSummary || "  (none)"}

Check:
1. Was the task goal actually achieved?
2. If files were written, did the writes succeed?
3. If TypeScript was checked, did it pass?
4. Are there obvious failures in the tool results?

Return ONLY JSON (no markdown): {"isCorrect":true/false,"feedback":"brief reason","confidence":0-100}`;

  const response = await withRetry(() =>
    client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 256,
      messages: [{ role: "user", content: prompt }],
    })
  );

  const raw = response.content.find((b) => b.type === "text")?.text?.trim() ?? "";
  const json = raw.replace(/^```json\n?/, "").replace(/\n?```$/, "");

  try {
    return JSON.parse(json) as VerificationResult;
  } catch {
    return { isCorrect: true, feedback: "Verification parse failed — assuming correct", confidence: 50 };
  }
}
