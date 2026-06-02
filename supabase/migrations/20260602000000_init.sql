-- 1. Create chat_sessions table
CREATE TABLE IF NOT EXISTS chat_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- 2. Create chat_messages table
CREATE TABLE IF NOT EXISTS chat_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID REFERENCES chat_sessions(id) ON DELETE CASCADE NOT NULL,
    sender TEXT NOT NULL CHECK (sender IN ('user', 'ai')),
    text TEXT NOT NULL,
    sentiment_label TEXT,
    sentiment_percentage INTEGER,
    reference_reviews JSONB,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- 3. Enable RLS on tables
ALTER TABLE chat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;

-- 4. Create security policies for anonymous access
-- Because the client requested unauthenticated access, we grant full CRUD capabilities to the public/anon role.

-- Policies for chat_sessions
CREATE POLICY "Allow anonymous select on chat_sessions"
ON chat_sessions FOR SELECT
TO anon
USING (true);

CREATE POLICY "Allow anonymous insert on chat_sessions"
ON chat_sessions FOR INSERT
TO anon
WITH CHECK (true);

CREATE POLICY "Allow anonymous update on chat_sessions"
ON chat_sessions FOR UPDATE
TO anon
USING (true)
WITH CHECK (true);

CREATE POLICY "Allow anonymous delete on chat_sessions"
ON chat_sessions FOR DELETE
TO anon
USING (true);

-- Policies for chat_messages
CREATE POLICY "Allow anonymous select on chat_messages"
ON chat_messages FOR SELECT
TO anon
USING (true);

CREATE POLICY "Allow anonymous insert on chat_messages"
ON chat_messages FOR INSERT
TO anon
WITH CHECK (true);

CREATE POLICY "Allow anonymous update on chat_messages"
ON chat_messages FOR UPDATE
TO anon
USING (true)
WITH CHECK (true);

CREATE POLICY "Allow anonymous delete on chat_messages"
ON chat_messages FOR DELETE
TO anon
USING (true);

