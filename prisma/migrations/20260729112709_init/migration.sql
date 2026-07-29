-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateTable
CREATE TABLE "messages" (
    "id" SERIAL NOT NULL,
    "chatId" TEXT NOT NULL,
    "sender" TEXT NOT NULL,
    "senderName" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "messageType" TEXT NOT NULL DEFAULT 'text',
    "mediaUrl" TEXT,
    "timestamp" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "displayName" TEXT,
    "pushName" TEXT,
    "lastSeen" BIGINT NOT NULL,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "firstSeen" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" SERIAL NOT NULL,
    "chatId" TEXT NOT NULL,
    "chatName" TEXT,
    "isGroup" BOOLEAN NOT NULL DEFAULT false,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "lastMessageAt" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analytics" (
    "id" SERIAL NOT NULL,
    "date" TEXT NOT NULL,
    "totalMessages" INTEGER NOT NULL DEFAULT 0,
    "totalUsers" INTEGER NOT NULL DEFAULT 0,
    "totalConversations" INTEGER NOT NULL DEFAULT 0,
    "apiCalls" INTEGER NOT NULL DEFAULT 0,
    "tokensUsed" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_list" (
    "id" SERIAL NOT NULL,
    "identifier" TEXT NOT NULL,
    "list" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT,
    "reason" TEXT,
    "addedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "access_list_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_chunks" (
    "id" SERIAL NOT NULL,
    "chatId" TEXT NOT NULL,
    "chatName" TEXT,
    "isGroup" BOOLEAN NOT NULL DEFAULT false,
    "text" TEXT NOT NULL,
    "startTimestamp" BIGINT NOT NULL,
    "endTimestamp" BIGINT NOT NULL,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "model" TEXT NOT NULL,
    "dim" INTEGER NOT NULL,
    "vector" vector(1536),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_state" (
    "chatId" TEXT NOT NULL,
    "lastIndexedTimestamp" BIGINT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_state_pkey" PRIMARY KEY ("chatId")
);

-- CreateTable
CREATE TABLE "chat_settings" (
    "chatId" TEXT NOT NULL,
    "persona" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_settings_pkey" PRIMARY KEY ("chatId")
);

-- CreateIndex
CREATE INDEX "messages_chatId_idx" ON "messages"("chatId");

-- CreateIndex
CREATE INDEX "messages_sender_idx" ON "messages"("sender");

-- CreateIndex
CREATE INDEX "messages_timestamp_idx" ON "messages"("timestamp");

-- CreateIndex
CREATE INDEX "messages_chatId_timestamp_idx" ON "messages"("chatId", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "users_phoneNumber_key" ON "users"("phoneNumber");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_chatId_key" ON "conversations"("chatId");

-- CreateIndex
CREATE UNIQUE INDEX "analytics_date_key" ON "analytics"("date");

-- CreateIndex
CREATE INDEX "analytics_date_idx" ON "analytics"("date");

-- CreateIndex
CREATE INDEX "access_list_identifier_idx" ON "access_list"("identifier");

-- CreateIndex
CREATE UNIQUE INDEX "access_list_list_identifier_key" ON "access_list"("list", "identifier");

-- CreateIndex
CREATE INDEX "knowledge_chunks_chatId_idx" ON "knowledge_chunks"("chatId");

-- CreateIndex
CREATE INDEX "knowledge_chunks_model_idx" ON "knowledge_chunks"("model");
