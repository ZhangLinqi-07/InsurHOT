CREATE TABLE IF NOT EXISTS insurance_news_workflow (
  article_id text PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
  input_revision integer NOT NULL,
  stage text NOT NULL DEFAULT 'screen',
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  error_kind text,
  error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
