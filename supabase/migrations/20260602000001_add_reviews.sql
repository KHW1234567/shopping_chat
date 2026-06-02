-- 1. Create reviews table for storing raw review data
CREATE TABLE IF NOT EXISTS reviews (
    id TEXT PRIMARY KEY,
    rating INTEGER NOT NULL,
    title TEXT,
    content TEXT NOT NULL,
    author TEXT,
    date TEXT,
    helpful_votes INTEGER DEFAULT 0,
    verified_purchase BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- 2. Enable RLS on reviews table
ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;

-- 3. Create security policies for anonymous access to reviews table
CREATE POLICY "Allow anonymous select on reviews"
ON reviews FOR SELECT
TO anon
USING (true);

CREATE POLICY "Allow anonymous insert on reviews"
ON reviews FOR INSERT
TO anon
WITH CHECK (true);

CREATE POLICY "Allow anonymous update on reviews"
ON reviews FOR UPDATE
TO anon
USING (true)
WITH CHECK (true);

CREATE POLICY "Allow anonymous delete on reviews"
ON reviews FOR DELETE
TO anon
USING (true);
