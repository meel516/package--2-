import OpenAI from "openai";

// Initialize the OpenAI client with Groq's base URL
const client = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

// Define tools/functions the agent can use
const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get the current weather for a location",
      parameters: {
        type: "object",
        properties: {
          location: {
            type: "string",
            description: "The city and state, e.g. San Francisco, CA",
          },
        },
        required: ["location"],
      },
    },
  },
];

// Simulated tool execution - replace with real implementations
function executeTool(name: string, args: Record<string, unknown>): string {
  if (name === "get_weather") {
    return JSON.stringify({
      temperature: 72,
      condition: "sunny",
      location: args.location,
    });
  }
  return JSON.stringify({ error: "Unknown tool" });
}

// Main agent loop
export async function runAgent(userMessage: string): Promise<string> {
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: userMessage },
  ];

  while (true) {
    const response = await client.chat.completions.create({
      model: "llama-3.3-70b-versatile", // Groq model
      messages,
      tools,
      tool_choice: "auto",
    });

    const assistantMessage = response.choices[0].message;
    messages.push(assistantMessage);

    // If no tool calls, return the final response
    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      return assistantMessage.content ?? "";
    }

    // Execute each tool call and add results to messages
    for (const toolCall of assistantMessage.tool_calls) {
      const args = JSON.parse(toolCall.function.arguments);
      const result = executeTool(toolCall.function.name, args);

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: result,
      });
    }
  }
}
