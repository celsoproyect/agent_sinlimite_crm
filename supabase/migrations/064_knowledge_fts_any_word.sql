-- 064: lexical knowledge search matches ANY meaningful word.
--
-- match_ai_knowledge_fts used plainto_tsquery, which ANDs every word of
-- the customer's message. A natural question ("hola, a que hora abren
-- los sabados?") then matched nothing, because no chunk contains "hola"
-- and "que" and "los"... at once. Without embeddings this was the only
-- search, so the agent never saw the knowledge base or the FAQs.
--
-- Now the query keeps the words of 3+ letters that aren't common Spanish
-- or English filler, ORs them, and ts_rank puts the chunks that share the
-- most words first. Same signature and result shape as migration 044.

CREATE OR REPLACE FUNCTION public.match_ai_knowledge_fts(
  p_account_id         uuid,
  p_query              text,
  p_match_count        integer,
  p_knowledge_base_id  uuid DEFAULT NULL
)
RETURNS TABLE (id uuid, content text, rank real, kb_name text, doc_title text) AS $$
  WITH q AS (
    SELECT to_tsquery('simple', string_agg(quote_literal(t.lexeme), ' | ')) AS tsq
    FROM unnest(to_tsvector('simple', coalesce(p_query, ''))) AS t
    WHERE length(t.lexeme) >= 3
      AND t.lexeme <> ALL (ARRAY[
        'que','qué','los','las','del','por','para','con','sin','una','uno','unos','unas',
        'como','cómo','cual','cuál','cuales','cuáles','cuando','cuándo','donde','dónde',
        'hay','son','está','esta','este','esto','estos','estas','eso','esa','ese',
        'sus','mis','tus','muy','más','mas','pero','también','tambien','algo','alguna','alguno',
        'hola','buenas','buenos','buen','dias','días','tardes','noches','gracias','favor',
        'quiero','quisiera','saber','puedo','pueden','puede','podría','podria',
        'tiene','tienen','tienes','tengo','usted','ustedes','les','nos',
        'the','and','you','your','what','how','are','for','with','can','does','have'
      ])
  )
  SELECT c.id,
         c.content,
         ts_rank(c.fts, q.tsq) AS rank,
         kb.name AS kb_name,
         d.title AS doc_title
  FROM q,
       ai_knowledge_chunks c
  JOIN ai_knowledge_bases kb ON kb.id = c.knowledge_base_id
  JOIN ai_knowledge_documents d ON d.id = c.document_id
  WHERE q.tsq IS NOT NULL
    AND c.account_id = p_account_id
    AND c.fts @@ q.tsq
    AND (p_knowledge_base_id IS NULL OR c.knowledge_base_id = p_knowledge_base_id)
  ORDER BY rank DESC
  LIMIT GREATEST(p_match_count, 0);
$$ LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public;

REVOKE ALL ON FUNCTION public.match_ai_knowledge_fts(uuid, text, integer, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.match_ai_knowledge_fts(uuid, text, integer, uuid) TO authenticated, service_role;
