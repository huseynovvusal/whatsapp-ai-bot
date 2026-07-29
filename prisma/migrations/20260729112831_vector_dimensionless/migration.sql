-- Drop the fixed dimension from the embedding column.
--
-- Providers differ: OpenAI text-embedding-3-small is 1536-dim, Gemini
-- text-embedding-004 is 768-dim. A fixed size would make the schema reject
-- whichever provider was not chosen when the migration ran. Prisma does not
-- diff `Unsupported` column types, so this is written by hand.
ALTER TABLE "knowledge_chunks" ALTER COLUMN "vector" TYPE vector USING "vector"::vector;
