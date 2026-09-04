-- AlterTable
ALTER TABLE "chat_settings" ADD COLUMN     "notes" TEXT,
ADD COLUMN     "notesMessagesSince" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "notesUpdatedAt" TIMESTAMP(3);
