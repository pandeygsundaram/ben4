import path from "path";
import fs from "fs-extra";
import { execSync } from "child_process";

export type ToolResult = { success: boolean; output: string };

// Anthropic tool declarations
export const ANTHROPIC_TOOL_DECLARATIONS = [
  {
    name: "read_file",
    description: "Read the contents of a file in the Remotion project. Always read before writing.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "File path relative to project root (e.g. src/CaptionedVideo/index.tsx)" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write complete file content. Always read first, then write the full modified file.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "File path relative to project root" },
        content: { type: "string", description: "Complete file content (not a diff — the full file)" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "list_files",
    description: "List files in a directory",
    input_schema: {
      type: "object" as const,
      properties: {
        directory: { type: "string", description: "Directory relative to project root (default: src)" },
      },
    },
  },
  {
    name: "get_folder_structure",
    description: "Get tree-view of the project folder structure",
    input_schema: {
      type: "object" as const,
      properties: {
        directory: { type: "string", description: "Root directory (default: src)" },
        depth: { type: "number", description: "Max depth (default: 3)" },
      },
    },
  },
  {
    name: "execute_command",
    description: "Run TypeScript type-check. Only 'npx tsc --noEmit' is allowed.",
    input_schema: {
      type: "object" as const,
      properties: {
        command: { type: "string", description: "Must be 'npx tsc --noEmit'" },
      },
      required: ["command"],
    },
  },
];

// Legacy Gemini declarations kept for reference
export const TOOL_DECLARATIONS = [
  {
    name: "read_file",
    description: "Read the contents of a file in the Remotion project. Use this to understand existing code before editing.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path relative to the project root (e.g. src/CaptionedVideo/index.tsx)",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write full file content to a path in the Remotion project. Always read first, then write the complete modified file.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path relative to project root",
        },
        content: {
          type: "string",
          description: "Complete file content to write (not a diff — the full file)",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "list_files",
    description: "List files and directories at a path",
    parameters: {
      type: "object",
      properties: {
        directory: {
          type: "string",
          description: "Directory path relative to project root (default: src)",
        },
      },
    },
  },
  {
    name: "get_folder_structure",
    description: "Get a tree-view of the project's folder structure",
    parameters: {
      type: "object",
      properties: {
        directory: {
          type: "string",
          description: "Root directory (default: src)",
        },
        depth: {
          type: "number",
          description: "Max depth to recurse (default: 3)",
        },
      },
    },
  },
  {
    name: "execute_command",
    description: "Run a TypeScript type-check. Only 'npx tsc --noEmit' is allowed — use this to verify your changes compile.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Command to run — must be 'npx tsc --noEmit'",
        },
      },
      required: ["command"],
    },
  },
];

export function createTools(projectDir: string, log: (msg: string) => void = console.log) {
  function safeResolve(filePath: string): string {
    const resolved = path.resolve(projectDir, filePath);
    if (!resolved.startsWith(projectDir)) {
      throw new Error(`Path escape attempt: ${filePath}`);
    }
    return resolved;
  }

  async function readFile(filePath: string): Promise<ToolResult> {
    try {
      const full = safeResolve(filePath);
      if (!(await fs.pathExists(full))) {
        return { success: false, output: `File not found: ${filePath}` };
      }
      const content = await fs.readFile(full, "utf-8");
      const lines = content.split("\n");
      if (lines.length > 200) {
        return {
          success: true,
          output: `[${lines.length} lines — showing first 150]\n${lines.slice(0, 150).join("\n")}\n...[truncated, use a smaller section]`,
        };
      }
      return { success: true, output: content };
    } catch (e: any) {
      return { success: false, output: e.message };
    }
  }

  async function writeFile(filePath: string, content: string): Promise<ToolResult> {
    try {
      const full = safeResolve(filePath);
      await fs.mkdirp(path.dirname(full));
      await fs.writeFile(full, content, "utf-8");
      const lineCount = content.split("\n").length;
      return { success: true, output: `Wrote ${lineCount} lines to ${filePath}` };
    } catch (e: any) {
      return { success: false, output: e.message };
    }
  }

  async function listFiles(directory: string = "src"): Promise<ToolResult> {
    try {
      const full = safeResolve(directory);
      const items = await fs.readdir(full);
      const details = await Promise.all(
        items.map(async (item) => {
          const stat = await fs.stat(path.join(full, item));
          return stat.isDirectory() ? `📁 ${item}/` : `📄 ${item} (${stat.size}b)`;
        })
      );
      return { success: true, output: details.join("\n") };
    } catch (e: any) {
      return { success: false, output: e.message };
    }
  }

  async function getFolderStructure(directory: string = "src", depth: number = 3): Promise<ToolResult> {
    try {
      const full = safeResolve(directory);
      const SKIP = new Set(["node_modules", ".git", "dist", "build"]);

      function buildTree(dir: string, currentDepth: number, prefix: string): string {
        if (currentDepth <= 0) return "";
        const items = fs.readdirSync(dir).filter((i) => !SKIP.has(i));
        return items
          .map((item, i) => {
            const isLast = i === items.length - 1;
            const connector = isLast ? "└── " : "├── ";
            const childPrefix = isLast ? "    " : "│   ";
            const itemPath = path.join(dir, item);
            const isDir = fs.statSync(itemPath).isDirectory();
            const subtree = isDir ? "\n" + buildTree(itemPath, currentDepth - 1, prefix + childPrefix) : "";
            return `${prefix}${connector}${item}${subtree}`;
          })
          .join("\n");
      }

      const tree = buildTree(full, depth, "");
      return { success: true, output: `${directory}/\n${tree}` };
    } catch (e: any) {
      return { success: false, output: e.message };
    }
  }

  async function executeCommand(command: string): Promise<ToolResult> {
    if (command.trim() !== "npx tsc --noEmit") {
      return {
        success: false,
        output: `Only "npx tsc --noEmit" is permitted. Got: ${command}`,
      };
    }
    try {
      const output = execSync(command, {
        cwd: projectDir,
        stdio: "pipe",
        timeout: 60_000,
      }).toString();
      return { success: true, output: output || "TypeScript check passed — no errors." };
    } catch (e: any) {
      const stderr = e.stderr?.toString() || "";
      const stdout = e.stdout?.toString() || "";
      return { success: false, output: (stderr + stdout).trim() || e.message };
    }
  }

  async function executeTool(name: string, args: Record<string, any>): Promise<string> {
    let result: ToolResult;

    // Verbose per-call logging
    const argSummary = name === "write_file"
      ? `path="${args.path}" [${(args.content || "").split("\n").length} lines]`
      : JSON.stringify(args);
    log(`  [tool] ${name}(${argSummary})`);

    switch (name) {
      case "read_file":
        result = await readFile(args.path);
        break;
      case "write_file":
        result = await writeFile(args.path, args.content);
        break;
      case "list_files":
        result = await listFiles(args.directory);
        break;
      case "get_folder_structure":
        result = await getFolderStructure(args.directory, args.depth);
        break;
      case "execute_command":
        result = await executeCommand(args.command);
        break;
      default:
        result = { success: false, output: `Unknown tool: ${name}` };
    }

    log(`  [tool] ${name} → ${result.success ? "✓" : "✗"} ${result.output.slice(0, 120).replace(/\n/g, " ")}`);
    return JSON.stringify(result);
  }

  return { executeTool };
}

export type Tools = ReturnType<typeof createTools>;
