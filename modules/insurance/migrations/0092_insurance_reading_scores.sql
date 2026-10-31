CREATE TABLE IF NOT EXISTS insurance_reading_scores (
  article_id text NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  input_hash text NOT NULL,
  prompt_version text NOT NULL,
  model text NOT NULL,
  model_key text NOT NULL,
  title text NOT NULL,
  summary text NOT NULL,
  category text NOT NULL,
  score integer NOT NULL CHECK (score BETWEEN 0 AND 100),
  passes jsonb NOT NULL,
  receipt_ids bigint[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (article_id, input_hash, prompt_version, model)
);
