CREATE TABLE IF NOT EXISTS preview_translations (
  article_id text NOT NULL REFERENCES articles(id),
  revision integer NOT NULL,
  input_hash text NOT NULL,
  original_title text NOT NULL,
  original_excerpt text,
  title_zh text NOT NULL,
  excerpt_zh text,
  model text NOT NULL,
  prompt_version text NOT NULL,
  receipt_id bigint REFERENCES receipts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (article_id, revision)
);
