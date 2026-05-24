import { v4 as uuidv4 } from "uuid";

export type VideoType = "founder" | "educational" | "emotional" | "comedy";

// Context Gemini collects from the conversation before generating
export type VideoContext = {
  videoType?: VideoType;
  coreMesage?: string;
  targetAudience?: string;
  energyLevel?: "low" | "medium" | "high";
  musicPreference?: string; // "upbeat", "ambient", "dramatic", "none"
  additionalNotes?: string;
};

export type ChatMessage = {
  role: "user" | "model";
  text: string;
};

export type Session = {
  id: string;
  history: ChatMessage[];
  context: VideoContext;
  ready: boolean; // true when Gemini has enough to generate
  createdAt: number;
};

const sessions = new Map<string, Session>();

export function createSession(): Session {
  const session: Session = {
    id: uuidv4(),
    history: [],
    context: {},
    ready: false,
    createdAt: Date.now(),
  };
  sessions.set(session.id, session);
  return session;
}

export function getSession(id: string): Session | undefined {
  return sessions.get(id);
}

export function updateSession(id: string, patch: Partial<Session>): void {
  const s = sessions.get(id);
  if (s) sessions.set(id, { ...s, ...patch });
}

export function appendMessage(id: string, message: ChatMessage): void {
  const s = sessions.get(id);
  if (s) s.history.push(message);
}
