import type Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { SendToClaude } from './claude.ts';

export const anthropicSender =
  (client: Anthropic): SendToClaude =>
  async ({ model, system, prompt, schema, maxTokens, effort }) => {
    const { type, schema: jsonSchema } = zodOutputFormat(schema);
    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: prompt }],
      output_config: { effort, format: { type, schema: jsonSchema } },
    });
    const text = response.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
    return { usage: response.usage, stopReason: response.stop_reason, text };
  };
