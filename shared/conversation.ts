import { z } from "zod";
import { profileIdSchema } from "./profile";
import { conversationIdSchema, taskIdSchema, taskSchema } from "./task";

export const MAX_CONVERSATION_MESSAGES = 2_000;

export const messageIdSchema = z.string().regex(/^m_[0-9a-f]{16}$/);

export const conversationTitleSchema = z.string().min(1).max(80);

export const conversationSchema = z.strictObject({
  id: conversationIdSchema,
  profileId: profileIdSchema,
  title: conversationTitleSchema.nullable(),
  createdAt: z.iso.datetime({ offset: false }),
  updatedAt: z.iso.datetime({ offset: false }),
});

export type Conversation = z.infer<typeof conversationSchema>;

export const messageRoleSchema = z.enum(["operator", "agent"]);

export type MessageRole = z.infer<typeof messageRoleSchema>;

export const messageSchema = z.strictObject({
  id: messageIdSchema,
  conversationId: conversationIdSchema,
  role: messageRoleSchema,
  text: z.string().min(1).max(4_000),
  taskId: taskIdSchema.nullable(),
  createdAt: z.iso.datetime({ offset: false }),
});

export type Message = z.infer<typeof messageSchema>;

export const createConversationRequestSchema = z.strictObject({
  title: conversationTitleSchema.optional(),
});

export type CreateConversationRequest = z.infer<typeof createConversationRequestSchema>;

export const sendConversationMessageRequestSchema = z.strictObject({
  text: z.string().min(1).max(2_000),
});

export type SendConversationMessageRequest = z.infer<
  typeof sendConversationMessageRequestSchema
>;

export const conversationResponseSchema = z.strictObject({
  data: conversationSchema,
});

export type ConversationResponse = z.infer<typeof conversationResponseSchema>;

export const conversationListResponseSchema = z.strictObject({
  data: z.array(conversationSchema),
  total: z.int().min(0),
  page: z.int().min(1),
  page_size: z.int().min(1).max(100),
});

export type ConversationListResponse = z.infer<typeof conversationListResponseSchema>;

export const messageListResponseSchema = z.strictObject({
  data: z.array(messageSchema),
  total: z.int().min(0),
  page: z.int().min(1),
  page_size: z.int().min(1).max(100),
});

export type MessageListResponse = z.infer<typeof messageListResponseSchema>;

export const sendConversationMessageResponseSchema = z.strictObject({
  data: z.strictObject({
    conversation: conversationSchema,
    message: messageSchema,
    task: taskSchema,
  }),
});

export type SendConversationMessageResponse = z.infer<
  typeof sendConversationMessageResponseSchema
>;

export const conversationErrorCodeSchema = z.enum([
  "conversation_not_found",
  "conversation_profile_not_found",
  "conversation_session_not_ready",
  "conversation_idempotency_conflict",
  "conversation_full",
  "conversation_save_failed",
]);

export type ConversationErrorCode = z.infer<typeof conversationErrorCodeSchema>;
