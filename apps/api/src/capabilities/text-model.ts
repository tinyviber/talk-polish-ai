export type TextModelMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type TextModelRequest = {
  messages: TextModelMessage[];
  temperature?: number;
  responseFormat?: "text" | "json";
  maxTokens?: number;
  requestId?: string;
};

export type TextModelResponse = {
  content: string;
  provider: string;
  model?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
};

/** Provider-neutral text generation port. No product prompts or feedback types. */
export interface TextModel {
  readonly name: string;
  generate(input: TextModelRequest): Promise<TextModelResponse>;
  check?(): Promise<void>;
  probe?(): Promise<void>;
}
