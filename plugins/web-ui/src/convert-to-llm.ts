import type {
  AgentMessage,
  Attachment,
  ImageContent,
  Message,
  TextContent,
  UserMessageWithAttachments,
} from "./model-types.ts";

/**
 * Flatten the transcript the UI holds into the messages a turn is sent with.
 *
 * The composer stores a staged user turn as `role: "user-with-attachments"` so it can render the
 * file chips; the wire form is a plain user message whose content blocks carry the files. Images
 * go through as image blocks, documents as their extracted text under a filename header — a
 * document with no extracted text contributes nothing, because its raw bytes would be noise.
 */
function attachmentContent(attachments: readonly Attachment[]): (TextContent | ImageContent)[] {
  const content: (TextContent | ImageContent)[] = [];
  for (const attachment of attachments) {
    if (attachment.type === "image") {
      content.push({ type: "image", data: attachment.content, mimeType: attachment.mimeType });
    } else if (attachment.extractedText) {
      content.push({ type: "text", text: `\n\n[Document: ${attachment.fileName}]\n${attachment.extractedText}` });
    }
  }
  return content;
}

function isUserWithAttachments(message: AgentMessage): message is UserMessageWithAttachments {
  return message.role === "user-with-attachments";
}

export function defaultConvertToLlm(messages: readonly AgentMessage[]): Message[] {
  const out: Message[] = [];
  for (const message of messages) {
    if (isUserWithAttachments(message)) {
      const content: (TextContent | ImageContent)[] =
        typeof message.content === "string" ? [{ type: "text", text: message.content }] : [...message.content];
      content.push(...attachmentContent(message.attachments ?? []));
      out.push({ role: "user", content, timestamp: message.timestamp });
      continue;
    }
    // Anything else the UI keeps for its own rendering is not part of the turn.
    if (message.role === "user" || message.role === "assistant" || message.role === "toolResult") out.push(message);
  }
  return out;
}
