export interface LLMProvider {
  askLLM(
    userText: string,
    context: string,
    systemPrompt: string,
    options?: { maxTokens?: number }
  ): Promise<{ answer: string; tokensUsed: number }>;

  askForReactiveReply(
    userText: string,
    context: string,
    systemPrompt: string
  ): Promise<{
    shouldReply: boolean;
    reply?: string;
    reaction?: string;
    replyTo?: number;
    tokensUsed: number;
  }>;

  ask(
    userText: string,
    options?: { maxTokens?: number }
  ): Promise<{ answer: string; tokensUsed: number }>;

  transcribeAudio(
    audioBuffer: Buffer,
    mimeType?: string
  ): Promise<{ text: string; tokensUsed: number }>;

  analyzeImage(
    imageBuffer: Buffer,
    prompt: string,
    mimeType?: string
  ): Promise<{ answer: string; tokensUsed: number }>;
}

export interface EmbeddingProvider {
  embedBatch(texts: string[]): Promise<number[][]>;
  getModelId(): string;
}
